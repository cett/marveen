#!/usr/bin/env node
// Moves one or more src/db modules onto the async db facade (`dbx`) and follows the change through the callers.
//
//   node tools/codemod/codemod.mjs [--dry-run] [--root <repo>] [--report <file.json>] src/db/<module>.ts ...
//
// What it rewrites (the supported shapes only):
//   db.prepare(sql).get|all|run(...)  ->  await dbx.get|all|run(sql, ...)      (tx.* inside a transaction body)
//   db.exec(sql)                      ->  await dbx.exec(sql)
//   db.transaction(() => {...})()     ->  await dbx.tx(async (tx) => {...})    (.immediate() -> { mode: 'immediate' })
//   the owning function becomes async (and `: T` becomes `: Promise<T>`), its callers (resolved by the type checker, not by
//   name) get `await`, and `async` climbs to the first function that is already asynchronous.
//
// What it does NOT rewrite, only reports (the manual checklist of the wave):
//   a callback argument that expects a synchronous value (map/sort/forEach/some, timers, event handlers), module level,
//   constructors, getters, setters, class fields, a function used as a value (mock, callback, re-export), a call from the
//   boot-synchronous chain (src/db/index.ts), a prepared statement kept in a variable, .iterate/.pluck/.raw/.pragma,
//   a transaction that is not invoked on the spot, vi.mock of a converted module, a test file that still needs useTestDb.
//
// Properties: edits are plain text edits on the original positions, so every untouched byte stays as it was (no formatter);
// the run is idempotent (a second run finds no `db.prepare` left and changes nothing); --dry-run writes nothing.

import { Project, SyntaxKind, Node } from 'ts-morph'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const dryRun = flag('--dry-run')
// --tests: the targets are TEST files. The raw handle is recognised as `db` imported from db.js / db/index.js / db/connection.js,
// as getDb(), and as a local alias `const x = getDb()`. The callbacks of it/test/beforeEach/afterEach/beforeAll/afterAll may become
// async (describe may not), db.transaction is never rewritten (it is reported: the transaction shape is a manual decision),
// and the facade import is merged into the db.js import of the file.
const testsMode = flag('--tests')
const root = path.resolve(opt('--root', process.cwd()))
const reportPath = opt('--report', null)
const bootFiles = (opt('--boot-files', 'src/db/index.ts')).split(',').map((f) => path.resolve(root, f))
const skipValues = new Set(['--root', '--report', '--boot-files'])
const targets = args.filter((a, i) => !a.startsWith('--') && !skipValues.has(args[i - 1])).map((f) => path.resolve(root, f))
if (targets.length === 0) { console.error('usage: codemod.mjs [--dry-run] [--root dir] [--report file] <module.ts>...'); process.exit(2) }

const project = new Project({ tsConfigFilePath: path.join(root, 'tsconfig.json') })
const facadeFile = path.join(root, 'src/db/facade.ts')

// ---- bookkeeping ----------------------------------------------------------------------------------------------
const edits = new Map() // file -> [{ start, end, text, order }]
let order = 0
function edit(file, start, end, text) {
  const list = edits.get(file) ?? []
  const dup = list.find((e) => e.start === start && e.end === end && e.text === text)
  if (dup) return
  list.push({ start, end, text, order: order++ })
  edits.set(file, list)
}
const manual = []
const note = (kind, node, detail = '') => {
  const sf = node.getSourceFile()
  const line = node.getStartLineNumber()
  const key = `${kind}|${sf.getFilePath()}|${line}|${detail}`
  if (manual.some((m) => m.key === key)) return
  manual.push({ key, kind, file: path.relative(root, sf.getFilePath()), line, detail: detail || node.getText().split('\n')[0].slice(0, 100) })
}
const converted = new Map() // function node -> reason
const convertedModules = new Set()
const awaited = new Set()
let awaitCount = 0

const isFn = (n) => Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n)
const isSpecialFn = (n) => Node.isConstructorDeclaration(n) || Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n)
const nearestFn = (n) => n.getAncestors().find((a) => isFn(a) || isSpecialFn(a))
const isAsyncFn = (f) => Node.isAsyncable(f) && f.isAsync()

// ---- db handle recognition -----------------------------------------------------------------------------------
const DB_MODULE = testsMode ? /(^|\/)db(\/connection|\/index)?\.js$/ : /connection\.js$/
const isGetDbCall = (n) => Node.isCallExpression(n) && n.getArguments().length === 0 && n.getExpression().getText() === 'getDb'
const isGetDbAlias = (decl) => !!decl && Node.isVariableDeclaration(decl) && !!decl.getInitializer() && isGetDbCall(decl.getInitializer())
function isDbIdentifier(n) {
  if (!Node.isIdentifier(n)) return false
  const decl = n.getSymbol()?.getDeclarations()?.[0]
  if (testsMode && isGetDbAlias(decl)) return true
  if (n.getText() !== 'db') return false
  return !!decl && Node.isImportSpecifier(decl) && DB_MODULE.test(decl.getImportDeclaration().getModuleSpecifierValue())
}
const isDbReceiver = (r) => isDbIdentifier(r) || (testsMode && isGetDbCall(r))
const callOnDb = (call, method) => {
  const e = call.getExpression()
  return Node.isPropertyAccessExpression(e) && isDbReceiver(e.getExpression()) && e.getName() === method
}

// ---- analysis of one target module ------------------------------------------------------------------------------
function needsParens(e) {
  const p = e.getParent()
  if (!p || Node.isParenthesizedExpression(p)) return false
  if ((Node.isPropertyAccessExpression(p) || Node.isElementAccessExpression(p)) && p.getExpression() === e) return true
  if (Node.isNonNullExpression(p) || Node.isTaggedTemplateExpression(p)) return true
  if (Node.isCallExpression(p) && p.getExpression() === e) return true
  return false
}

// `return f()` of a Promise needs no await, except inside try/catch/finally (there the await decides who catches).
const inTry = (n) => { for (const a of n.getAncestors()) { if (isFn(a) || isSpecialFn(a)) return false; if (Node.isTryStatement(a)) return true } return false }
const plainReturn = (e) => { const p = e.getParent(); return !!p && (Node.isReturnStatement(p) || (Node.isArrowFunction(p) && p.getBody() === e)) && !inTry(e) }

// A parenthesised `await` at the start of a statement needs a leading `;` in the repo's no-semicolon style.
const openParen = (e) => { const st = e.getFirstAncestorByKind(SyntaxKind.ExpressionStatement); return st && st.getStart() === e.getStart() ? ';(' : '(' }

function txScopeOf(node) {
  // the callback of a db.transaction(...) that is invoked on the spot, if `node` sits in one
  for (const a of node.getAncestors()) {
    if (isFn(a) && Node.isCallExpression(a.getParent()) && callOnDb(a.getParent(), 'transaction')) return a
  }
  return null
}

const blocked = new Map() // owner fn -> reason
function block(owner, why, node) {
  if (owner) blocked.set(owner, why)
  note(why, node)
}

// ---- tests mode: the imports and the alias declarations ---------------------------------------------------------
const insideAny = (id, nodes) => { for (const r of nodes) if (r.getSourceFile() === id.getSourceFile() && r.getStart() <= id.getStart() && id.getEnd() <= r.getEnd()) return true; return false }
function lineRange(sf, node) {
  const text = sf.getFullText()
  let st = node.getStart()
  while (st > 0 && (text[st - 1] === ' ' || text[st - 1] === '\t')) st -= 1
  let en = node.getEnd()
  if (text[en] === '\n') en += 1
  return [st, en]
}
function fixTestImports(sf, file, rewritten) {
  const all = sf.getDescendantsOfKind(SyntaxKind.Identifier)
  // 1. an alias `const x = getDb()` that nothing reads any more goes away (its getDb() call too)
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (!isGetDbAlias(decl) || !Node.isIdentifier(decl.getNameNode())) continue
    const nameNode = decl.getNameNode()
    const rest = all.filter((i) => i !== nameNode && i.getSymbol()?.getDeclarations()?.[0] === decl && !insideAny(i, rewritten))
    if (rest.length > 0) continue
    const stmt = decl.getVariableStatement()
    if (!stmt || stmt.getDeclarations().length !== 1) continue
    const [st, en] = lineRange(sf, stmt)
    edit(file, st, en, '')
    rewritten.add(decl.getInitializer())
  }
  // 2. db / getDb specifiers that nothing reads any more are dropped, dbx joins the db.js import
  const decls = sf.getImportDeclarations()
  const hasDbx = decls.some((d) => d.getNamedImports().some((n) => n.getName() === 'dbx'))
  const dbSpecs = []
  for (const d of decls) {
    if (!DB_MODULE.test(d.getModuleSpecifierValue())) continue
    for (const n of d.getNamedImports()) if (['db', 'getDb'].includes(n.getName())) dbSpecs.push(n)
  }
  const removed = new Set()
  for (const n of dbSpecs) {
    const rest = all.filter((i) => i.getSymbol()?.getDeclarations()?.[0] === n && !Node.isImportSpecifier(i.getParent()) && !insideAny(i, rewritten))
    if (rest.length === 0) removed.add(n)
  }
  const isDbJs = (d) => /(^|\/)db\.js$/.test(d.getModuleSpecifierValue()) && d.getNamedImports().length > 0 && !d.isTypeOnly()
  const host = hasDbx ? null : decls.find(isDbJs) ?? null
  const touched = new Set([...removed].map((n) => n.getImportDeclaration()))
  if (host) touched.add(host)
  for (const d of touched) {
    const named = d.getNamedImports()
    const kept = named.filter((n) => !removed.has(n)).map((n) => n.getText())
    if (d === host) kept.push('dbx')
    if (kept.length === 0 && !d.getDefaultImport() && !d.getNamespaceImport()) {
      const [st, en] = lineRange(sf, d)
      edit(file, st, en, '')
    } else {
      edit(file, named[0].getStart(), named[named.length - 1].getEnd(), kept.join(', '))
    }
  }
  if (!hasDbx && !host) {
    const relFacade = path.relative(path.dirname(file), facadeFile).replace(/\\/g, '/').replace(/\.ts$/, '.js')
    const spec = relFacade.startsWith('.') ? relFacade : `./${relFacade}`
    const anchor = decls[decls.length - 1]
    edit(file, anchor.getEnd(), anchor.getEnd(), `\nimport { dbx } from '${spec}'`)
  }
}

function convertTarget(sf) {
  const file = sf.getFilePath()
  const chains = [] // { call, method, prepareArg, owner, tx }
  const txs = [] // { outer, fn, mode, owner }
  const handled = new Set()

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const e = call.getExpression()
    if (!Node.isPropertyAccessExpression(e)) continue
    const name = e.getName()
    const inner = e.getExpression()
    // db.prepare(sql).get|all|run(...)
    if (['get', 'all', 'run'].includes(name) && Node.isCallExpression(inner) && callOnDb(inner, 'prepare')) {
      const owner = nearestFn(call)
      handled.add(inner.getExpression().getExpression())
      if (!owner) { note('module-level-db', call); continue }
      chains.push({ call, method: name, prepareArg: inner.getArguments()[0], owner })
      continue
    }
    if (callOnDb(call, 'exec')) {
      const owner = nearestFn(call)
      handled.add(e.getExpression())
      if (!owner) { note('module-level-db', call); continue }
      chains.push({ call, method: 'exec', prepareArg: null, owner })
      continue
    }
    // db.transaction(fn)(...)  /  db.transaction(fn).immediate(...)
    if (!testsMode && Node.isCallExpression(inner) && callOnDb(inner, 'transaction') && ['immediate', 'deferred', 'exclusive'].includes(name)) {
      handled.add(inner.getExpression().getExpression())
      txs.push({ outer: call, tx: inner, mode: name })
      continue
    }
  }
  for (const call of testsMode ? [] : sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const inner = call.getExpression()
    if (Node.isCallExpression(inner) && callOnDb(inner, 'transaction')) {
      handled.add(inner.getExpression().getExpression())
      txs.push({ outer: call, tx: inner, mode: null })
    }
  }
  // every other use of the raw handle blocks its function (a stored statement, .pragma, iterate, a stored transaction ...)
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (handled.has(id)) continue
    if (testsMode && id.getText() === 'db' && !isDbIdentifier(id) && !Node.isImportSpecifier(id.getParent())) {
      const d = id.getSymbol()?.getDeclarations()?.[0]
      // a `db` that is a variable of this file but not an alias of getDb(): not recognised, so it is reported, not silently left
      if (d && Node.isVariableDeclaration(d)) { note('other-db-variable', id.getParent() ?? id); continue }
    }
    if (!isDbIdentifier(id)) continue
    const par = id.getParent()
    if (Node.isImportSpecifier(par)) continue
    if (testsMode && Node.isVariableDeclaration(par) && par.getNameNode() === id) continue // the alias declaration itself
    block(nearestFn(id), 'unsupported-db-use', par ?? id)
  }
  if (testsMode) {
    for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!isGetDbCall(c) || handled.has(c) || Node.isVariableDeclaration(c.getParent())) continue
      block(nearestFn(c), 'unsupported-db-use', c.getParent() ?? c)
    }
  }

  const used = new Set() // owners that really get converted
  const usedChains = []
  for (const c of chains) {
    const tx = txScopeOf(c.call)
    const holder = tx ? nearestFn(tx.getParent()) : c.owner
    if (blocked.has(c.owner) || (holder && blocked.has(holder))) { note('skipped-blocked-function', c.call); continue }
    if (holder && !nameNodeOf(holder) && (Node.isArrowFunction(holder) || Node.isFunctionExpression(holder))) {
      const v = callbackVerdict(holder)
      if (!v.ok) { note('callback-boundary', c.call, v.why); continue }
    }
    c.tx = tx
    c.holder = holder
    usedChains.push(c)
  }
  const usedTxs = []
  for (const t of txs) {
    const f = t.tx.getArguments()[0]
    const holder = nearestFn(t.outer)
    if (!f || !Node.isArrowFunction(f) || isAsyncFn(f) || f.getParameters().length > 0 || f.getReturnTypeNode() || t.outer.getArguments().length > 0 || (t.mode === 'exclusive')) {
      note('unsupported-transaction-shape', t.outer)
      if (holder) blocked.set(holder, 'unsupported-transaction-shape')
      continue
    }
    if (!holder) { note('module-level-db', t.outer); continue }
    if (blocked.has(holder)) { note('skipped-blocked-function', t.outer); continue }
    t.fn = f
    t.holder = holder
    usedTxs.push(t)
  }
  // a chain inside a transaction whose transaction was refused must be refused too
  const txFns = new Set(usedTxs.map((t) => t.fn))
  const finalChains = usedChains.filter((c) => !c.tx || txFns.has(c.tx))
  for (const c of usedChains) if (!finalChains.includes(c)) note('skipped-blocked-function', c.call)

  // the facade import and the (maybe) dropped raw import
  const rewrittenDb = new Set()
  for (const c of finalChains) {
    const txName = c.tx ? 'tx' : 'dbx'
    const obj = txName
    const call = c.call
    let e = call
    const p = call.getParent()
    let generic = ''
    let castKept = false
    let castNode = null
    if (Node.isAsExpression(p) && p.getExpression() === call) {
      castNode = p
      e = p
      const ty = p.getTypeNode().getText()
      if (c.method === 'get' && /\|\s*undefined$/.test(ty)) generic = `<${ty.replace(/\s*\|\s*undefined$/, '')}>`
      else if (c.method === 'all' && /^[A-Za-z_][\w.]*\[\]$/.test(ty.replace(/\s+/g, ''))) generic = `<${ty.replace(/\[\]$/, '')}>`
      else castKept = true
    }
    const paren = castKept || needsParens(e)
    const aw = !castKept && plainReturn(e) ? '' : 'await '
    const open = `${paren ? openParen(e) : ''}${aw}${obj}.${c.method}${generic}(`
    if (c.method === 'exec') {
      const pa = call.getExpression()
      edit(file, call.getStart(), pa.getNameNode().getEnd(), `${paren ? openParen(e) : ''}${plainReturn(e) ? '' : 'await '}${obj}.exec`)
      rewrittenDb.add(pa.getExpression())
    } else {
      const prepare = call.getExpression().getExpression()
      const sql = c.prepareArg
      edit(file, call.getStart(), sql.getStart(), open)
      const cargs = call.getArguments()
      if (cargs.length > 0) edit(file, sql.getEnd(), cargs[0].getStart(), ', ')
      else edit(file, sql.getEnd(), call.getEnd(), ')')
      rewrittenDb.add(prepare.getExpression().getExpression())
    }
    if (c.method !== 'exec' || paren) { /* closing parens below */ }
    if (castNode && !castKept) edit(file, call.getEnd(), castNode.getEnd(), '')
    if (paren) edit(file, call.getEnd(), call.getEnd(), ')')
    if (c.holder) used.add(c.holder)
  }
  for (const t of usedTxs) {
    const e = t.outer
    const paren = needsParens(e)
    edit(file, e.getStart(), t.fn.getStart(), `${paren ? openParen(e) : ''}${plainReturn(e) ? '' : 'await '}dbx.tx(`)
    const arrowToken = t.fn.getFirstChildByKindOrThrow(SyntaxKind.EqualsGreaterThanToken)
    edit(file, t.fn.getStart(), arrowToken.getEnd(), 'async (tx) =>')
    edit(file, t.fn.getEnd(), e.getEnd(), `${t.mode === 'immediate' ? ", { mode: 'immediate' }" : ''})${paren ? ')' : ''}`)
    rewrittenDb.add(t.tx.getExpression().getExpression())
    converted.set(t.fn, 'transaction body')
    used.add(t.holder)
  }

  if (used.size > 0 && testsMode) fixTestImports(sf, file, new Set([...rewrittenDb]))
  if (used.size > 0 && !testsMode) {
    convertedModules.add(file)
    // imports: add dbx, drop db when nothing else uses it
    const remaining = sf.getDescendantsOfKind(SyntaxKind.Identifier).filter((i) => isDbIdentifier(i) && !Node.isImportSpecifier(i.getParent()) && !rewrittenDb.has(i))
    const relFacade = path.relative(path.dirname(file), facadeFile).replace(/\\/g, '/').replace(/\.ts$/, '.js')
    const facadeSpec = relFacade.startsWith('.') ? relFacade : `./${relFacade}`
    const imports = sf.getImportDeclarations()
    const hasDbx = imports.some((i) => i.getNamedImports().some((n) => n.getName() === 'dbx'))
    const connImport = imports.find((i) => /connection\.js$/.test(i.getModuleSpecifierValue()) && i.getNamedImports().some((n) => n.getName() === 'db'))
    const dbxImport = `import { dbx } from '${facadeSpec}'`
    const soleDb = connImport && connImport.getNamedImports().length === 1 && !connImport.getDefaultImport()
    const dropConn = !!connImport && remaining.length === 0
    if (!hasDbx) {
      if (dropConn && soleDb) edit(file, connImport.getStart(), connImport.getEnd(), dbxImport) // the raw import becomes the facade import
      else {
        const anchor = connImport ?? imports[imports.length - 1]
        edit(file, anchor.getEnd(), anchor.getEnd(), `\n${dbxImport}`)
      }
    }
    if (dropConn && !(soleDb && !hasDbx)) {
      if (soleDb) {
        const end = connImport.getEnd()
        const next = sf.getFullText()[end] === '\n' ? end + 1 : end
        edit(file, connImport.getStart(), next, '')
      } else {
        const spec = connImport.getNamedImports().find((n) => n.getName() === 'db')
        const text = sf.getFullText()
        let st = spec.getStart()
        let en = spec.getEnd()
        if (text.slice(en, en + 2) === ', ') en += 2
        else if (text.slice(st - 2, st) === ', ') st -= 2
        edit(file, st, en, '')
      }
    }
  }
  for (const holder of used) markAsync(holder, 'uses the facade')
}

// ---- async propagation ----------------------------------------------------------------------------------------
const queue = []
function returnTypeEdits(f) {
  const rt = f.getReturnTypeNode?.()
  if (!rt) return
  const t = rt.getText()
  if (/^Promise</.test(t)) return
  edit(f.getSourceFile().getFilePath(), rt.getStart(), rt.getStart(), 'Promise<')
  edit(f.getSourceFile().getFilePath(), rt.getEnd(), rt.getEnd(), '>')
}
function markAsync(f, why) {
  if (converted.has(f) || isAsyncFn(f)) return
  const file = f.getSourceFile().getFilePath()
  if (Node.isFunctionDeclaration(f) || Node.isFunctionExpression(f)) {
    if (f.isGenerator()) { note('generator-not-converted', f); return }
    edit(file, f.getFirstChildByKind(SyntaxKind.FunctionKeyword).getStart(), f.getFirstChildByKind(SyntaxKind.FunctionKeyword).getStart(), 'async ')
  } else if (Node.isMethodDeclaration(f)) {
    edit(file, f.getNameNode().getStart(), f.getNameNode().getStart(), 'async ')
  } else {
    edit(file, f.getStart(), f.getStart(), 'async ')
  }
  returnTypeEdits(f)
  converted.set(f, why)
  queue.push(f)
}

function nameNodeOf(f) {
  if (Node.isFunctionDeclaration(f) || Node.isMethodDeclaration(f)) return f.getNameNode()
  const p = f.getParent()
  if (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p) || Node.isPropertyDeclaration(p)) return p.getNameNode()
  return null
}

const BLOCKING_CALLEES = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'reduce', 'sort', 'flatMap', 'on', 'once', 'addListener', 'setInterval', 'setTimeout', 'setImmediate', 'addEventListener', 'toSorted', 'findLast', 'expect'])
const TEST_BLOCKING = new Set(['describe', 'fn', 'mockImplementation', 'mockImplementationOnce', 'mockReturnValue'])
// `expect` is in the list for the thrown-error assertions: `expect(() => f()).not.toThrow()` turned into
// `expect(async () => ...)` can never fail (a rejection is not a throw). The test is rewritten by hand as
// `await expect(f()).resolves...` / `.rejects.toThrow(...)`.

// May the anonymous function `g` (an argument) become async? Reports when it must be looked at by hand.
function callbackVerdict(g) {
  const call = g.getParent()
  if (!Node.isCallExpression(call)) return { ok: true }
  const callee = call.getExpression()
  const calleeName = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText()
  if (BLOCKING_CALLEES.has(calleeName) || (testsMode && (TEST_BLOCKING.has(calleeName) || /^describe\b/.test(calleeName)))) return { ok: false, why: `callback of ${calleeName}` }
  const ctx = g.getContextualType()
  const sig = ctx?.getCallSignatures?.()[0]
  const rt = sig?.getReturnType().getText() ?? ''
  if (rt === 'void' || rt === 'undefined') return { ok: false, why: `callback expecting void (${calleeName})` }
  return { ok: true }
}

function wrapAwait(call) {
  const file = call.getSourceFile().getFilePath()
  const key = `${file}:${call.getStart()}`
  if (awaited.has(key)) return
  awaited.add(key)
  const p = call.getParent()
  if (Node.isAwaitExpression(p)) return
  if (plainReturn(call)) return
  const paren = needsParens(call)
  edit(file, call.getStart(), call.getStart(), `${paren ? openParen(call) : ''}await `)
  if (paren) edit(file, call.getEnd(), call.getEnd(), ')')
  awaitCount += 1
}

function propagate() {
  while (queue.length > 0) {
    const f = queue.shift()
    const nameNode = nameNodeOf(f)
    if (!nameNode) { if (!Node.isCallExpression(f.getParent())) note('converted-function-without-name', f); continue }
    let refs = []
    try { refs = nameNode.findReferencesAsNodes() } catch { note('references-failed', f); continue }
    for (const r of refs) {
      if (r === nameNode) continue
      const parent = r.getParent()
      if (Node.isImportSpecifier(parent) || Node.isImportClause(parent)) continue
      if (Node.isExportSpecifier(parent)) { note('re-export', r); continue }
      let call = null
      if (Node.isCallExpression(parent) && parent.getExpression() === r) call = parent
      else if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === r && Node.isCallExpression(parent.getParent()) && parent.getParent().getExpression() === parent) call = parent.getParent()
      if (!call) { note('function-value', r); continue }
      const file = call.getSourceFile().getFilePath()
      if (bootFiles.includes(file)) { note('boot-synchronous', call); continue }
      const g = nearestFn(call)
      if (!g) { note('module-level', call); continue }
      if (isSpecialFn(g)) { note('constructor-getter-setter', call); continue }
      if (Node.isPropertyDeclaration(call.getParent()?.getParent?.()) && !g) { note('class-field', call); continue }
      if (converted.has(g) || isAsyncFn(g)) { wrapAwait(call); continue }
      if (!nameNodeOf(g) && (Node.isArrowFunction(g) || Node.isFunctionExpression(g))) {
        const v = callbackVerdict(g)
        if (!v.ok) { note('callback-boundary', call, v.why); continue }
      }
      wrapAwait(call)
      markAsync(g, `calls ${nameNode.getText()}`)
    }
  }
}

// ---- driver --------------------------------------------------------------------------------------------------
for (const t of targets) {
  const sf = project.getSourceFile(t)
  if (!sf) { console.error(`not in the project: ${t}`); process.exit(2) }
  convertTarget(sf)
}
propagate()

// vi.mock of a converted module, tests that need useTestDb
for (const sf of project.getSourceFiles()) {
  const file = sf.getFilePath()
  if (!/__tests__/.test(file)) continue
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const e = call.getExpression()
    if (Node.isPropertyAccessExpression(e) && e.getExpression().getText() === 'vi' && e.getName() === 'mock') {
      const spec = call.getArguments()[0]
      if (!spec || !Node.isStringLiteral(spec)) continue
      const abs = path.resolve(path.dirname(file), spec.getLiteralValue().replace(/\.js$/, '.ts'))
      if ([...convertedModules].some((m) => m === abs)) note('vi.mock-of-converted-module', call, spec.getLiteralValue())
    }
  }
  if (edits.has(file) && !sf.getImportDeclarations().some((i) => /with-test-db/.test(i.getModuleSpecifierValue()))) note('test-needs-useTestDb', sf.getImportDeclarations()[0] ?? sf, path.relative(root, file))
}

// ---- apply ---------------------------------------------------------------------------------------------------
let totalEdits = 0
const changedFiles = []
for (const [file, list] of edits) {
  const text = readFileSync(file, 'utf8')
  const sorted = [...list].sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order)
  let out = text
  let lastStart = Infinity
  for (const e of sorted) {
    if (e.end > lastStart && e.start < lastStart && e.end !== e.start) {
      console.error(`overlapping edits in ${file} at ${e.start}-${e.end} ${JSON.stringify(e.text)} against an edit at ${lastStart}: ${JSON.stringify(sorted.filter((x) => x.start >= e.start && x.start <= e.end + 5).map((x) => [x.start, x.end, x.text]))}; skipped file`)
      out = null
      break
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
    lastStart = Math.min(lastStart, e.start)
  }
  if (out === null || out === text) continue
  totalEdits += list.length
  changedFiles.push(path.relative(root, file))
  if (!dryRun) writeFileSync(file, out)
}

const report = {
  dryRun,
  convertedFunctions: [...converted].map(([f, why]) => ({ file: path.relative(root, f.getSourceFile().getFilePath()), line: f.getStartLineNumber(), name: nameNodeOf(f)?.getText() ?? '(anonymous)', why })),
  awaitsAdded: awaitCount,
  editedFiles: changedFiles,
  edits: totalEdits,
  manual: manual.map(({ key, ...m }) => m).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
}
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(`${dryRun ? '[dry-run] ' : ''}functions converted: ${report.convertedFunctions.length}, awaits added: ${awaitCount}, files edited: ${changedFiles.length}, edits: ${totalEdits}, manual places: ${report.manual.length}`)
for (const m of report.manual) console.log(`  MANUAL ${m.kind}: ${m.file}:${m.line}  ${m.detail}`)
// the main categories at a glance: per kind, the files that hold most of it
const byKind = new Map()
for (const m of report.manual) {
  const k = byKind.get(m.kind) ?? new Map()
  k.set(m.file, (k.get(m.file) ?? 0) + 1)
  byKind.set(m.kind, k)
}
for (const [kind, files] of [...byKind].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  const total = [...files.values()].reduce((x, y) => x + y, 0)
  const top = [...files].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} ${n}`).join(', ')
  console.log(`  SUMMARY ${kind}: ${total} in ${files.size} files (top: ${top})`)
}

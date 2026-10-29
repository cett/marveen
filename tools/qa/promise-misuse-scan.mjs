#!/usr/bin/env node
// Finds Promise-typed expressions in a non-awaiting position: a Promise is always truthy, compares by
// identity, stringifies as "[object Promise]" and loses its rejection when it is passed on as a value.
// After the async facade conversion this is the mistake a missing `await` leaves behind.
//
//   node tools/qa/promise-misuse-scan.mjs --base <sha>          lines the diff base..HEAD added under --src
//   node tools/qa/promise-misuse-scan.mjs --all                 the whole --src tree
//
// Options: --root <repo> (default cwd), --src <dir> (default src), --tsconfig <rel> (default tsconfig.json),
//          --fail-on-findings (exit 1 when anything is found).
// stdout: JSON report. stderr: one line per finding and the total.
import path from 'node:path'
import process from 'node:process'
import { changedLines, createProgram, emit, inRanges, loadTypeScript, parseArgs, resolveRoot } from './lib/common.mjs'

const args = parseArgs(process.argv.slice(2), {
  flags: ['all', 'fail-on-findings'],
  values: ['root', 'base', 'src', 'tsconfig'],
  defaults: { src: 'src', tsconfig: 'tsconfig.json' },
})
if (!args.all && !args.base) {
  process.stderr.write('promise-misuse-scan: pass --base <sha> (lines the diff added) or --all\n')
  process.exit(2)
}
const root = resolveRoot(args.root)
const ts = loadTypeScript(root)
const program = createProgram(ts, root, args.tsconfig)
const checker = program.getTypeChecker()
const srcDir = path.join(root, args.src)
const changed = args.all ? null : changedLines(root, args.base, args.src)

const isPromise = (t) => {
  if (!t) return false
  if (t.isUnion && t.isUnion()) return t.types.some(isPromise)
  const then = t.getProperty && t.getProperty('then')
  return !!then && (t.symbol?.name === 'Promise' || t.symbol?.name === 'PromiseLike' || /Promise/.test(checker.typeToString(t)))
}

const OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
])
// Array callbacks that expect a plain value or nothing: a callback returning a Promise is a bug there.
const CALLBACK_HOSTS = new Set([
  'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'sort', 'toSorted', 'flatMap',
  'transaction', 'exec', 'immediate', 'run', 'forEach', 'map', 'setTimeout', 'setInterval', 'on', 'once',
])

// `Promise.all(items.map(async ...))` is the intended use of a callback that returns a Promise.
const PROMISE_API = /^Promise\.(all|allSettled|race|any|resolve)$/
const isPromiseApiCall = (sf, p) => !!p && ts.isCallExpression(p) && PROMISE_API.test(p.expression.getText(sf))

const findings = []
function report(sf, node, kind) {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  if (changed && !inRanges(changed.get(sf.fileName), line)) return
  findings.push({
    file: path.relative(root, sf.fileName),
    line,
    kind,
    text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
  })
}

function visit(sf, node) {
  const P = node.parent
  const typeOf = (n) => { try { return checker.getTypeAtLocation(n) } catch { return null } }
  if (P && ts.isExpression(node) && !ts.isAwaitExpression(node) && isPromise(typeOf(node))) {
    const inPromiseApi = (p) => isPromiseApiCall(sf, p)
    if (ts.isCallExpression(P) && P.arguments.includes(node) && !inPromiseApi(P)) report(sf, node, 'call-arg')
    else if (ts.isTemplateSpan(P)) report(sf, node, 'template')
    else if (ts.isPropertyAssignment(P) && P.initializer === node) report(sf, node, 'object-prop')
    else if (ts.isShorthandPropertyAssignment(P)) report(sf, node, 'object-shorthand')
    else if (ts.isBinaryExpression(P) && OPERATORS.has(P.operatorToken.kind)) report(sf, node, 'binary')
    else if ((ts.isIfStatement(P) || ts.isWhileStatement(P) || ts.isDoStatement(P)) && P.expression === node) report(sf, node, 'condition')
    else if (ts.isConditionalExpression(P) && P.condition === node) report(sf, node, 'ternary-cond')
    else if (ts.isPrefixUnaryExpression(P) && P.operator === ts.SyntaxKind.ExclamationToken) report(sf, node, 'not')
    else if (ts.isSpreadElement(P) || ts.isSpreadAssignment(P)) report(sf, node, 'spread')
    else if (ts.isArrayLiteralExpression(P) && !(P.parent && ts.isCallExpression(P.parent) && inPromiseApi(P.parent))) report(sf, node, 'array-el')
    else if ((ts.isPropertyAccessExpression(P) || ts.isElementAccessExpression(P)) && P.expression === node) {
      const name = ts.isPropertyAccessExpression(P) ? P.name.text : ''
      if (!['then', 'catch', 'finally'].includes(name)) report(sf, node, 'prop-access')
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && CALLBACK_HOSTS.has(node.expression.name.text)) {
    const hostName = node.expression.name.text
    // map / flatMap handed straight to a Promise API: the callbacks' Promises are awaited by it
    if ((hostName === 'map' || hostName === 'flatMap') && isPromiseApiCall(sf, node.parent)) return ts.forEachChild(node, (c) => visit(sf, c))
    for (const a of node.arguments) {
      if (!ts.isArrowFunction(a) && !ts.isFunctionExpression(a)) continue
      try {
        const sig = checker.getSignatureFromDeclaration(a)
        if (sig && isPromise(checker.getReturnTypeOfSignature(sig))) report(sf, a, 'callback-returns-promise')
      } catch { /* a signature the checker cannot resolve is not a finding */ }
    }
  }
  ts.forEachChild(node, (c) => visit(sf, c))
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !sf.fileName.startsWith(srcDir + path.sep) || sf.fileName.includes('/__tests__/')) continue
  visit(sf, sf)
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind))

const report_ = {
  tool: 'promise-misuse-scan',
  mode: args.all ? 'all' : 'changed-lines',
  base: args.base ?? null,
  src: args.src,
  total: findings.length,
  byKind: Object.fromEntries([...new Set(findings.map((f) => f.kind))].sort().map((k) => [k, findings.filter((f) => f.kind === k).length])),
  findings,
}
emit(report_, [
  ...findings.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text}`),
  `promise-misuse-scan: ${findings.length} finding(s) (${report_.mode})`,
])
process.exit(args['fail-on-findings'] && findings.length > 0 ? 1 : 0)

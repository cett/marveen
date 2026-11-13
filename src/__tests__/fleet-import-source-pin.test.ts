// Source pins for the fleet import transaction. The behaviour cells (fleet-import-body-handle, fleet-import-apply-both-engines)
// catch a call that goes around the handle on PostgreSQL, where the outer dbx is refused inside a transaction body. Two
// things they cannot see, and this file pins:
//
//   1. A transaction callback in production code that takes no handle (`.tx(async () => ...)`). On SQLite such a body
//      only works through the facade's ambient scope, on PostgreSQL it is refused; the scanner of the db layer does not
//      look at the shape of the callback.
//   2. A call of the import body that does not pass the handle but is a no-op or an ambient call on the engine the test
//      runs on (rebuildMemoriesFts: nothing to do on PostgreSQL, ambient on SQLite).
//
// It reads source text only: no database. The harness cells at the top prove the matchers fire, so "zero hits" below is
// not an empty claim.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')
const WEB_FT = readFileSync(join(SRC, 'web', 'fleet-transfer.ts'), 'utf8')

/** `.tx(async () =>`, `.tx(() =>`, `.tx(async function ()` and `inFleetImportTransaction(async () =>`: a callback with no parameter. */
const HANDLE_LESS = /(?:\.tx|inFleetImportTransaction)\(\s*(?:async\s+)?(?:\(\s*\)\s*=>|function\s*\(\s*\))/g

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === '__tests__' || name === 'node_modules') continue
    const st = statSync(p)
    if (st.isDirectory()) productionFiles(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The text of the call whose `(` is at `open`, split into its top-level arguments (quotes and brackets respected). */
function callArgs(text: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = open + 1
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        const last = text.slice(start, i).trim()
        if (last !== '') args.push(last)
        return args
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  throw new Error('callArgs: unbalanced call')
}

/** The source of the import transaction body: from its opening line to the `await importTx()` that follows it. */
function importBody(): string {
  const open = WEB_FT.indexOf('inFleetImportTransaction(async (tx) => {')
  const end = WEB_FT.indexOf('await importTx()', open)
  if (open < 0 || end < 0) throw new Error('the import transaction body was not found: update this pin with the refactor')
  return WEB_FT.slice(open, end)
}

describe('the matcher for a handle-less transaction callback (harness)', () => {
  it('fires on every spelling of the callback without a handle', () => {
    for (const bad of [
      'await dbx.tx(async () => { x() })',
      'await tx.tx(() => x())',
      'await dbx.tx(\n  async () => {\n  })',
      'await dbx.tx(async function () { x() })',
      'inFleetImportTransaction(async () => { x() })',
    ]) expect(bad.match(HANDLE_LESS), bad).not.toBeNull()
  })

  it('does not fire on a callback that takes the handle', () => {
    for (const ok of [
      'await dbx.tx(async (tx) => { x() })',
      'await tx.tx((sp) => x(sp))',
      'inFleetImportTransaction(async (tx) => { x() })',
      'await dbx.tx(write)',
    ]) expect(ok.match(HANDLE_LESS), ok).toBeNull()
  })
})

describe('production code', () => {
  it('has no transaction callback without a handle', () => {
    const hits: string[] = []
    for (const file of productionFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(HANDLE_LESS)) {
        hits.push(`${relative(SRC, file)}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(hits).toEqual([])
  })
})

/** Callee -> how many times the body calls it, and what its last argument must look like (the handle, or an object that holds it). */
const CALLEES: Record<string, { calls: number; lastArg: (a: string) => boolean }> = {
  importFleetRows: { calls: 14, lastArg: (a) => a === 'tx' },
  upsertAutonomyCategory: { calls: 1, lastArg: (a) => a === 'tx' },
  auditAutonomyLevelChange: { calls: 1, lastArg: (a) => a.startsWith('{ tx,') },
  upsertModelProfileMapEntry: { calls: 1, lastArg: (a) => a === 'tx' },
  setAgentSetting: { calls: 1, lastArg: (a) => a === 'tx' },
  setDesiredAgents: { calls: 1, lastArg: (a) => a === 'tx' },
  writeModelFallbackFieldsRaw: { calls: 1, lastArg: (a) => a === 'tx' },
  writeTerminalInputEnabled: { calls: 1, lastArg: (a) => a === 'tx' },
  setFederationConfigRaw: { calls: 1, lastArg: (a) => a === 'tx' },
  replaceCostBudgets: { calls: 1, lastArg: (a) => a === 'tx' },
  mergeEgressAllowlistEntries: { calls: 1, lastArg: (a) => a === 'tx' },
  seedSkillIfAbsent: { calls: 1, lastArg: (a) => a === 'tx' },
  enabledLocalTenantIds: { calls: 1, lastArg: (a) => a === 'tx' },
  rebuildMemoriesFts: { calls: 1, lastArg: (a) => a === 'tx' },
}

describe('the body of the fleet import transaction', () => {
  const body = importBody()

  it('passes the handle as the last argument of every call it makes', () => {
    for (const [name, want] of Object.entries(CALLEES)) {
      const opens = [...body.matchAll(new RegExp(`await ${name}\\(`, 'g'))].map((m) => m.index! + m[0].length - 1)
      expect(opens.length, `${name}: number of calls in the body`).toBe(want.calls)
      for (const open of opens) {
        const args = callArgs(body, open)
        expect(want.lastArg(args[args.length - 1] ?? ''), `${name}(...) last argument: ${args[args.length - 1]}`).toBe(true)
      }
    }
  })

  it('awaits nothing else: a new call must be listed above (with its handle) or be a call on the handle', () => {
    const awaited = [...body.matchAll(/await\s+([A-Za-z_][\w.]*)\(/g)].map((m) => m[1]!)
    const unknown = awaited.filter((n) => !(n in CALLEES) && !n.startsWith('tx.'))
    expect(unknown).toEqual([])
  })

  it('does not touch the outer dbx or the synchronous db handle', () => {
    expect(body).not.toMatch(/\bdbx\b/)
    expect(body).not.toMatch(/\bdb\.prepare\b|\bgetDb\(/)
  })
})

// The boot-synchronous twins: functions that stay on the raw synchronous connection because the boot chain
// (db/index.ts) runs before any async code can. They bypass the async facade, so they must not spread: a
// caller outside the boot chain would read or write on the raw connection beside the facade's transaction
// lock, which is exactly what the facade exists to prevent (and what does not exist on PostgreSQL).
//
// One table, one walk over src/. A twin is listed with the only files allowed to mention it: the file that
// defines it and the boot chain that calls it. This replaces the per-module guard each wave step had added
// next to its own tests; a new twin is one more row here.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

/** twin function -> the files (relative to src/) that may mention it outside a comment. */
const BOOT_SYNC_TWINS: Readonly<Record<string, readonly string[]>> = {
  migrateCostBudgetsFromFile: ['db/cost-budgets.ts', 'db/index.ts'],
  migrateVaultBindingsFromFile: ['db/vault-bindings.ts', 'db/index.ts'],
  importAgentSettingsFromFile: ['db/agent-settings.ts', 'db/index.ts'],
  // Boot-only, on the raw handle: the one-time agent_settings file import stamps each row with the owning tenant.
  resolveAgentOwningTenantIdSync: ['db/agents.ts', 'db/index.ts'],
  importAgentStateFromFile: ['db/agent-state.ts', 'db/index.ts'],
  getAgentStateSync: ['db/agent-state.ts', 'db/index.ts'],
  setAgentStateSync: ['db/agent-state.ts', 'db/index.ts'],
  // migrateFederationConfigFromFile (the other twin) writes its row through setSystemConfigSync.
  setSystemConfigSync: ['db/system-config.ts', 'db/federation.ts', 'db/index.ts'],
  migrateFederationConfigFromFile: ['db/federation.ts', 'db/index.ts'],
  // startWebServer enrolls the file token before it listens and cannot await: the bootstrap helper it calls is
  // the one caller, outside db/index.ts.
  enrollDashboardApiTokenSync: ['db/api-tokens.ts', 'web/token-bootstrap.ts'],
  replaceClaudePlanRowsSync: ['db/claude-plans.ts', 'db/index.ts'],
  activatePlanForAgentSync: ['db/claude-plans.ts', 'db/index.ts'],
  // Boot-only, on the raw handle (no facade call before initDatabase returns); it has no asynchronous counterpart.
  backfillImportShadowRows: ['db/vector.ts', 'db/index.ts'],
  // Boot-only, on the raw handle: the tasks module is on the facade, this one-time import of the last-run file is not.
  migrateScheduleLastRunFromFile: ['db/tasks.ts', 'db/index.ts'],
}

// Several files cross-reference a twin by name in a doc comment, which is not a call.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** The files of `sources` (path relative to src/ -> content) that mention `twin` outside a comment. */
function filesMentioning(twin: string, sources: ReadonlyMap<string, string>): string[] {
  const re = new RegExp(`\\b${twin}\\b`)
  return [...sources].filter(([, src]) => re.test(stripComments(src))).map(([rel]) => rel).sort()
}

/** The names declared right below a `// @boot-sync-twin` line in src/db/. */
function taggedTwins(sources: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  for (const [rel, src] of sources) {
    if (!rel.startsWith('db/')) continue
    for (const m of src.matchAll(/\/\/ @boot-sync-twin\s*\n\s*export function (\w+)/g)) out.push(m[1]!)
  }
  return out.sort()
}

/** A statement on the raw synchronous connection (`db` is the live binding of db/connection.ts). */
const RAW_STATEMENT = /\bdb\s*\.\s*(prepare|exec|transaction|pragma)\b/

/** Cuts the top-level function `name` (from its `function` keyword to the closing brace at column 0) out of `src`. */
function cutFunction(src: string, name: string): { body: string; rest: string } {
  const start = src.search(new RegExp(`\\bfunction\\s+${name}\\b`))
  if (start < 0) return { body: '', rest: src }
  const close = src.indexOf('\n}', start)
  const end = close < 0 ? src.length : close + 2
  return { body: src.slice(start, end), rest: src.slice(0, start) + src.slice(end) }
}

function readSources(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue
      readSources(full, out)
    } else if (name.endsWith('.ts')) {
      out.set(full.slice(SRC_DIR.length), readFileSync(full, 'utf8'))
    }
  }
  return out
}

const SOURCES = readSources(SRC_DIR)

describe('boot-synchronous twins stay inside the boot chain', () => {
  it('the walk reads the real source tree (a guard over zero files passes vacuously)', () => {
    expect(SOURCES.size).toBeGreaterThan(100)
    expect(SOURCES.has('db/index.ts')).toBe(true)
  })

  it.each(Object.entries(BOOT_SYNC_TWINS))('%s is mentioned only in its allowed files, and in all of them', (twin, allowed) => {
    // Exact equality, not "subset": an allowed file that no longer mentions the twin means the row is stale
    // and would silently permit a future caller there.
    expect(filesMentioning(twin, SOURCES)).toEqual([...allowed].sort())
  })

  // The table is checked against an independent source: a twin carries a `// @boot-sync-twin` line above its
  // declaration. Deleting a row (which would make a twin unguarded and fail nothing above) or adding a twin
  // without a row both fail here.
  it('the table lists exactly the functions tagged @boot-sync-twin', () => {
    expect(taggedTwins(SOURCES)).toEqual(Object.keys(BOOT_SYNC_TWINS).sort())
  })

  // A synchronous twin of ANY db function is declared with a name ending in `Sync`. Every such declaration in
  // src/db (private ones included) must be one of the tagged boot twins above: the private `createApprovalSync`,
  // `getApprovalSync` and `recordApprovalEventSync` of the vault module (removed with the approvals step) were
  // exactly this shape and were not in the table, because they were not exported.
  it('src/db declares no *Sync function that is not a boot twin', () => {
    const declared: string[] = []
    for (const [rel, src] of SOURCES) {
      if (!rel.startsWith('db/')) continue
      for (const m of stripComments(src).matchAll(/\bfunction\s+(\w+Sync)\b/g)) declared.push(m[1]!)
    }
    expect(declared.length).toBeGreaterThan(0) // the scan sees the real twins
    expect(declared.sort()).toEqual(declared.filter((n) => n in BOOT_SYNC_TWINS).sort())
  })

  // The modules that have moved completely onto the facade keep no raw statement. A raw `db.prepare(...)` or a raw
  // `db.transaction(...)` there would run beside the facade's transaction lock. The list is a literal on purpose:
  // a module joins it in the commit that moves it, and the length check below keeps a renamed or emptied file
  // from passing vacuously.
  const RAW_FREE_MODULES = [
    'db/agent-inflight-turns.ts', 'db/artifacts.ts', 'db/audit.ts', 'db/autonomy.ts', 'db/channel-credentials.ts',
    'db/conversation-ledger.ts', 'db/device-keys.ts', 'db/egress-allowlist.ts', 'db/federation.ts',
    'db/fleet-transfer.ts', 'db/import.ts', 'db/kanban.ts', 'db/memory.ts', 'db/misc.ts', 'db/observability.ts',
    'db/otel-logs.ts', 'db/overview.ts', 'db/sessions.ts', 'db/tenant-channel-bindings.ts', 'db/tenant-scoped.ts',
    'db/token-shadow.ts', 'db/vault.ts', 'db/workspace.ts',
  ]
  it.each(RAW_FREE_MODULES)('%s has no statement on the raw connection', (rel) => {
    const src = stripComments(SOURCES.get(rel) ?? '')
    expect(src.length).toBeGreaterThan(1000)
    expect(src).not.toMatch(RAW_STATEMENT)
  })

  // A module on the facade whose only raw statements are its boot twin: with the twin's body cut out, nothing
  // raw is left, and the twin itself does use the raw handle (a row whose twin moved away is stale).
  const RAW_ONLY_IN_TWIN: Readonly<Record<string, string>> = {
    'db/agents.ts': 'resolveAgentOwningTenantIdSync',
    'db/tasks.ts': 'migrateScheduleLastRunFromFile',
    'db/cost-budgets.ts': 'migrateCostBudgetsFromFile',
    'db/vault-bindings.ts': 'migrateVaultBindingsFromFile',
  }
  it.each(Object.entries(RAW_ONLY_IN_TWIN))('%s keeps its raw statements inside %s only', (rel, twin) => {
    expect(twin in BOOT_SYNC_TWINS).toBe(true)
    const { body, rest } = cutFunction(stripComments(SOURCES.get(rel) ?? ''), twin)
    expect(rest.length).toBeGreaterThan(1000)
    expect(body).toMatch(RAW_STATEMENT)
    expect(rest).not.toMatch(RAW_STATEMENT)
  })

  // Negative controls for the detector: without them a regex that matches nothing would pass every row above.
  describe('the detector', () => {
    const sources = new Map<string, string>([
      ['db/index.ts', 'migrateCostBudgetsFromFile(x)'],
      ['web/rogue.ts', 'import { migrateCostBudgetsFromFile } from "../db.js"\nmigrateCostBudgetsFromFile(y)'],
      ['web/doc-only.ts', '// see migrateCostBudgetsFromFile\n/* and migrateCostBudgetsFromFile here */\nconst a = 1'],
      ['web/lookalike.ts', 'migrateCostBudgetsFromFileExtra(z)'],
    ])

    it('finds a caller outside the allowed files', () => {
      expect(filesMentioning('migrateCostBudgetsFromFile', sources)).toEqual(['db/index.ts', 'web/rogue.ts'])
    })

    it('does not count a mention in a line or block comment', () => {
      expect(filesMentioning('migrateCostBudgetsFromFile', sources)).not.toContain('web/doc-only.ts')
    })

    it('does not count a longer name that merely contains the twin name', () => {
      expect(filesMentioning('migrateCostBudgetsFromFile', sources)).not.toContain('web/lookalike.ts')
    })

    it('the tag finder reads the declaration under the tag and ignores an untagged function', () => {
      const db = new Map([['db/x.ts', '// @boot-sync-twin\nexport function fooSync() {}\nexport function barSync() {}'], ['web/y.ts', '// @boot-sync-twin\nexport function ignored() {}']])
      expect(taggedTwins(db)).toEqual(['fooSync'])
    })

    it('cutFunction separates the twin body from the rest, so a raw statement outside it stays visible', () => {
      const src = 'export function a() {\n  return db.prepare("x")\n}\nexport function b() {\n  return 1\n}\n'
      const cut = cutFunction(src, 'a')
      expect(cut.body).toMatch(RAW_STATEMENT)
      expect(cut.rest).not.toMatch(RAW_STATEMENT)
      const leaking = cutFunction(src + 'export function c() {\n  db.exec("y")\n}\n', 'a')
      expect(leaking.rest).toMatch(RAW_STATEMENT)
      expect(cutFunction(src, 'missing').body).toBe('')
    })

    it('the sync pair is matched by exact name, so the async getAgentState is not a twin hit', () => {
      const pair = new Map([['web/a.ts', 'getAgentState(x)'], ['web/b.ts', 'getAgentStateSync(x)']])
      expect(filesMentioning('getAgentStateSync', pair)).toEqual(['web/b.ts'])
    })
  })
})

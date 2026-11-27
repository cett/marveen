// The budget-alert script as a process (scripts/budget-alert-check.ts), on SQLite in a throwaway store. The exit code is the
// scheduler's only failure signal, so both sides are proven on the real file, not on a copy of its logic:
//
//   - a clean run exits 0, prints nothing on stdout, and logs the evaluated line on stderr;
//   - a run whose job fails exits non-zero, prints nothing on stdout, and says so on stderr.
//
// The failure is a store whose database file is not a database: the SQLite boot inside the job fails after the script has
// started. Skipped when this checkout resolves a PostgreSQL URL (the environment or the install's .env): the run would then
// boot the live install, which no test may do.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolvePgUrl } from '../db/pg/url.js'

const ROOT = new URL('../..', import.meta.url).pathname
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(ROOT, 'scripts', 'budget-alert-check.ts')

const stores: string[] = []
afterAll(() => {
  for (const dir of stores) rmSync(dir, { recursive: true, force: true })
})

function freshStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'budget-alert-script-'))
  stores.push(dir)
  return dir
}

/** The script on SQLite in `storeDir`: the PostgreSQL URL is removed from the child's environment. */
function runScript(storeDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MARVEEN_STORE_DIR: storeDir }
  delete env['MARVEEN_PG_URL']
  return spawnSync(TSX, [SCRIPT], { env, encoding: 'utf8', timeout: 120_000 })
}

describe.skipIf(resolvePgUrl() !== undefined)('scripts/budget-alert-check.ts as a process (SQLite, throwaway store)', () => {
  it('a clean run exits 0, prints nothing on stdout, and logs the evaluated line on stderr', () => {
    const result = runScript(freshStore())

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('budget-alert-check: evaluated')
  }, 120_000)

  it('a run whose job fails exits non-zero, prints nothing on stdout, and says so on stderr', () => {
    const store = freshStore()
    // not a SQLite file: the database boot of the job fails, after the script has started
    writeFileSync(join(store, 'claudeclaw.db'), 'this is not a database\n'.repeat(200))

    const result = runScript(store)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('budget-alert-check failed')
  }, 120_000)
})

// `npm run agent-tokens` on SQLite after the body moved to src/agent-tokens/cli.ts: the real script as a child process with a
// throw-away store, one cell per verb. Output lines, exit codes and the usage text are what doctor.sh, verify-restore.sh and
// the restore runbook read, so they must be the old script's, byte for byte. The PostgreSQL side is in
// src/__tests__/pg/agent-tokens-cli.pg.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let storeDir: string
beforeEach(() => { storeDir = mkdtempSync(join(tmpdir(), 'at-cli-sqlite-')) })
afterEach(() => { rmSync(storeDir, { recursive: true, force: true }) })

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, MARVEEN_STORE_DIR: storeDir, CLAUDECLAW_ENV_DIR: storeDir, DASHBOARD_TOKEN: '', ...extraEnv }
  delete env['MARVEEN_PG_URL']
  return spawnSync(TSX, ['scripts/agent-tokens.ts', ...args], { cwd: ROOT, encoding: 'utf-8', env })
}
const operatorFile = () => join(storeDir, '.operator-token')
const sharedFile = () => join(storeDir, '.dashboard-token')

describe('agent-tokens on SQLite: one cell per verb', () => {
  it('issue-operator issues, then keeps; the file is 0600 and neither stream carries the value', () => {
    const a = cli(['issue-operator'])
    expect(a.status, a.stderr).toBe(0)
    expect(a.stdout).toBe(`operator\tissued\tadmin\t${operatorFile()}\n`)
    expect(statSync(operatorFile()).mode & 0o777).toBe(0o600)
    const raw = readFileSync(operatorFile(), 'utf-8').trim()

    const b = cli(['issue-operator'])
    expect(b.stdout).toBe(`operator\tkept\tadmin\t${operatorFile()}\n`)
    for (const s of [a.stdout, a.stderr, b.stdout, b.stderr]) {
      expect(s).not.toContain(raw)
      expect(s).not.toContain(sha(raw))
    }
    // the run's info line: the backend, the verb and a count
    expect(a.stderr).toContain('agent-tokens: run')
  }, 60_000)

  it('issue --rotate rotates, issue of an agent without a directory fails with exit 1, --dry-run writes nothing', () => {
    expect(cli(['issue-operator']).status).toBe(0)
    const before = readFileSync(operatorFile(), 'utf-8')
    const rotated = cli(['issue-operator', '--rotate'])
    expect(rotated.stdout).toBe(`operator\trotated\tadmin\t${operatorFile()}\n`)
    expect(readFileSync(operatorFile(), 'utf-8')).not.toBe(before)

    const failed = cli(['issue', 'no-such-agent'])
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("no-such-agent\tFAILED\tagent 'no-such-agent' has no directory\n")

    const dry = cli(['issue', '--dry-run', 'no-such-agent'])
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stdout).toMatch(/^no-such-agent\twould issue or keep\t.*\.agent-token\n$/)
  }, 90_000)

  it('rotate-shared writes the shared file 0600, prints its line and the restart hint, and refuses with DASHBOARD_TOKEN set', () => {
    const r = cli(['rotate-shared'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`shared\tissued\tadmin\t${sharedFile()}\n`)
    expect(r.stderr).toContain('Restart the dashboard')
    expect(statSync(sharedFile()).mode & 0o777).toBe(0o600)
    expect(r.stdout + r.stderr).not.toContain(readFileSync(sharedFile(), 'utf-8').trim())

    const refused = cli(['rotate-shared'], { DASHBOARD_TOKEN: 'env-fixture-value' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('shared\tFAILED\tDASHBOARD_TOKEN is set in the environment or .env')
    expect(refused.stdout).toBe('')
  }, 90_000)

  it('check exits 1 on a finding and 0 when every row is ok; list prints the active rows; revoke says how many', () => {
    expect(cli(['issue-operator']).status).toBe(0)
    const missing = cli(['check', 'agent-without-file'])
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('agent-without-file\tmissing\tfleet_agent\t')
    expect(missing.stdout).toContain('operator\tok\tadmin\t')

    const listed = cli(['list'])
    expect(listed.status, listed.stderr).toBe(0)
    expect(listed.stdout).toMatch(/^\d+\toperator\tadmin\t-\tdefault\t\d{4}-\d\d-\d\dT/)

    const none = cli(['revoke', 'agent-without-file'])
    expect(none.status).toBe(0)
    expect(none.stdout).toBe('revoked 0 token(s) of agent-without-file\n')
  }, 90_000)

  it('archive-shared-age prints one word: unknown for a missing file, predates / current against an archive', () => {
    expect(cli(['archive-shared-age', join(storeDir, 'no-such.db')]).stdout).toBe('unknown\n')

    // the live side: a shared token enrolled by rotate-shared
    expect(cli(['rotate-shared']).status).toBe(0)
    const archive = (createdAt: number): string => {
      const path = join(storeDir, `archive-${createdAt}.db`)
      const a = new Database(path)
      a.exec('CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, token_hash TEXT, name TEXT, created_at INTEGER, revoked_at INTEGER)')
      a.prepare("INSERT INTO api_tokens (token_hash, name, created_at, revoked_at) VALUES ('h', 'dashboard', ?, NULL)").run(createdAt)
      a.close()
      return path
    }
    expect(cli(['archive-shared-age', archive(1)]).stdout).toBe('predates\n')
    expect(cli(['archive-shared-age', archive(Math.floor(Date.now() / 1000) + 3600)]).stdout).toBe('current\n')
    writeFileSync(join(storeDir, 'not-a-database.db'), 'not sqlite')
    expect(cli(['archive-shared-age', join(storeDir, 'not-a-database.db')]).stdout).toBe('unknown\n')
  }, 120_000)

  it('no command, an unknown command and a missing argument exit 2 with the usage text', () => {
    for (const args of [[], ['bogus'], ['revoke'], ['archive-shared-age']]) {
      const r = cli(args)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.stderr).toContain('Usage:')
      expect(r.stdout).toBe('')
    }
  }, 60_000)
})

// `npm run agent-tokens` on a PostgreSQL install, as child processes: the real scripts/agent-tokens.ts, directly and through
// scripts/with-config.ts (the form of the npm script), with the application URL in the environment and a throw-away store
// directory. The script loads the config snapshot first and imports its body after it (config.ts reads the snapshot at import
// on PostgreSQL); a run that exits 0 proves the entry works on PostgreSQL. The in-process cells are in agent-tokens-cli.pg.test.ts.
//
// Also pinned here, because only separate processes can show them: several runs at once for the same token name end with
// exactly one active row (the advisory lock and the transaction of the writer), and the token value reaches neither stream
// of a real process.
//
// Neutral fixtures only. The store is a throwaway directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const ROOT = join(__dirname, '..', '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let db: PgTestDb
let storeDir: string
let envDir: string

beforeAll(async () => {
  db = await createPgTestDb()
  storeDir = mkdtempSync(join(tmpdir(), 'at-pg-script-'))
  envDir = mkdtempSync(join(tmpdir(), 'at-pg-script-env-'))
})
afterAll(async () => {
  await db.close()
  rmSync(storeDir, { recursive: true, force: true })
  rmSync(envDir, { recursive: true, force: true })
})

/** One run of a real entry; the environment carries the application URL, never the owner URL, and no shared token. */
function cli(entry: string[], args: string[], pgUrl: string = db.appUrl) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MARVEEN_STORE_DIR: storeDir, MARVEEN_PG_URL: pgUrl, CLAUDECLAW_ENV_DIR: envDir, DASHBOARD_TOKEN: '' }
    delete env['MARVEEN_PG_MIGRATE_URL']
    const p = spawn(TSX, [...entry, ...args], { cwd: ROOT, env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (status) => resolve({ status, stdout, stderr }))
    p.stdin.end()
  })
}

const DIRECT = ['scripts/agent-tokens.ts']
const RUNNER = ['scripts/with-config.ts', 'agent-tokens']
const operatorFile = () => join(storeDir, '.operator-token')

describe('npm run agent-tokens on PostgreSQL (the real script, a child process)', () => {
  it.each([['directly', DIRECT], ['through scripts/with-config.ts', RUNNER]])('issue-operator, check and list run against the database %s, exit codes as before', async (_name, entry) => {
    const issued = await cli(entry, ['issue-operator'])
    expect(issued.status, issued.stderr).toBe(0)
    expect(issued.stdout).toMatch(/^operator\t(issued|kept)\tadmin\t.*\.operator-token\n$/)
    // the run's info line goes to stderr: the backend, the verb and a count, nothing else
    expect(issued.stderr).toContain('agent-tokens: run')

    // stdout is the result and nothing else (the boot logs stay on stderr); the dashboard and the agents have no file here,
    // so `check` of a name that has no file is a finding: exit 1
    const checked = await cli(entry, ['check', 'agent-without-file'])
    expect(checked.status, checked.stderr).toBe(1)
    for (const line of checked.stdout.trim().split('\n')) expect(line.split('\t')).toHaveLength(4)
    expect(checked.stdout).toContain('agent-without-file\tmissing\tfleet_agent\t')
    expect(checked.stdout).toContain('operator\tok\tadmin\t')

    const listed = await cli(entry, ['list'])
    expect(listed.status, listed.stderr).toBe(0)
    expect(listed.stdout).toMatch(/\toperator\tadmin\t-\tdefault\t/)
  }, 180_000)

  it('the token value reaches neither stream of a real process', async () => {
    const raw = readFileSync(operatorFile(), 'utf-8').trim()
    for (const args of [['issue-operator'], ['issue-operator', '--rotate'], ['list'], ['check', 'agent-without-file']]) {
      const r = await cli(DIRECT, args)
      for (const s of [r.stdout, r.stderr]) {
        expect(s).not.toContain(readFileSync(operatorFile(), 'utf-8').trim())
        expect(s).not.toContain(raw)
        expect(s).not.toContain(sha(raw))
        expect(s).not.toContain(sha(readFileSync(operatorFile(), 'utf-8').trim()))
      }
    }
  }, 180_000)

  it('four runs at once for the same token name end with exactly one active row, and every run exits 0', async () => {
    const runs = await Promise.all([1, 2, 3, 4].map(() => cli(DIRECT, ['issue-operator', '--rotate'])))
    for (const r of runs) expect(r.status, r.stderr).toBe(0)
    const active = (await db.pool.query("SELECT id FROM api_tokens WHERE name = 'operator' AND revoked_at IS NULL")).rows
    expect(active).toHaveLength(1)
  }, 180_000)

  it('a failed config snapshot load is one Error line on stderr and exit 1, with no stack trace', async () => {
    // nothing listens on port 1: the snapshot load fails before the body is imported
    const out = await cli(DIRECT, ['list'], 'postgres://marveen_app@127.0.0.1:1/marveen')
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/^Error: /m)
    expect(out.stderr).not.toMatch(/^\s+at /m)
  }, 180_000)

  it('a usage error exits 2 and prints the usage on stderr', async () => {
    const none = await cli(DIRECT, [])
    expect(none.status).toBe(2)
    expect(none.stderr).toContain('Usage:')
    const bad = await cli(DIRECT, ['revoke'])
    expect(bad.status).toBe(2)
  }, 180_000)
})

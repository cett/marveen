// `npm run dashboard-user` on a PostgreSQL install, as a child process: the real scripts/dashboard-user.ts, with the
// application URL in its environment and a throw-away store directory. The script loads the config snapshot first and imports
// its body after it (config.ts reads the snapshot at import on PostgreSQL). Without that order the child fails at the import
// with ConfigSnapshotMissingError, so a run that exits 0 proves the entry works on PostgreSQL.
//
// Neutral fixtures only (person-a). The password is a throw-away fixture of this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { verifyPassword } from '../../web/password-hash.js'

const ROOT = join(__dirname, '..', '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PASSWORD = 'a-long-test-password-1'
const NEW_PASSWORD = 'another-long-password-2'

let db: PgTestDb
let storeDir: string

beforeAll(async () => {
  db = await createPgTestDb()
  storeDir = mkdtempSync(join(tmpdir(), 'du-pg-script-'))
})
afterAll(async () => {
  await db.close()
  rmSync(storeDir, { recursive: true, force: true })
})

/** One run of the real script; the environment carries the application URL, never the owner URL. */
function cli(args: string[], stdin = '', pgUrl: string = db.appUrl) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MARVEEN_STORE_DIR: storeDir, MARVEEN_PG_URL: pgUrl }
    delete env['MARVEEN_PG_MIGRATE_URL']
    const p = spawn(TSX, ['scripts/dashboard-user.ts', ...args], { cwd: ROOT, env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (status) => resolve({ status, stdout, stderr }))
    p.stdin.write(stdin)
    p.stdin.end()
  })
}

describe('npm run dashboard-user on PostgreSQL (the real script, a child process)', () => {
  it('add, list and reset-password run against the database, exit 0, and the stored hash is the new password', async () => {
    const added = await cli(['add', 'person-a', '--password-stdin'], PASSWORD)
    expect(added.status, added.stderr).toBe(0)
    expect(added.stdout).toBe('Created dashboard login "person-a".\n')
    // the run's info line goes to stderr and names the backend and the number of users seen, not the users
    expect(added.stderr).toContain('dashboard-user: run')
    expect(added.stderr).not.toContain(PASSWORD)

    const listed = await cli(['list'])
    expect(listed.status, listed.stderr).toBe(0)
    // stdout is the listing and nothing else (the boot logs stay on stderr)
    expect(listed.stdout.trim().split('\n')).toHaveLength(1)
    expect(listed.stdout).toMatch(/^person-a {2}role=admin {2}tenant=global {2}created /)

    const reset = await cli(['reset-password', 'person-a', '--password-stdin'], NEW_PASSWORD)
    expect(reset.status, reset.stderr).toBe(0)
    expect(reset.stdout).toContain('Password reset for "person-a"')

    const stored = (await db.pool.query("SELECT password_hash FROM dashboard_users WHERE username = 'person-a'")).rows[0].password_hash as string
    expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true)
    expect(await verifyPassword(PASSWORD, stored)).toBe(false)
  }, 180_000)

  it('a failed config snapshot load is one Error line on stderr and exit 1, with no stack trace', async () => {
    // nothing listens on port 1: the snapshot load fails before the body is imported
    const out = await cli(['list'], '', 'postgres://marveen_app@127.0.0.1:1/marveen')
    expect(out.status).toBe(1)
    expect(out.stderr).toMatch(/^Error: /m)
    expect(out.stderr).not.toMatch(/^\s+at /m)
  }, 180_000)

  it('a usage error exits 2 and prints the usage on stderr', async () => {
    const out = await cli([])
    expect(out.status).toBe(2)
    expect(out.stderr).toContain('Usage:')
  }, 180_000)
})

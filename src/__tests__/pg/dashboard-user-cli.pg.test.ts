// The dashboard-user break-glass CLI on PostgreSQL as the APPLICATION role (scripts/dashboard-user.ts -> src/dashboard-user/cli.ts).
//
// The CLI runs the whole command inside the system job `dashboard-user-cli`. Without that context row-level security shows an
// empty context zero dashboard users, zero auth sessions and zero device keys, and the commands answer blind:
//
//   - `list` prints "No dashboard users (token-only mode)" for a table that has users;
//   - `reset-password` says "not found";
//   - `security:reset` counts zero device keys;
//   - `add` sees an empty table, so its first-user election would pick the admin role, but the row-level policy refuses the
//     row (an error, nothing written): the wrong outcome is refused, not silent.
//
// The cells show both sides: under the job (green) the commands see and change the rows; a read without it (red, the same
// data) gives the blind answers above, so a removed wrapper is caught here.
//
// Also pinned: the exit codes (0 ok, 1 failed, 2 usage) with the pool ended in each case, the boot never migrates (even with
// a migrate URL set), the audit row and the channel ping of the break-glass paths, and the facade call that the dashboard's
// session check relies on (touchAuthSessionLastSeen returns the real row count on PostgreSQL).
//
// Neutral fixtures only (user-a, user-b, device-a). The store is a throwaway directory.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { createPgTestDb, PG_TEST_APP_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'

const { TMP_STORE, ping } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'dashboard-user-pg-'))
  const store = join(root, 'store')
  mkdirSync(store, { recursive: true })
  return { TMP_STORE: store, ping: vi.fn((_text: string) => Promise.resolve()) }
})

vi.mock('../../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../paths.js')>()), STORE_DIR: TMP_STORE }))
vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../config.js')>()), STORE_DIR: TMP_STORE }))
// the channel ping of the break-glass paths: the call is what the cells pin; the rest of the notifier is untouched
vi.mock('../../notify.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../notify.js')>()), notifySecurityEvent: ping }))
// the second revoke of `remove` is measured with a hook: a session written by another connection between the first revoke and
// the delete (the cell arms it; the wrapper calls it once, after the real revoke returns)
const { revokeHook } = vi.hoisted(() => ({ revokeHook: { run: undefined as undefined | (() => Promise<void>) } }))
vi.mock('../../web/auth-sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/auth-sessions.js')>()
  return {
    ...real,
    revokeAllForUser: async (userId: number, exceptCookieValue?: string | null) => {
      await real.revokeAllForUser(userId, exceptCookieValue)
      const again = revokeHook.run
      revokeHook.run = undefined
      if (again) await again()
    },
  }
})
vi.mock('../../db-migrations-pg.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db-migrations-pg.js')>()
  return { ...real, applyPgMigrations: vi.fn(real.applyPgMigrations) }
})

import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { resetPgCredentialCaptureForTests } from '../../db/pg/url.js'
import { runDashboardUserCli, type CliIo } from '../../dashboard-user/cli.js'
import { createDashboardUser, getDashboardUser, listDashboardUsers, touchAuthSessionLastSeen } from '../../db.js'
import { deleteAllDeviceKeys } from '../../db/device-keys.js'
import { systemJob } from '../../db/background-jobs.js'
import { applyPgMigrations } from '../../db-migrations-pg.js'
import { hashPassword, verifyPassword } from '../../web/password-hash.js'
import { logger } from '../../logger.js'

const PASSWORD = 'a-long-test-password-1'
const NEW_PASSWORD = 'another-long-password-2'

const made: PgTestDb[] = []

afterAll(async () => {
  for (const d of made) await d.close()
  rmSync(TMP_STORE, { recursive: true, force: true })
})
afterEach(async () => {
  await closePgBackend()
  vi.unstubAllEnvs()
  resetPgCredentialCaptureForTests()
  revokeHook.run = undefined
  vi.clearAllMocks()
})

/** A database with the application URL in the environment (what the CLI boots on). */
async function freshDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  vi.stubEnv('MARVEEN_PG_URL', db.appUrl)
  return db
}

/** The streams of one run: stdout and stderr collected, the stdin and the prompt answers given. */
function capture(stdin = '', prompts: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    stdout: (t) => { out.push(t) },
    stderr: (t) => { err.push(t) },
    readStdin: () => Promise.resolve(stdin),
    promptHidden: () => {
      const answer = prompts.shift()
      if (answer === undefined) return Promise.reject(new Error('no prompt answer left'))
      return Promise.resolve(answer)
    },
  }
  return { io, stdout: () => out.join(''), stderr: () => err.join('') }
}

// Fixtures are written by the owner of the test server (the superuser pool bypasses row-level security): the cells test the
// CLI, not the fixtures.
async function seedUser(db: PgTestDb, username: string, role: 'admin' | 'viewer'): Promise<number> {
  const hash = await hashPassword(PASSWORD)
  const r = await db.pool.query(
    'INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id) VALUES ($1, $2, 1, 1, $3, NULL) RETURNING id',
    [username, hash, role],
  )
  return Number(r.rows[0].id)
}

async function seedSessions(db: PgTestDb, userId: number, username: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await db.pool.query('INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ($1, $2, $3, 1, 1)', [`hash-${username}-${i}`, userId, username])
  }
}

async function seedDeviceKeys(db: PgTestDb, names: string[]): Promise<void> {
  for (const name of names) {
    await db.pool.query("INSERT INTO device_keys (key_hash, name, created_at, tenant_id) VALUES ($1, $2, 1, 'default')", [`key-${name}`, name])
  }
}

const countOf = async (db: PgTestDb, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.pool.query(sql, params)).rows[0].n)

/** The number of connections the application role holds, polled until it settles (the pool ends asynchronously). */
async function appConnections(db: PgTestDb): Promise<number> {
  let n = -1
  for (let i = 0; i < 40; i++) {
    n = await countOf(db, 'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [PG_TEST_APP_ROLE])
    if (n === 0) return 0
    await new Promise((r) => setTimeout(r, 50))
  }
  return n
}

describe('add: the first login is the global admin, the next ones are viewers', () => {
  it('the first user is admin with no tenant, the second is a viewer, and a name taken in any case is refused with exit 1', async () => {
    const db = await freshDb()

    const first = capture(PASSWORD)
    expect(await runDashboardUserCli(['add', 'user-a', '--password-stdin'], first.io)).toBe(0)
    expect(first.stdout()).toBe('Created dashboard login "user-a".\n')

    const second = capture(PASSWORD)
    expect(await runDashboardUserCli(['add', 'user-b', '--password-stdin'], second.io)).toBe(0)

    const rows = (await db.pool.query('SELECT username, role, tenant_id FROM dashboard_users ORDER BY id')).rows
    expect(rows).toEqual([
      { username: 'user-a', role: 'admin', tenant_id: null },
      { username: 'user-b', role: 'viewer', tenant_id: null },
    ])

    const again = capture(PASSWORD)
    expect(await runDashboardUserCli(['add', 'USER-A', '--password-stdin'], again.io)).toBe(1)
    expect(again.stderr()).toContain('already exists')
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM dashboard_users')).toBe(2)
  })
})

describe('reset-password: the new password, the sessions of that user, one audit row, one ping', () => {
  it('the new hash verifies and the old one does not, the sessions of that user are gone and the other user keeps its own', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedUser(db, 'user-b', 'viewer')
    await seedSessions(db, a, 'user-a', 2)
    await seedSessions(db, Number((await db.pool.query("SELECT id FROM dashboard_users WHERE username = 'user-b'")).rows[0].id), 'user-b', 2)

    const run = capture(NEW_PASSWORD)
    expect(await runDashboardUserCli(['reset-password', 'user-a', '--password-stdin'], run.io)).toBe(0)
    expect(run.stdout()).toBe('Password reset for "user-a"; all their sessions were revoked.\n')

    const stored = (await db.pool.query("SELECT password_hash FROM dashboard_users WHERE username = 'user-a'")).rows[0].password_hash as string
    expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true)
    expect(await verifyPassword(PASSWORD, stored)).toBe(false)

    expect(await countOf(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE username = 'user-a'")).toBe(0)
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE username = 'user-b'")).toBe(2)
  })

  it('leaves exactly one break-glass audit row, actor cli, with no hash and no password in it', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')
    const stored = (await db.pool.query("SELECT password_hash FROM dashboard_users WHERE username = 'user-a'")).rows[0].password_hash as string

    expect(await runDashboardUserCli(['reset-password', 'user-a', '--password-stdin'], capture(NEW_PASSWORD).io)).toBe(0)

    const rows = (await db.pool.query("SELECT key, old_value, new_value, actor FROM config_change_log WHERE key = 'security.break_glass_password_reset'")).rows
    expect(rows).toEqual([{ key: 'security.break_glass_password_reset', old_value: null, new_value: 'user-a', actor: 'cli' }])
    const text = JSON.stringify(rows)
    expect(text).not.toContain(stored)
    expect(text).not.toContain(NEW_PASSWORD)
  })

  it('pings the channel once, with the username (the notifier is the mock: the call is what is pinned here)', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')

    expect(await runDashboardUserCli(['reset-password', 'user-a', '--password-stdin'], capture(NEW_PASSWORD).io)).toBe(0)

    expect(ping).toHaveBeenCalledTimes(1)
    expect(ping.mock.calls[0]![0]).toContain('"user-a"')
  })
})

describe('list, remove and sessions:clear', () => {
  it('list names each login with its role and tenant; remove deletes the login and its sessions and says when none is left', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    const b = await seedUser(db, 'user-b', 'viewer')
    await seedSessions(db, a, 'user-a', 2)
    await seedSessions(db, b, 'user-b', 2)

    const listed = capture()
    expect(await runDashboardUserCli(['list'], listed.io)).toBe(0)
    expect(listed.stdout()).toMatch(/^user-a {2}role=admin {2}tenant=global {2}created /m)
    expect(listed.stdout()).toMatch(/^user-b {2}role=viewer {2}tenant=global {2}created /m)

    const removedB = capture()
    expect(await runDashboardUserCli(['remove', 'user-b'], removedB.io)).toBe(0)
    expect(removedB.stdout()).toBe('Removed "user-b".\n')
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE username = 'user-b'")).toBe(0)
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE username = 'user-a'")).toBe(2)

    const removedA = capture()
    expect(await runDashboardUserCli(['remove', 'user-a'], removedA.io)).toBe(0)
    expect(removedA.stdout()).toBe('Removed "user-a". No users left -- back to token-only mode.\n')
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM dashboard_users')).toBe(0)
  })

  it('sessions:clear with a user clears that user only; without one it clears every session', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    const b = await seedUser(db, 'user-b', 'viewer')
    await seedSessions(db, a, 'user-a', 2)
    await seedSessions(db, b, 'user-b', 2)

    const one = capture()
    expect(await runDashboardUserCli(['sessions:clear', 'user-a'], one.io)).toBe(0)
    expect(one.stdout()).toBe('Cleared all sessions for "user-a".\n')
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM auth_sessions')).toBe(2)

    const all = capture()
    expect(await runDashboardUserCli(['sessions:clear'], all.io)).toBe(0)
    expect(all.stdout()).toBe('Cleared ALL dashboard login sessions.\n')
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM auth_sessions')).toBe(0)
  })

  it('names an unknown user, exits 1 and deletes nothing', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedSessions(db, a, 'user-a', 2)

    const out = capture()
    expect(await runDashboardUserCli(['sessions:clear', 'nobody'], out.io)).toBe(1)
    expect(out.stderr()).toContain('User "nobody" not found.')
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM auth_sessions')).toBe(2)
  })
})

describe('security:reset: every device key and every session, one audit row, one ping', () => {
  it('revokes the device keys and clears the sessions, counts the real rows, writes one audit row and pings once', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedSessions(db, a, 'user-a', 2)
    await seedDeviceKeys(db, ['device-a', 'device-b'])

    const out = capture()
    expect(await runDashboardUserCli(['security:reset'], out.io)).toBe(0)
    expect(out.stdout()).toContain('Security reset done: 2 device key(s) revoked, 2 browser session(s) cleared.')

    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM device_keys')).toBe(0)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM auth_sessions')).toBe(0)
    const audit = (await db.pool.query("SELECT new_value, actor FROM config_change_log WHERE key = 'security.reset'")).rows
    expect(audit).toEqual([{ new_value: 'device_keys=2 sessions=2', actor: 'cli' }])
    expect(ping).toHaveBeenCalledTimes(1)
  })
})

// The red side: the same rows, read or changed without the system job. These are the answers a removed wrapper gives.
describe('without the system job the same rows are blind', () => {
  it('a read sees no dashboard user while the table has two, so list would say token-only mode and reset-password would say not found', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')
    await seedUser(db, 'user-b', 'viewer')
    await bootPgBackend({ migrateUrl: '' })

    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM dashboard_users')).toBe(2)
    expect(await listDashboardUsers()).toEqual([])
    expect(await getDashboardUser('user-a')).toBeUndefined()
  })

  it('the device-key revocation without the job removes nothing', async () => {
    const db = await freshDb()
    await seedDeviceKeys(db, ['device-a'])
    await bootPgBackend({ migrateUrl: '' })

    expect(await deleteAllDeviceKeys()).toBe(0)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM device_keys')).toBe(1)
  })

  it('the same list under the job sees both users (the green side of the same data)', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')
    await seedUser(db, 'user-b', 'viewer')

    const out = capture()
    expect(await runDashboardUserCli(['list'], out.io)).toBe(0)
    expect(out.stdout().trim().split('\n')).toHaveLength(2)
    expect(out.stdout()).not.toContain('token-only mode')
  })

  it('an add without the job sees an empty table, and the policy refuses its insert: nothing is written and no login becomes admin', async () => {
    // Measured on the harness: the election counts the table as empty (zero rows visible), so the insert would carry the admin
    // role, and the row-level policy refuses a row with no tenant from an empty context. The refusal is an error, not a silent
    // admin; the job is what makes the add work and count the real table. The cell pins the refusal, so a policy that let it
    // through would turn this test red.
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')
    await bootPgBackend({ migrateUrl: '' })
    const hash = await hashPassword(NEW_PASSWORD)

    await expect(createDashboardUser('user-c', hash)).rejects.toThrow(/row-level security/)
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM dashboard_users WHERE username = 'user-c'")).toBe(0)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM dashboard_users')).toBe(1)
  })
})

describe('the entry: exit codes, the pool ended in every case, the boot never migrates', () => {
  it('no command and an unknown command exit 2 with the usage text', async () => {
    await freshDb()
    const none = capture()
    expect(await runDashboardUserCli([], none.io)).toBe(2)
    expect(none.stderr()).toContain('Usage:')

    const unknown = capture()
    expect(await runDashboardUserCli(['bogus'], unknown.io)).toBe(2)
    expect(unknown.stderr()).toContain('Usage:')
  })

  it('a successful run exits 0 and leaves no connection of the application role open', async () => {
    const db = await freshDb()
    expect(await runDashboardUserCli(['list'], capture().io)).toBe(0)
    expect(await appConnections(db)).toBe(0)
  })

  it('a failing command after the boot exits 1 with the error, and still leaves no connection open', async () => {
    const db = await freshDb()
    const out = capture('short')
    expect(await runDashboardUserCli(['add', 'user-a', '--password-stdin'], out.io)).toBe(1)
    expect(out.stderr().length).toBeGreaterThan(0)
    expect(out.stdout()).toBe('')
    expect(await appConnections(db)).toBe(0)
  })

  it('a mismatch of the two typed passwords exits 1 and says so', async () => {
    await freshDb()
    const out = capture('', ['one-long-password-1', 'two-long-password-2'])
    expect(await runDashboardUserCli(['add', 'user-a'], out.io)).toBe(1)
    expect(out.stderr()).toContain('Passwords do not match.')
  })

  it('the boot never migrates, even with a migrate URL set in the environment', async () => {
    const db = await freshDb()
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', db.ownerUrl)

    expect(await runDashboardUserCli(['list'], capture().io)).toBe(0)
    expect(applyPgMigrations).not.toHaveBeenCalled()
  })
})

describe('audit rows and channel pings of the write verbs (a successful write only)', () => {
  const audit = async (db: PgTestDb, key: string) =>
    (await db.pool.query('SELECT new_value, actor FROM config_change_log WHERE key = $1 ORDER BY id', [key])).rows

  it('add, remove and sessions:clear (with and without a user) each write one audit row with the username or all, actor cli', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedSessions(db, a, 'user-a', 2)

    expect(await runDashboardUserCli(['add', 'user-b', '--password-stdin'], capture(PASSWORD).io)).toBe(0)
    expect(await audit(db, 'security.cli_user_add')).toEqual([{ new_value: 'user-b', actor: 'cli' }])

    expect(await runDashboardUserCli(['sessions:clear', 'user-a'], capture().io)).toBe(0)
    expect(await audit(db, 'security.cli_sessions_clear')).toEqual([{ new_value: 'user-a', actor: 'cli' }])

    expect(await runDashboardUserCli(['sessions:clear'], capture().io)).toBe(0)
    expect(await audit(db, 'security.cli_sessions_clear')).toEqual([
      { new_value: 'user-a', actor: 'cli' },
      { new_value: '(all)', actor: 'cli' },
    ])

    expect(await runDashboardUserCli(['remove', 'user-b'], capture().io)).toBe(0)
    expect(await audit(db, 'security.cli_user_remove')).toEqual([{ new_value: 'user-b', actor: 'cli' }])

    // each successful write pings once, after its audit row (the ping text names the user, or all sessions)
    expect(ping).toHaveBeenCalledTimes(4)
    expect(ping.mock.calls[0]![0]).toContain('"user-b"')
    expect(ping.mock.calls[1]![0]).toContain('"user-a"')
    expect(ping.mock.calls[2]![0]).toContain('CLI-ből')
    expect(ping.mock.calls[3]![0]).toContain('"user-b"')
  })

  it('a failed command (an unknown user) writes no audit row and sends no ping', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')

    expect(await runDashboardUserCli(['remove', 'nobody'], capture().io)).toBe(1)
    expect(await audit(db, 'security.cli_user_remove')).toEqual([])
    expect(ping).not.toHaveBeenCalled()
  })

  it('a failed add (a name taken) sends no ping', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')

    expect(await runDashboardUserCli(['add', 'user-a', '--password-stdin'], capture(PASSWORD).io)).toBe(1)
    expect(await audit(db, 'security.cli_user_add')).toEqual([])
    expect(ping).not.toHaveBeenCalled()
  })
})

describe('the alert follows the write even when its audit row fails (the exit code is still 1)', () => {
  // the audit table refuses every insert: a trigger in the test database, made by the owner of the server
  async function refuseAudit(db: PgTestDb): Promise<void> {
    await db.pool.query("CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused (test)'; END $$")
    await db.pool.query('CREATE TRIGGER refuse_audit BEFORE INSERT ON config_change_log FOR EACH ROW EXECUTE FUNCTION refuse_audit()')
  }

  it('add: the login exists, the audit write fails (exit 1), the alert still goes out once', async () => {
    const db = await freshDb()
    await refuseAudit(db)

    const out = capture(PASSWORD)
    expect(await runDashboardUserCli(['add', 'user-a', '--password-stdin'], out.io)).toBe(1)
    expect(out.stderr()).toContain('audit refused (test)')
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM dashboard_users WHERE username = 'user-a'")).toBe(1)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(ping.mock.calls[0]![0]).toContain('"user-a"')
  })

  it('reset-password: the hash changed, the audit write fails (exit 1), the alert still goes out once', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')
    await refuseAudit(db)

    expect(await runDashboardUserCli(['reset-password', 'user-a', '--password-stdin'], capture(NEW_PASSWORD).io)).toBe(1)
    const stored = (await db.pool.query("SELECT password_hash FROM dashboard_users WHERE username = 'user-a'")).rows[0].password_hash as string
    expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('remove: the login is gone, the audit write fails (exit 1), the alert still goes out once', async () => {
    const db = await freshDb()
    await seedUser(db, 'user-a', 'admin')
    await refuseAudit(db)

    expect(await runDashboardUserCli(['remove', 'user-a'], capture().io)).toBe(1)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM dashboard_users')).toBe(0)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('sessions:clear with a user: the sessions are gone, the audit write fails (exit 1), the alert still goes out once', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedSessions(db, a, 'user-a', 2)
    await refuseAudit(db)

    expect(await runDashboardUserCli(['sessions:clear', 'user-a'], capture().io)).toBe(1)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM auth_sessions')).toBe(0)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('security:reset: the revocations happened, the audit write fails (exit 1), the alert with the counts still goes out once', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedSessions(db, a, 'user-a', 2)
    await seedDeviceKeys(db, ['device-a', 'device-b'])
    await refuseAudit(db)

    expect(await runDashboardUserCli(['security:reset'], capture().io)).toBe(1)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM device_keys')).toBe(0)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(ping.mock.calls[0]![0]).toContain('2 eszközkulcs visszavonva')
  })
})

describe('the info line names a known verb only', () => {
  it('an unknown first argument is logged as unknown, and the text of the argument reaches no log line', async () => {
    await freshDb()
    const info = vi.spyOn(logger, 'info')
    const secret = 'Typed-Secret-Value-42'

    expect(await runDashboardUserCli([secret], capture().io)).toBe(2)

    const runLines = info.mock.calls.filter((c) => c[1] === 'dashboard-user: run')
    expect(runLines).toHaveLength(1)
    expect((runLines[0]![0] as { command: string }).command).toBe('unknown')
    expect(JSON.stringify(info.mock.calls)).not.toContain(secret)
    info.mockRestore()
  })

  it('a known verb is logged as itself', async () => {
    await freshDb()
    const info = vi.spyOn(logger, 'info')

    expect(await runDashboardUserCli(['list'], capture().io)).toBe(0)

    const runLines = info.mock.calls.filter((c) => c[1] === 'dashboard-user: run')
    expect((runLines[0]![0] as { command: string }).command).toBe('list')
    info.mockRestore()
  })
})

describe('remove closes the window between its two steps (no cascade from auth_sessions)', () => {
  it('a session that another connection writes between the first revoke and the delete is gone after remove', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await seedSessions(db, a, 'user-a', 1)
    revokeHook.run = () => db.pool.query("INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('hash-between', $1, 'user-a', 1, 1)", [a]).then(() => undefined)

    expect(await runDashboardUserCli(['remove', 'user-a'], capture().io)).toBe(0)

    expect(await countOf(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE username = 'user-a'")).toBe(0)
  })

  it('measured: auth_sessions has no foreign key on PostgreSQL (the reason for the second revoke)', async () => {
    const db = await freshDb()
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM pg_constraint WHERE conrelid = 'auth_sessions'::regclass AND contype = 'f'")).toBe(0)
  })
})

describe('the facade call the dashboard session check relies on', () => {
  it('touchAuthSessionLastSeen returns 1 for a live session row and 0 for one another connection deleted', async () => {
    const db = await freshDb()
    const a = await seedUser(db, 'user-a', 'admin')
    await db.pool.query("INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('hash-live', $1, 'user-a', 1, 1)", [a])
    await bootPgBackend({ migrateUrl: '' })

    const touch = systemJob('dashboard-user-cli', (hash: string) => touchAuthSessionLastSeen(hash, 100))
    expect(await touch('hash-live')).toBe(1)

    await db.pool.query("DELETE FROM auth_sessions WHERE id_hash = 'hash-live'")
    expect(await touch('hash-live')).toBe(0)
  })
})

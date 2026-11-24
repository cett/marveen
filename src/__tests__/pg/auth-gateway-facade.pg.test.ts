// The login-path facade functions on PostgreSQL through the APP role with real contexts (migration 0009): in the public
// context the two auth tables read as empty and the four facade functions still work; the counts are the same in every
// context; a login session is written in a context that carries another user's id (the cookie edge); a tenant cannot read
// another user's password hash directly. The admin pool is the oracle ("the row exists" before every "sees nothing").
// `npm run test:pg`. Fixtures are neutral.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { runAs, withDbContext } from '../../db/context.js'
import { dbx } from '../../db.js'
import { countDashboardUsers, deleteAuthSessionByHash, getAuthSessionByHash, getLoginUser, insertAuthSession } from '../../db/sessions.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

let db: PgTestDb
let idA = 0 // the id of User-A in the current test (the sequence moves on, so never a literal)
beforeAll(async () => {
  db = await createPgTestDb()
  setBackend(db.appDbx(), 'pg') // the facade now runs as the app role: row-level security binds every call
})
afterAll(async () => {
  setBackend(null)
  await db.close()
})
beforeEach(async () => {
  await db.pool.query('DELETE FROM auth_sessions')
  await db.pool.query('DELETE FROM dashboard_users')
  await db.pool.query(`INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at, disabled) VALUES
    ('User-A', 'hash-a', 'viewer', 'tenant-a', 1, 1, 0), ('user-b', 'hash-b', 'viewer', 'tenant-b', 1, 1, 0), ('user-off', 'hash-off', 'viewer', NULL, 1, 1, 1)`)
  idA = Number((await db.pool.query("SELECT id FROM dashboard_users WHERE username = 'User-A'")).rows[0].id)
})
afterEach(() => undefined)

const PUBLIC = <T>(fn: () => Promise<T>): Promise<T> => runAs.public('http-public', fn)
const oracleSessions = async (): Promise<string[]> => (await db.pool.query<{ id_hash: string }>('SELECT id_hash FROM auth_sessions ORDER BY id_hash')).rows.map((r) => r.id_hash)

describe('the public context', () => {
  it('reads nothing of the two tables directly (the oracle shows the rows), yet the four facade functions work', async () => {
    await db.pool.query("INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('hash-seed', $1, 'User-A', 1, 1)", [idA])
    expect((await db.pool.query('SELECT 1 FROM dashboard_users')).rowCount).toBe(3) // the oracle
    expect((await db.pool.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(1)
    await PUBLIC(async () => {
      expect(await dbx.all('SELECT 1 FROM dashboard_users')).toEqual([])
      expect(await dbx.all('SELECT 1 FROM auth_sessions')).toEqual([])
      expect(await getLoginUser('user-a')).toEqual({ id: expect.any(Number), username: 'User-A', password_hash: 'hash-a', disabled: 0 })
      expect(await countDashboardUsers(false)).toBe(2)
      expect(await countDashboardUsers(true)).toBe(3)
      await insertAuthSession('hash-new', idA, 'User-A', 5, 'ua', 'https')
      await deleteAuthSessionByHash('hash-seed')
    })
    expect(await oracleSessions()).toEqual(['hash-new']) // the create landed, the revoke removed the seeded one
  })

  it('cannot write the tables directly (42501), neither an insert nor a delete', async () => {
    await expect(PUBLIC(() => dbx.run("INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at) VALUES ('direct', 1, 'x', 1, 1)")))
      .rejects.toMatchObject({ code: '42501' })
    expect((await db.pool.query("SELECT 1 FROM auth_sessions WHERE id_hash = 'direct'")).rowCount).toBe(0)
  })
})

describe('countDashboardUsers gives the same answer to every caller', () => {
  it('a tenant context, an admin context and the oracle agree (a direct count would give a tenant only the users of its own tenant)', async () => {
    const oracle = (await db.pool.query<{ e: number; t: number }>('SELECT count(*) FILTER (WHERE disabled = 0)::int AS e, count(*)::int AS t FROM dashboard_users')).rows[0]
    expect(oracle).toEqual({ e: 2, t: 3 })
    const both = async (): Promise<[number, number]> => [await countDashboardUsers(false), await countDashboardUsers(true)]
    expect(await runAs.tenant('tenant-a', both)).toEqual([2, 3])
    expect(await runAs.admin('http-admin', both)).toEqual([2, 3])
    expect(await runAs.agent('agent-a', 'tenant-b', both)).toEqual([2, 3])
    expect(await withDbContext({ role: 'viewer', name: 'http-global-viewer', userId: '999' }, both)).toEqual([2, 3])
  })
})

describe('the login session write', () => {
  it('works in a context that carries ANOTHER user\'s id (the cookie edge), and the session is the one written', async () => {
    await withDbContext({ role: 'viewer', name: 'http-global-viewer', userId: '999' }, async () => {
      await insertAuthSession('hash-edge', idA, 'User-A', 7, null, 'loopback')
      await deleteAuthSessionByHash('hash-never-existed')
    })
    expect(await oracleSessions()).toEqual(['hash-edge'])
    // read back through the facade as the user whose session it is (the own-row policy), not as anybody else
    const own = await withDbContext({ role: 'viewer', name: 'http-global-viewer', userId: String(idA) }, () => getAuthSessionByHash('hash-edge'))
    const other = await withDbContext({ role: 'viewer', name: 'http-global-viewer', userId: '999' }, () => getAuthSessionByHash('hash-edge'))
    expect(own).toEqual({ user_id: idA, username: 'User-A', created_at: 7, last_seen_at: 7 })
    expect(other).toBeUndefined()
  })
})

describe('the facade call is refused for an id and name that do not belong together', () => {
  it('insertAuthSession with a user id and a name of different users, an unknown id or a disabled user creates NO session (28000), from every context', async () => {
    const idOff = Number((await db.pool.query("SELECT id FROM dashboard_users WHERE username = 'user-off'")).rows[0].id)
    const idB = Number((await db.pool.query("SELECT id FROM dashboard_users WHERE username = 'user-b'")).rows[0].id)
    const attempts: Array<[string, number, string]> = [
      ['id of one user, name of another', idA, 'user-b'],
      ['id of another user, name of the first', idB, 'User-A'],
      ['unknown id', 987654321, 'User-A'],
      ['a disabled user, id and name matching', idOff, 'user-off'],
    ]
    for (const [label, id, name] of attempts) {
      await expect(PUBLIC(() => insertAuthSession('hash-bad', id, name, 5, null, null)), label).rejects.toMatchObject({ code: '28000' })
      await expect(runAs.tenant('tenant-a', () => insertAuthSession('hash-bad', id, name, 5, null, null)), label).rejects.toMatchObject({ code: '28000' })
    }
    expect(await oracleSessions()).toEqual([]) // nothing was written
    await PUBLIC(() => insertAuthSession('hash-ok', idB, 'user-b', 5, null, null)) // construction: the matching pair works
    expect(await oracleSessions()).toEqual(['hash-ok'])
  })
})

describe('a tenant context', () => {
  it('reads the users of its own tenant only: not another tenant\'s password hash, not a tenant-less user', async () => {
    // dashboard_users is the tenant shape (B) plus the own row: a tenant context sees the users stamped with its tenant
    expect(await runAs.tenant('tenant-a', () => dbx.all<{ username: string }>('SELECT username FROM dashboard_users ORDER BY username'))).toEqual([{ username: 'User-A' }])
    expect(await runAs.tenant('tenant-a', () => dbx.all('SELECT password_hash FROM dashboard_users WHERE username = ?', 'user-b'))).toEqual([]) // construction: the oracle has it
    expect((await db.pool.query("SELECT 1 FROM dashboard_users WHERE username = 'user-b'")).rowCount).toBe(1)
    expect(await runAs.tenant('tenant-a', () => dbx.all('SELECT 1 FROM dashboard_users WHERE username = ?', 'user-off'))).toEqual([]) // NULL tenant: privileged only
  })
})

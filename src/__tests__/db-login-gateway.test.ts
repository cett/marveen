// The login-path facade functions behave the same on both engines (this file runs on SQLite and, as a PORTED file, on
// PostgreSQL, where they go through the gateway functions of migration 0009): getLoginUser returns the four login columns,
// countDashboardUsers counts enabled and all users, insertAuthSession and deleteAuthSessionByHash write and remove a
// session. The row-level-security side (what the public and the tenant context can and cannot read around the gateway) is
// src/__tests__/pg/auth-gateway-facade.pg.test.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, countDashboardUsers, deleteAuthSessionByHash, getAuthSessionByHash, getLoginUser, insertAuthSession } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

async function seedUser(username: string, disabled: number, role = 'viewer'): Promise<void> {
  await dbx.run(
    'INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at, disabled) VALUES (?, ?, ?, NULL, 1, 1, ?)',
    username, `hash-of-${username}`, role, disabled,
  )
}

beforeEach(async () => {
  await dbx.run('DELETE FROM auth_sessions')
  await dbx.run('DELETE FROM dashboard_users')
})

describe('getLoginUser', () => {
  it('returns exactly the four login fields, found ignoring the case, with disabled as stored', async () => {
    await seedUser('User-A', 0, 'admin')
    await seedUser('user-off', 1)
    const a = await getLoginUser('user-a')
    expect(a).toEqual({ id: expect.any(Number), username: 'User-A', password_hash: 'hash-of-User-A', disabled: 0 })
    expect(Object.keys(a!).sort()).toEqual(['disabled', 'id', 'password_hash', 'username']) // no role, tenant, e-mail, timestamps
    expect(await getLoginUser('USER-A')).toEqual(a)
    expect(await getLoginUser('user-off')).toMatchObject({ username: 'user-off', disabled: 1 }) // the route, not the lookup, refuses it
  })

  it('answers undefined for an unknown name and for a name that could be a pattern or empty', async () => {
    await seedUser('User-A', 0)
    for (const name of ['nobody', '%', '_', 'user-%', '', 'x'.repeat(10 * 1024)]) {
      expect(await getLoginUser(name), name.slice(0, 8)).toBeUndefined()
    }
  })
})

describe('countDashboardUsers', () => {
  it('counts the enabled users, or all of them, with a disabled user among them', async () => {
    expect(await countDashboardUsers(false)).toBe(0)
    expect(await countDashboardUsers(true)).toBe(0)
    await seedUser('user-a', 0)
    await seedUser('user-b', 0)
    await seedUser('user-off', 1)
    expect(await countDashboardUsers(false)).toBe(2)
    expect(await countDashboardUsers()).toBe(2) // the default is enabled only
    expect(await countDashboardUsers(true)).toBe(3)
  })
})

describe('the session write and revoke', () => {
  it('a created session reads back, and the revoke removes that one and only that one', async () => {
    await seedUser('User-A', 0)
    const u = (await getLoginUser('user-a'))!
    await insertAuthSession('hash-one', u.id, u.username, 100, 'agent-ua', 'https')
    await insertAuthSession('hash-two', u.id, u.username, 200, null, null)
    expect(await getAuthSessionByHash('hash-one')).toEqual({ user_id: u.id, username: 'User-A', created_at: 100, last_seen_at: 100 })
    expect(await getAuthSessionByHash('hash-two')).toMatchObject({ created_at: 200, last_seen_at: 200 }) // created and last seen are the same instant
    await deleteAuthSessionByHash('hash-one')
    expect(await getAuthSessionByHash('hash-one')).toBeUndefined()
    expect(await getAuthSessionByHash('hash-two')).toBeDefined()
    await deleteAuthSessionByHash('no-such-hash') // nothing to delete: no error
  })
})

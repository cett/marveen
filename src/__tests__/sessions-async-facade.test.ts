// The session / dashboard-user functions on the async facade: the statements that must stay ONE statement
// (a read before a write would let two overlapping calls both pass the check), and the callers that must
// await them (a missing await turns a Promise into a truthy value).

import { describe, it, expect } from 'vitest'
import {
  setSession, getSession, incrementSessionCount, createDashboardUser, listDashboardUsers, getDashboardUser,
  deleteDashboardUserKeepingLastAdmin, deleteDashboardUser, countDashboardUsers,
} from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

const { dbx } = useTestDb()

async function seedUser(username: string, role: string, disabled = 0): Promise<void> {
  await dbx.run(
    'INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at, disabled) VALUES (?, ?, ?, NULL, 1, 1, ?)',
    username, 'hash', role, disabled,
  )
}

const usernames = async (): Promise<string[]> => (await listDashboardUsers()).map((u) => u.username).sort()

describe('incrementSessionCount', () => {
  it('N overlapping calls hand out N different counts, 1..N', async () => {
    await setSession('chat-a', 'sess-1', 0)
    const counts = await Promise.all(Array.from({ length: 8 }, () => incrementSessionCount('chat-a')))
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect((await getSession('chat-a'))?.messageCount).toBe(8)
  })

  it('continues from the stored count', async () => {
    await setSession('chat-a', 'sess-1', 5)
    expect(await incrementSessionCount('chat-a')).toBe(6)
  })

  it('answers 0 for a chat without a session and creates none', async () => {
    expect(await incrementSessionCount('no-such-chat')).toBe(0)
    expect(await getSession('no-such-chat')).toBeUndefined()
  })
})

describe('createDashboardUser (first user wins)', () => {
  it('the first user is the global admin, the next one a viewer', async () => {
    const first = await createDashboardUser('first', 'h1')
    const second = await createDashboardUser('second', 'h2')
    expect([first.role, first.tenant_id]).toEqual(['admin', null])
    expect(second.role).toBe('viewer')
    expect((await getDashboardUser('first'))?.role).toBe('admin')
    expect((await getDashboardUser('second'))?.role).toBe('viewer')
  })

  it('two sign-ups started together on an empty table: exactly one admin, the other a viewer', async () => {
    const [a, b] = await Promise.all([createDashboardUser('user-a', 'h1'), createDashboardUser('user-b', 'h2')])
    expect([a.role, b.role].sort()).toEqual(['admin', 'viewer'])
    const rows = await dbx.all<{ username: string; role: string }>('SELECT username, role FROM dashboard_users')
    expect(rows.filter((r) => r.role === 'admin')).toHaveLength(1)
    // The returned role is the stored one, not a guess made before the insert.
    for (const u of [a, b]) expect(rows.find((r) => r.username === u.username)?.role).toBe(u.role)
  })

  it('many overlapping sign-ups still yield one admin', async () => {
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) => createDashboardUser(`user-${i}`, 'h')))
    expect(created.filter((u) => u.role === 'admin')).toHaveLength(1)
  })
})

describe('deleteDashboardUserKeepingLastAdmin', () => {
  it('two overlapping deletions of the only two admins: one goes, one is kept', async () => {
    await seedUser('admin-a', 'admin')
    await seedUser('admin-b', 'admin')
    const outcomes = await Promise.all([deleteDashboardUserKeepingLastAdmin('admin-a'), deleteDashboardUserKeepingLastAdmin('admin-b')])
    expect([...outcomes].sort()).toEqual(['deleted', 'last_admin'])
    const left = await dbx.all<{ role: string }>("SELECT role FROM dashboard_users WHERE role = 'admin' AND disabled = 0")
    expect(left).toHaveLength(1)
  })

  it('refuses the only admin and keeps the row', async () => {
    await seedUser('admin-a', 'admin')
    await seedUser('viewer-a', 'viewer')
    expect(await deleteDashboardUserKeepingLastAdmin('admin-a')).toBe('last_admin')
    expect(await usernames()).toEqual(['admin-a', 'viewer-a'])
  })

  it('deletes an admin while another active admin remains', async () => {
    await seedUser('admin-a', 'admin')
    await seedUser('admin-b', 'admin')
    expect(await deleteDashboardUserKeepingLastAdmin('admin-a')).toBe('deleted')
    expect(await usernames()).toEqual(['admin-b'])
  })

  it('a disabled admin does not count as the remaining one', async () => {
    await seedUser('admin-a', 'admin')
    await seedUser('admin-off', 'admin', 1)
    expect(await deleteDashboardUserKeepingLastAdmin('admin-a')).toBe('last_admin')
    expect(await usernames()).toEqual(['admin-a', 'admin-off'])
  })

  it('keeps the guard on an admin row whether or not that row is disabled (only the COUNT looks at active ones)', async () => {
    await seedUser('admin-a', 'admin')
    await seedUser('admin-off', 'admin', 1)
    // One active admin: any admin row is held back, the disabled one included. A second active admin lifts it.
    expect(await deleteDashboardUserKeepingLastAdmin('admin-off')).toBe('last_admin')
    await seedUser('admin-b', 'admin')
    expect(await deleteDashboardUserKeepingLastAdmin('admin-off')).toBe('deleted')
    expect(await usernames()).toEqual(['admin-a', 'admin-b'])
  })

  it('deletes a non-admin whatever the admin count', async () => {
    await seedUser('viewer-a', 'viewer')
    expect(await deleteDashboardUserKeepingLastAdmin('viewer-a')).toBe('deleted')
    expect(await countDashboardUsers(true)).toBe(0)
  })

  it('matches the name case-insensitively, like the other lookups', async () => {
    await seedUser('Admin-A', 'admin')
    await seedUser('admin-b', 'admin')
    expect(await deleteDashboardUserKeepingLastAdmin('admin-a')).toBe('deleted')
    expect(await usernames()).toEqual(['admin-b'])
  })

  it('answers not_found for an unknown user', async () => {
    await seedUser('admin-a', 'admin')
    expect(await deleteDashboardUserKeepingLastAdmin('nobody')).toBe('not_found')
    expect(await usernames()).toEqual(['admin-a'])
  })

  it('the unguarded delete still removes the last user (the way back to token-only mode)', async () => {
    await seedUser('admin-a', 'admin')
    expect(await deleteDashboardUser('admin-a')).toBe(true)
    expect(await deleteDashboardUser('admin-a')).toBe(false)
    expect(await countDashboardUsers(true)).toBe(0)
  })
})

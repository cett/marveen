// deleteDashboardUser (db/sessions.ts) matches the name through eqNoCase, so "Admin-A" and "admin-a" are the same user on
// both engines. On SQLite the column collation already folds the case; on PostgreSQL a plain `username = ?` would not,
// and only this cell would notice (this file runs on both: useTestDb).
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, deleteDashboardUser, getDashboardUser } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

async function seedUser(username: string): Promise<void> {
  await dbx.run(
    'INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at, disabled) VALUES (?, ?, ?, NULL, 1, 1, 0)',
    username, 'hash', 'viewer',
  )
}

const names = async (): Promise<string[]> =>
  (await dbx.all<{ username: string }>('SELECT username FROM dashboard_users')).map((u) => u.username).sort()

beforeEach(async () => {
  await dbx.run('DELETE FROM dashboard_users')
})

describe('deleteDashboardUser matches the name ignoring case', () => {
  it('removes the row when the name is given in a different case, and only that row', async () => {
    await seedUser('Viewer-A')
    await seedUser('viewer-b')
    expect(await deleteDashboardUser('viewer-a')).toBe(true)
    expect(await names()).toEqual(['viewer-b'])
  })

  it('works the other way round: a lower-case row, an upper-case name', async () => {
    await seedUser('viewer-a')
    expect(await deleteDashboardUser('VIEWER-A')).toBe(true)
    expect(await names()).toEqual([])
  })

  it('answers false and keeps every row for an unknown name', async () => {
    await seedUser('viewer-a')
    expect(await deleteDashboardUser('nobody')).toBe(false)
    expect(await names()).toEqual(['viewer-a'])
  })

  it('is an equality, not a pattern: a LIKE wildcard in the name matches nothing', async () => {
    await seedUser('viewer-a')
    expect(await deleteDashboardUser('viewer-%')).toBe(false)
    expect(await deleteDashboardUser('viewer_a')).toBe(false)
    expect(await names()).toEqual(['viewer-a'])
  })

  it('getDashboardUser finds the same row by a different case (the lookup the delete mirrors)', async () => {
    await seedUser('Viewer-A')
    expect((await getDashboardUser('VIEWER-a'))?.username).toBe('Viewer-A')
  })
})

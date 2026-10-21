// Characterization of db/device-keys.ts: every export on an empty table and with rows. Written before the module
// moved onto the facade (it is part of the auth path, so a lost await must fail a test, not only the lint).

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db.js'
import {
  insertDeviceKey,
  deleteDeviceKeyByHash,
  getDeviceKeyAuthRowByHash,
  touchDeviceKeyLastUsed,
  listDeviceKeyRows,
  getDeviceKeyRowById,
  getDeviceKeyRowByInstallId,
  deleteDeviceKeyById,
  deleteAllDeviceKeys,
  deleteExpiredDeviceKeys,
  setDeviceKeyTenant,
} from '../db/device-keys.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(() => {
  db.prepare("INSERT OR IGNORE INTO tenants (id, display_name, created_at) VALUES ('default', 'Fleet', 0)").run()
  db.prepare("INSERT INTO tenants (id, display_name, created_at) VALUES ('acme', 'Acme', 1)").run()
})

describe('on an empty table', () => {
  it('reads find nothing and writes touch nothing', async () => {
    expect(await listDeviceKeyRows()).toEqual([])
    expect(await getDeviceKeyAuthRowByHash('h')).toBeUndefined()
    expect(await getDeviceKeyRowById(1)).toBeUndefined()
    expect(await getDeviceKeyRowByInstallId('inst')).toBeUndefined()
    expect(await touchDeviceKeyLastUsed('h', 10)).toBe(0)
    expect(await deleteDeviceKeyById(1)).toBe(0)
    expect(await deleteAllDeviceKeys()).toBe(0)
    expect(await deleteExpiredDeviceKeys(100)).toBe(0)
    expect(await setDeviceKeyTenant(1, 'acme')).toBe(0)
    expect(() => deleteDeviceKeyByHash('h')).not.toThrow()
  })
})

describe('insert and read', () => {
  it('insert returns the new id, ids grow', async () => {
    const a = await insertDeviceKey('h1', 'laptop', 100, null, null)
    const b = await insertDeviceKey('h2', 'phone', 200, 900, 'inst-2')
    expect(typeof a).toBe('number')
    expect(b).toBeGreaterThan(a)
  })

  it('a duplicate hash is rejected', async () => {
    await insertDeviceKey('dup', 'a', 1, null, null)
    await expect(insertDeviceKey('dup', 'b', 2, null, null)).rejects.toThrow(/UNIQUE/)
  })

  it('auth row by hash carries only the auth columns', async () => {
    const id = await insertDeviceKey('h1', 'laptop', 100, 900, 'inst-1')
    expect(await getDeviceKeyAuthRowByHash('h1')).toEqual({ id, name: 'laptop', last_used_at: null, expires_at: 900 })
    expect(await getDeviceKeyAuthRowByHash('other')).toBeUndefined()
  })

  it('info rows by id and install id, with the default tenant and no key hash', async () => {
    const id = await insertDeviceKey('h1', 'laptop', 100, null, 'inst-1')
    const expected = { id, name: 'laptop', created_at: 100, last_used_at: null, expires_at: null, install_id: 'inst-1', tenant_id: 'default' }
    expect(await getDeviceKeyRowById(id)).toEqual(expected)
    expect(await getDeviceKeyRowByInstallId('inst-1')).toEqual(expected)
    expect(await getDeviceKeyRowByInstallId('inst-9')).toBeUndefined()
  })

  it('the list is newest first', async () => {
    await insertDeviceKey('h1', 'old', 100, null, null)
    await insertDeviceKey('h2', 'new', 300, null, null)
    await insertDeviceKey('h3', 'mid', 200, null, null)
    expect((await listDeviceKeyRows()).map(r => r.name)).toEqual(['new', 'mid', 'old'])
  })
})

describe('update and delete', () => {
  it('touch sets last_used_at and reports the rows touched', async () => {
    const id = await insertDeviceKey('h1', 'laptop', 100, null, null)
    expect(await touchDeviceKeyLastUsed('h1', 555)).toBe(1)
    expect((await getDeviceKeyRowById(id))?.last_used_at).toBe(555)
    expect(await touchDeviceKeyLastUsed('gone', 556)).toBe(0)
  })

  it('delete by hash removes only that key and does not fail on a missing one', async () => {
    await insertDeviceKey('h1', 'a', 1, null, null)
    await insertDeviceKey('h2', 'b', 2, null, null)
    await deleteDeviceKeyByHash('h1')
    await deleteDeviceKeyByHash('missing')
    expect((await listDeviceKeyRows()).map(r => r.name)).toEqual(['b'])
    expect(await getDeviceKeyAuthRowByHash('h1')).toBeUndefined()
  })

  it('delete by id returns 1 once, then 0', async () => {
    const id = await insertDeviceKey('h1', 'a', 1, null, null)
    expect(await deleteDeviceKeyById(id)).toBe(1)
    expect(await deleteDeviceKeyById(id)).toBe(0)
  })

  it('delete all returns the count and empties the table', async () => {
    await insertDeviceKey('h1', 'a', 1, null, null)
    await insertDeviceKey('h2', 'b', 2, null, null)
    expect(await deleteAllDeviceKeys()).toBe(2)
    expect(await listDeviceKeyRows()).toEqual([])
  })

  it('delete expired removes only keys with an expiry before the cut-off', async () => {
    await insertDeviceKey('never', 'never', 1, null, null)
    await insertDeviceKey('past', 'past', 2, 50, null)
    await insertDeviceKey('edge', 'edge', 3, 100, null)
    await insertDeviceKey('future', 'future', 4, 500, null)
    expect(await deleteExpiredDeviceKeys(100)).toBe(1)
    expect((await listDeviceKeyRows()).map(r => r.name).sort()).toEqual(['edge', 'future', 'never'])
  })

  it('set tenant moves a key to a known tenant and reports the rows touched', async () => {
    const id = await insertDeviceKey('h1', 'a', 1, null, null)
    expect(await setDeviceKeyTenant(id, 'acme')).toBe(1)
    expect((await getDeviceKeyRowById(id))?.tenant_id).toBe('acme')
    expect(await setDeviceKeyTenant(id + 100, 'acme')).toBe(0)
    await expect(setDeviceKeyTenant(id, 'no-such-tenant')).rejects.toThrow(/FOREIGN KEY/)
  })
})

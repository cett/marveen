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
  it('reads find nothing and writes touch nothing', () => {
    expect(listDeviceKeyRows()).toEqual([])
    expect(getDeviceKeyAuthRowByHash('h')).toBeUndefined()
    expect(getDeviceKeyRowById(1)).toBeUndefined()
    expect(getDeviceKeyRowByInstallId('inst')).toBeUndefined()
    expect(touchDeviceKeyLastUsed('h', 10)).toBe(0)
    expect(deleteDeviceKeyById(1)).toBe(0)
    expect(deleteAllDeviceKeys()).toBe(0)
    expect(deleteExpiredDeviceKeys(100)).toBe(0)
    expect(setDeviceKeyTenant(1, 'acme')).toBe(0)
    expect(() => deleteDeviceKeyByHash('h')).not.toThrow()
  })
})

describe('insert and read', () => {
  it('insert returns the new id, ids grow', () => {
    const a = insertDeviceKey('h1', 'laptop', 100, null, null)
    const b = insertDeviceKey('h2', 'phone', 200, 900, 'inst-2')
    expect(typeof a).toBe('number')
    expect(b).toBeGreaterThan(a)
  })

  it('a duplicate hash is rejected', () => {
    insertDeviceKey('dup', 'a', 1, null, null)
    expect(() => insertDeviceKey('dup', 'b', 2, null, null)).toThrow(/UNIQUE/)
  })

  it('auth row by hash carries only the auth columns', () => {
    const id = insertDeviceKey('h1', 'laptop', 100, 900, 'inst-1')
    expect(getDeviceKeyAuthRowByHash('h1')).toEqual({ id, name: 'laptop', last_used_at: null, expires_at: 900 })
    expect(getDeviceKeyAuthRowByHash('other')).toBeUndefined()
  })

  it('info rows by id and install id, with the default tenant and no key hash', () => {
    const id = insertDeviceKey('h1', 'laptop', 100, null, 'inst-1')
    const expected = { id, name: 'laptop', created_at: 100, last_used_at: null, expires_at: null, install_id: 'inst-1', tenant_id: 'default' }
    expect(getDeviceKeyRowById(id)).toEqual(expected)
    expect(getDeviceKeyRowByInstallId('inst-1')).toEqual(expected)
    expect(getDeviceKeyRowByInstallId('inst-9')).toBeUndefined()
  })

  it('the list is newest first', () => {
    insertDeviceKey('h1', 'old', 100, null, null)
    insertDeviceKey('h2', 'new', 300, null, null)
    insertDeviceKey('h3', 'mid', 200, null, null)
    expect(listDeviceKeyRows().map(r => r.name)).toEqual(['new', 'mid', 'old'])
  })
})

describe('update and delete', () => {
  it('touch sets last_used_at and reports the rows touched', () => {
    const id = insertDeviceKey('h1', 'laptop', 100, null, null)
    expect(touchDeviceKeyLastUsed('h1', 555)).toBe(1)
    expect(getDeviceKeyRowById(id)?.last_used_at).toBe(555)
    expect(touchDeviceKeyLastUsed('gone', 556)).toBe(0)
  })

  it('delete by hash removes only that key and does not fail on a missing one', () => {
    insertDeviceKey('h1', 'a', 1, null, null)
    insertDeviceKey('h2', 'b', 2, null, null)
    deleteDeviceKeyByHash('h1')
    deleteDeviceKeyByHash('missing')
    expect(listDeviceKeyRows().map(r => r.name)).toEqual(['b'])
    expect(getDeviceKeyAuthRowByHash('h1')).toBeUndefined()
  })

  it('delete by id returns 1 once, then 0', () => {
    const id = insertDeviceKey('h1', 'a', 1, null, null)
    expect(deleteDeviceKeyById(id)).toBe(1)
    expect(deleteDeviceKeyById(id)).toBe(0)
  })

  it('delete all returns the count and empties the table', () => {
    insertDeviceKey('h1', 'a', 1, null, null)
    insertDeviceKey('h2', 'b', 2, null, null)
    expect(deleteAllDeviceKeys()).toBe(2)
    expect(listDeviceKeyRows()).toEqual([])
  })

  it('delete expired removes only keys with an expiry before the cut-off', () => {
    insertDeviceKey('never', 'never', 1, null, null)
    insertDeviceKey('past', 'past', 2, 50, null)
    insertDeviceKey('edge', 'edge', 3, 100, null)
    insertDeviceKey('future', 'future', 4, 500, null)
    expect(deleteExpiredDeviceKeys(100)).toBe(1)
    expect(listDeviceKeyRows().map(r => r.name).sort()).toEqual(['edge', 'future', 'never'])
  })

  it('set tenant moves a key to a known tenant and reports the rows touched', () => {
    const id = insertDeviceKey('h1', 'a', 1, null, null)
    expect(setDeviceKeyTenant(id, 'acme')).toBe(1)
    expect(getDeviceKeyRowById(id)?.tenant_id).toBe('acme')
    expect(setDeviceKeyTenant(id + 100, 'acme')).toBe(0)
    expect(() => setDeviceKeyTenant(id, 'no-such-tenant')).toThrow(/FOREIGN KEY/)
  })
})

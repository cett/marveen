// The synchronous write-through cache of system_config: reads come from memory (no statement is prepared),
// a write is visible at once and is in the database, a delete and a re-initialisation are picked up, and the
// settings layer on top behaves as before.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase, db,
  getSystemConfig, listSystemConfig, setSystemConfig, deleteSystemConfig,
  reloadSystemConfigCache, clearSystemConfigCache,
} from '../db.js'
import { initDatabase as connectionInitDatabase } from '../db/connection.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

afterEach(() => {
  vi.restoreAllMocks()
})

const dbRow = (key: string) =>
  db.prepare('SELECT key, value, updated_at, source FROM system_config WHERE key = ?').get(key)

describe('reads come from the cache', () => {
  it('getSystemConfig and listSystemConfig prepare no statement', () => {
    setSystemConfig('cache_a', '1')
    setSystemConfig('cache_b', '2', 'migrated_from_json')
    const prepare = vi.spyOn(db, 'prepare')
    expect(getSystemConfig('cache_a')?.value).toBe('1')
    expect(getSystemConfig('cache_b')).toMatchObject({ value: '2', source: 'migrated_from_json' })
    expect(getSystemConfig('cache_missing')).toBeUndefined()
    expect(listSystemConfig().map((r) => r.key)).toEqual(expect.arrayContaining(['cache_a', 'cache_b']))
    expect(prepare).not.toHaveBeenCalled()
  })

  it('the list is ordered by key, like the table query', () => {
    setSystemConfig('zz_key', 'z')
    setSystemConfig('aa_key', 'a')
    const keys = listSystemConfig().map((r) => r.key)
    expect(keys).toEqual([...keys].sort())
  })

  it('a returned row is a copy: changing it does not change the cache', () => {
    setSystemConfig('cache_copy', 'orig')
    const row = getSystemConfig('cache_copy')!
    row.value = 'tampered'
    expect(getSystemConfig('cache_copy')?.value).toBe('orig')
    listSystemConfig().find((r) => r.key === 'cache_copy')!.value = 'tampered'
    expect(getSystemConfig('cache_copy')?.value).toBe('orig')
  })
})

describe('write-through', () => {
  it('a write is visible at once, and is in the database with the same row', () => {
    setSystemConfig('cache_w', 'v1')
    expect(getSystemConfig('cache_w')?.value).toBe('v1')
    expect(getSystemConfig('cache_w')).toEqual(dbRow('cache_w'))
    setSystemConfig('cache_w', 'v2', 'db')
    expect(getSystemConfig('cache_w')?.value).toBe('v2')
    expect(getSystemConfig('cache_w')).toEqual(dbRow('cache_w'))
  })

  it('a delete is visible at once and removes the database row', () => {
    setSystemConfig('cache_d', 'x')
    deleteSystemConfig('cache_d')
    expect(getSystemConfig('cache_d')).toBeUndefined()
    expect(dbRow('cache_d')).toBeUndefined()
    expect(listSystemConfig().some((r) => r.key === 'cache_d')).toBe(false)
  })

  it('the database is written before the cache: a failing write leaves the cache untouched', () => {
    setSystemConfig('cache_f', 'old')
    // value is NOT NULL: the statement fails inside the database
    expect(() => setSystemConfig('cache_f', null as unknown as string)).toThrow()
    expect(getSystemConfig('cache_f')?.value).toBe('old')
    expect(dbRow('cache_f')).toMatchObject({ value: 'old' })
  })
})

describe('initDatabase and the connection', () => {
  it('initDatabase again gives a fresh cache for the fresh database', () => {
    setSystemConfig('cache_gone', '1')
    initDatabase(':memory:')
    expect(getSystemConfig('cache_gone')).toBeUndefined()
    expect(listSystemConfig().some((r) => r.key === 'cache_gone')).toBe(false)
  })

  it('a row written straight into the table is seen after reloadSystemConfigCache()', () => {
    db.prepare("INSERT INTO system_config (key, value, updated_at, source) VALUES ('cache_raw', 'r', 1, 'db')").run()
    expect(getSystemConfig('cache_raw')).toBeUndefined() // stale on purpose: the single writer is the facade-side API
    reloadSystemConfigCache()
    expect(getSystemConfig('cache_raw')?.value).toBe('r')
  })

  it('without a loaded cache the reads go to the table, as before', () => {
    db.prepare("INSERT INTO system_config (key, value, updated_at, source) VALUES ('cache_uncached', 'u', 1, 'db')").run()
    clearSystemConfigCache()
    expect(getSystemConfig('cache_uncached')?.value).toBe('u')
    expect(listSystemConfig().some((r) => r.key === 'cache_uncached')).toBe(true)
    // and a write while not loaded still reaches the table
    setSystemConfig('cache_uncached', 'u2')
    expect(dbRow('cache_uncached')).toMatchObject({ value: 'u2' })
  })

  it('a cache loaded for a closed connection is never served: the table of the new handle is read', () => {
    setSystemConfig('cache_old_handle', 'x')
    // the connection initialiser alone (no cache load) hands out a new empty database
    connectionInitDatabase(':memory:')
    expect(getSystemConfig('cache_old_handle')).toBeUndefined()
  })
})

describe('the settings layer on top', () => {
  it('getEffectiveSettingValue sees a stored value at once and falls back to the default after a delete', () => {
    const before = getEffectiveSettingValue('MEMORY_RERANK_ENABLED')
    setSystemConfig('MEMORY_RERANK_ENABLED', 'true')
    expect(getEffectiveSettingValue('MEMORY_RERANK_ENABLED')).toBe('true')
    deleteSystemConfig('MEMORY_RERANK_ENABLED')
    expect(getEffectiveSettingValue('MEMORY_RERANK_ENABLED')).toBe(before)
  })
})

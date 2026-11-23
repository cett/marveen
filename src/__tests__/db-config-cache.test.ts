// The synchronous write-through cache of system_config, on BOTH engines (useTestDb: SQLite, and PostgreSQL under
// MARVEEN_TEST_DB=pg): reads come from memory (no statement goes through the facade), a write is visible at once and is in
// the database, a delete is picked up, a table written behind the cache is seen after the ASYNCHRONOUS load, and the
// settings layer on top behaves as before. What belongs to the SQLite handle only (the raw-handle spy, the synchronous
// reload, a fresh handle) is in db-config-cache-sqlite-handle.test.ts; the PostgreSQL owner (the backend epoch) is in
// pg/pg-boot.pg.test.ts.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  dbx, dbxDialect,
  getSystemConfig, listSystemConfig, setSystemConfig, deleteSystemConfig,
  clearSystemConfigCache,
} from '../db.js'
import { loadSystemConfigCacheAsync } from '../db/config-cache.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

afterEach(() => {
  vi.restoreAllMocks()
})

const dbRow = (key: string) =>
  dbx.get('SELECT key, value, updated_at, source FROM system_config WHERE key = ?', key)

/** Every statement that goes through the facade from now on. */
function spyFacade(): ReturnType<typeof vi.spyOn>[] {
  return (['get', 'all', 'run'] as const).map((m) => vi.spyOn(dbx, m))
}

describe('reads come from the cache', () => {
  it('getSystemConfig and listSystemConfig send no statement through the facade', async () => {
    await setSystemConfig('cache_a', '1')
    await setSystemConfig('cache_b', '2', 'migrated_from_json')
    const spies = spyFacade()
    expect(getSystemConfig('cache_a')?.value).toBe('1')
    expect(getSystemConfig('cache_b')).toMatchObject({ value: '2', source: 'migrated_from_json' })
    expect(getSystemConfig('cache_missing')).toBeUndefined()
    expect(listSystemConfig().map((r) => r.key)).toEqual(expect.arrayContaining(['cache_a', 'cache_b']))
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it('the list is ordered by key, like the table query', async () => {
    await setSystemConfig('zz_key', 'z')
    await setSystemConfig('aa_key', 'a')
    const keys = listSystemConfig().map((r) => r.key)
    expect(keys).toEqual([...keys].sort())
  })

  it('a returned row is a copy: changing it does not change the cache', async () => {
    await setSystemConfig('cache_copy', 'orig')
    const row = getSystemConfig('cache_copy')!
    row.value = 'tampered'
    expect(getSystemConfig('cache_copy')?.value).toBe('orig')
    listSystemConfig().find((r) => r.key === 'cache_copy')!.value = 'tampered'
    expect(getSystemConfig('cache_copy')?.value).toBe('orig')
  })
})

describe('write-through', () => {
  it('a write is visible at once, and is in the database with the same row', async () => {
    await setSystemConfig('cache_w', 'v1')
    expect(getSystemConfig('cache_w')?.value).toBe('v1')
    expect(getSystemConfig('cache_w')).toEqual(await dbRow('cache_w'))
    await setSystemConfig('cache_w', 'v2', 'db')
    expect(getSystemConfig('cache_w')?.value).toBe('v2')
    expect(getSystemConfig('cache_w')).toEqual(await dbRow('cache_w'))
  })

  it('a delete is visible at once and removes the database row', async () => {
    await setSystemConfig('cache_d', 'x')
    await deleteSystemConfig('cache_d')
    expect(getSystemConfig('cache_d')).toBeUndefined()
    expect(await dbRow('cache_d')).toBeUndefined()
    expect(listSystemConfig().some((r) => r.key === 'cache_d')).toBe(false)
  })

  it('the database is written before the cache: a failing write leaves the cache untouched', async () => {
    await setSystemConfig('cache_f', 'old')
    // value is NOT NULL: the statement fails inside the database
    await expect(setSystemConfig('cache_f', null as unknown as string)).rejects.toThrow()
    expect(getSystemConfig('cache_f')?.value).toBe('old')
    expect(await dbRow('cache_f')).toMatchObject({ value: 'old' })
  })
})

describe('the table written behind the cache', () => {
  it('a row written straight into the table is seen after loadSystemConfigCacheAsync(), not before', async () => {
    await dbx.run("INSERT INTO system_config (key, value, updated_at, source) VALUES ('cache_raw', 'r', 1, 'db')")
    expect(getSystemConfig('cache_raw')).toBeUndefined() // stale on purpose: the facade-side API is the single writer
    await loadSystemConfigCacheAsync()
    expect(getSystemConfig('cache_raw')?.value).toBe('r')
  })

  it('a cleared cache: SQLite reads the table as before, PostgreSQL refuses and names the loader', async () => {
    await dbx.run("INSERT INTO system_config (key, value, updated_at, source) VALUES ('cache_uncached', 'u', 1, 'db')")
    clearSystemConfigCache()
    if (dbxDialect() === 'pg') {
      expect(() => getSystemConfig('cache_uncached')).toThrow(/cache not loaded in PG mode: call loadSystemConfigCacheAsync\(\)/)
      expect(() => listSystemConfig()).toThrow(/loadSystemConfigCacheAsync/)
    } else {
      expect(getSystemConfig('cache_uncached')?.value).toBe('u')
      expect(listSystemConfig().some((r) => r.key === 'cache_uncached')).toBe(true)
    }
    // either way a load makes it served again, and a write while it was cleared reached the table
    await setSystemConfig('cache_uncached', 'u2')
    await loadSystemConfigCacheAsync()
    expect(getSystemConfig('cache_uncached')?.value).toBe('u2')
    expect(await dbRow('cache_uncached')).toMatchObject({ value: 'u2' })
  })
})

describe('the settings layer on top', () => {
  it('getEffectiveSettingValue sees a stored value at once and falls back to the default after a delete', async () => {
    const before = getEffectiveSettingValue('MEMORY_RERANK_ENABLED')
    await setSystemConfig('MEMORY_RERANK_ENABLED', 'true')
    expect(getEffectiveSettingValue('MEMORY_RERANK_ENABLED')).toBe('true')
    await deleteSystemConfig('MEMORY_RERANK_ENABLED')
    expect(getEffectiveSettingValue('MEMORY_RERANK_ENABLED')).toBe(before)
  })
})

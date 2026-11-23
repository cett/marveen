// The synchronous write-through cache of model_profile_map, on BOTH engines (useTestDb), mirroring db-config-cache.test.ts:
// reads come from memory (no statement goes through the facade), an (async) write is visible at once, a table written
// behind the cache is seen after the ASYNCHRONOUS load. The SQLite-handle cells are in
// db-model-profile-map-cache-sqlite-handle.test.ts; the PostgreSQL owner (the backend epoch) is in pg/pg-boot.pg.test.ts.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  dbx, dbxDialect,
  listModelProfileMap, getModelProfileMapEntry, setModelProfileMapEntry, upsertModelProfileMapEntry,
  clearModelProfileMapCache,
} from '../db.js'
import { loadModelProfileMapCacheAsync } from '../db/model-profile-map-cache.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

afterEach(() => {
  vi.restoreAllMocks()
})

const dbRow = (profileId: string) =>
  dbx.get('SELECT profile_id, model_id, updated_at, updated_by FROM model_profile_map WHERE profile_id = ?', profileId)

describe('reads come from the cache', () => {
  it('listModelProfileMap and getModelProfileMapEntry send no statement through the facade', () => {
    const spies = (['get', 'all', 'run'] as const).map((m) => vi.spyOn(dbx, m))
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('claude-sonnet-5')
    expect(getModelProfileMapEntry('nope')).toBeUndefined()
    expect(listModelProfileMap()).toHaveLength(4)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it('a returned row is a copy: changing it does not change the cache', () => {
    const row = getModelProfileMapEntry('build_strong')!
    row.model_id = 'tampered'
    expect(getModelProfileMapEntry('build_strong')?.model_id).not.toBe('tampered')
    listModelProfileMap().find((r) => r.profile_id === 'build_strong')!.model_id = 'tampered'
    expect(getModelProfileMapEntry('build_strong')?.model_id).not.toBe('tampered')
  })
})

describe('write-through', () => {
  it('a write is visible at once, and is in the database with the same row', async () => {
    await setModelProfileMapEntry('build_strong', 'model-v1', 'dashboard')
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('model-v1')
    expect(getModelProfileMapEntry('build_strong')).toEqual(await dbRow('build_strong'))
    await setModelProfileMapEntry('build_strong', 'model-v2', 'dashboard')
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('model-v2')
    expect(getModelProfileMapEntry('build_strong')).toEqual(await dbRow('build_strong'))
  })

  it('upsertModelProfileMapEntry is write-through too', async () => {
    await upsertModelProfileMapEntry({ profile_id: 'routine_lowcost', model_id: 'model-a', updated_by: 'test' })
    expect(getModelProfileMapEntry('routine_lowcost')?.model_id).toBe('model-a')
    expect(getModelProfileMapEntry('routine_lowcost')).toEqual(await dbRow('routine_lowcost'))
  })

  it('the database is written before the cache: a failing write leaves the cache untouched', async () => {
    const before = getModelProfileMapEntry('build_strong')
    // profile_id is CHECK-constrained to the 4 known ids: the statement fails inside the database
    await expect(upsertModelProfileMapEntry({ profile_id: 'unknown_profile' as never, model_id: 'x', updated_by: 'test' })).rejects.toThrow()
    expect(getModelProfileMapEntry('build_strong')).toEqual(before)
  })
})

describe('the table written behind the cache', () => {
  it('a row written straight into the table is seen after loadModelProfileMapCacheAsync(), not before', async () => {
    await dbx.run("UPDATE model_profile_map SET model_id = 'raw-write', updated_by = 'raw' WHERE profile_id = 'build_strong'")
    expect(getModelProfileMapEntry('build_strong')?.model_id).not.toBe('raw-write') // stale on purpose
    await loadModelProfileMapCacheAsync()
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('raw-write')
  })

  it('a cleared cache: SQLite reads the table as before, PostgreSQL refuses and names the loader', async () => {
    await dbx.run("UPDATE model_profile_map SET model_id = 'uncached-write' WHERE profile_id = 'build_strong'")
    clearModelProfileMapCache()
    if (dbxDialect() === 'pg') {
      expect(() => getModelProfileMapEntry('build_strong')).toThrow(/cache not loaded in PG mode: call loadModelProfileMapCacheAsync\(\)/)
      expect(() => listModelProfileMap()).toThrow(/loadModelProfileMapCacheAsync/)
    } else {
      expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('uncached-write')
      expect(listModelProfileMap().some((r) => r.model_id === 'uncached-write')).toBe(true)
    }
    await loadModelProfileMapCacheAsync()
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('uncached-write')
  })
})

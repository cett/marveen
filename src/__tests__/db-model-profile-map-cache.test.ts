// The synchronous write-through cache of model_profile_map, mirroring db-config-cache.test.ts:
// reads come from memory (no statement is prepared), an (async) write is visible at once, a re-initialisation
// is picked up, and a direct table write is picked up only after an explicit reload.

import { describe, it, expect, vi } from 'vitest'
import {
  initDatabase, db,
  listModelProfileMap, getModelProfileMapEntry, setModelProfileMapEntry, upsertModelProfileMapEntry,
  reloadModelProfileMapCache, clearModelProfileMapCache,
} from '../db.js'
import { initDatabase as connectionInitDatabase } from '../db/connection.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const dbRow = (profileId: string) =>
  db.prepare('SELECT profile_id, model_id, updated_at, updated_by FROM model_profile_map WHERE profile_id = ?').get(profileId)

describe('reads come from the cache', () => {
  it('listModelProfileMap and getModelProfileMapEntry prepare no statement', () => {
    const prepare = vi.spyOn(db, 'prepare')
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('claude-sonnet-5')
    expect(getModelProfileMapEntry('nope')).toBeUndefined()
    expect(listModelProfileMap()).toHaveLength(4)
    expect(prepare).not.toHaveBeenCalled()
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
    expect(getModelProfileMapEntry('build_strong')).toEqual(dbRow('build_strong'))
    await setModelProfileMapEntry('build_strong', 'model-v2', 'dashboard')
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('model-v2')
    expect(getModelProfileMapEntry('build_strong')).toEqual(dbRow('build_strong'))
  })

  it('upsertModelProfileMapEntry is write-through too', async () => {
    await upsertModelProfileMapEntry({ profile_id: 'routine_lowcost', model_id: 'model-a', updated_by: 'test' })
    expect(getModelProfileMapEntry('routine_lowcost')?.model_id).toBe('model-a')
    expect(getModelProfileMapEntry('routine_lowcost')).toEqual(dbRow('routine_lowcost'))
  })

  it('the database is written before the cache: a failing write leaves the cache untouched', async () => {
    const before = getModelProfileMapEntry('build_strong')
    // profile_id is CHECK-constrained to the 4 known ids: the statement fails inside the database
    await expect(upsertModelProfileMapEntry({ profile_id: 'unknown_profile' as never, model_id: 'x', updated_by: 'test' })).rejects.toThrow()
    expect(getModelProfileMapEntry('build_strong')).toEqual(before)
  })
})

describe('initDatabase and the connection', () => {
  it('initDatabase again gives a fresh cache for the fresh database', () => {
    initDatabase(':memory:')
    expect(listModelProfileMap()).toHaveLength(4) // migration 0054 re-seeds the fresh handle
    expect(getModelProfileMapEntry('build_strong')?.updated_by).toBe('seed_migration')
  })

  it('a row written straight into the table is seen after reloadModelProfileMapCache()', () => {
    db.exec("UPDATE model_profile_map SET model_id = 'raw-write', updated_by = 'raw' WHERE profile_id = 'build_strong'")
    expect(getModelProfileMapEntry('build_strong')?.model_id).not.toBe('raw-write') // stale on purpose
    reloadModelProfileMapCache()
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('raw-write')
  })

  it('without a loaded cache the reads go to the table, as before', () => {
    db.exec("UPDATE model_profile_map SET model_id = 'uncached-write' WHERE profile_id = 'build_strong'")
    clearModelProfileMapCache()
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('uncached-write')
    expect(listModelProfileMap().some((r) => r.model_id === 'uncached-write')).toBe(true)
  })

  it('a cache loaded for a closed connection is never served: the table of the new handle is read', async () => {
    await setModelProfileMapEntry('build_strong', 'old-handle-value', 'dashboard')
    // the connection initialiser alone (no cache load) hands out a fresh database, migrated and re-seeded
    // (migration 0054 runs as part of it) but with none of the writes made against the old handle.
    connectionInitDatabase(':memory:')
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('claude-sonnet-5')
  })
})

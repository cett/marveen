// What the model_profile_map cache does that belongs to the SQLite connection handle: the raw-handle spy, a
// re-initialisation (migration 0054 re-seeds the fresh handle), the SYNCHRONOUS reload that reads the raw handle, and a
// cache that belongs to a closed handle. The engine-neutral cells are in db-model-profile-map-cache.test.ts (both
// engines). No useTestDb on purpose: SQLite by subject, so it opens its own in-memory database and is not part of the
// PostgreSQL module list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase, db,
  listModelProfileMap, getModelProfileMapEntry, setModelProfileMapEntry,
  reloadModelProfileMapCache, clearModelProfileMapCache,
} from '../db.js'
import { initDatabase as connectionInitDatabase } from '../db/connection.js'
import { resetDbTestState } from './helpers/with-test-db.js'

beforeEach(() => {
  resetDbTestState()
  initDatabase(':memory:')
})

afterEach(() => {
  vi.restoreAllMocks()
  try { db?.close() } catch { /* already closed by the test */ }
  resetDbTestState()
})

describe('the SQLite handle and the cache', () => {
  it('listModelProfileMap and getModelProfileMapEntry prepare no statement on the raw handle', () => {
    const prepare = vi.spyOn(db, 'prepare')
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('claude-sonnet-5')
    expect(listModelProfileMap()).toHaveLength(4)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('initDatabase again gives a fresh cache for the fresh database', () => {
    initDatabase(':memory:')
    expect(listModelProfileMap()).toHaveLength(4) // migration 0054 re-seeds the fresh handle
    expect(getModelProfileMapEntry('build_strong')?.updated_by).toBe('seed_migration')
  })

  it('a row written straight into the table is seen after the synchronous reloadModelProfileMapCache()', () => {
    db.exec("UPDATE model_profile_map SET model_id = 'raw-write', updated_by = 'raw' WHERE profile_id = 'build_strong'")
    expect(getModelProfileMapEntry('build_strong')?.model_id).not.toBe('raw-write') // stale on purpose
    reloadModelProfileMapCache()
    expect(getModelProfileMapEntry('build_strong')?.model_id).toBe('raw-write')
  })

  it('without a loaded cache the reads go to the raw table, as before', () => {
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

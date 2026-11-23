// What the system_config cache does that belongs to the SQLite connection handle: the raw-handle spy (no statement is
// prepared), the SYNCHRONOUS reload that reads the raw handle, a re-initialisation, and a cache that belongs to a closed
// handle. The engine-neutral cells are in db-config-cache.test.ts (both engines); the PostgreSQL owner (the backend
// epoch) is in pg/pg-boot.pg.test.ts. No useTestDb here on purpose: this file is SQLite by subject, so it opens its own
// in-memory database and is not part of the PostgreSQL module list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase, db,
  getSystemConfig, listSystemConfig, setSystemConfig,
  reloadSystemConfigCache, clearSystemConfigCache,
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

const dbRow = (key: string) =>
  db.prepare('SELECT key, value, updated_at, source FROM system_config WHERE key = ?').get(key)

describe('the SQLite handle and the cache', () => {
  it('getSystemConfig and listSystemConfig prepare no statement on the raw handle', async () => {
    await setSystemConfig('cache_a', '1')
    const prepare = vi.spyOn(db, 'prepare')
    expect(getSystemConfig('cache_a')?.value).toBe('1')
    expect(getSystemConfig('cache_missing')).toBeUndefined()
    expect(listSystemConfig().length).toBeGreaterThan(0)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('initDatabase again gives a fresh cache for the fresh database', async () => {
    await setSystemConfig('cache_gone', '1')
    initDatabase(':memory:')
    expect(getSystemConfig('cache_gone')).toBeUndefined()
    expect(listSystemConfig().some((r) => r.key === 'cache_gone')).toBe(false)
  })

  it('a row written straight into the table is seen after the synchronous reloadSystemConfigCache()', () => {
    db.prepare("INSERT INTO system_config (key, value, updated_at, source) VALUES ('cache_raw', 'r', 1, 'db')").run()
    expect(getSystemConfig('cache_raw')).toBeUndefined() // stale on purpose
    reloadSystemConfigCache()
    expect(getSystemConfig('cache_raw')?.value).toBe('r')
  })

  it('without a loaded cache the reads go to the raw table, and a write while not loaded still reaches it', async () => {
    db.prepare("INSERT INTO system_config (key, value, updated_at, source) VALUES ('cache_uncached', 'u', 1, 'db')").run()
    clearSystemConfigCache()
    expect(getSystemConfig('cache_uncached')?.value).toBe('u')
    await setSystemConfig('cache_uncached', 'u2')
    expect(dbRow('cache_uncached')).toMatchObject({ value: 'u2' })
  })

  it('a cache loaded for a closed connection is never served: the table of the new handle is read', async () => {
    await setSystemConfig('cache_old_handle', 'x')
    // the connection initialiser alone (no cache load) hands out a new empty database
    connectionInitDatabase(':memory:')
    expect(getSystemConfig('cache_old_handle')).toBeUndefined()
  })
})

// Who a synchronous cache (system_config, model_profile_map, agent_settings) belongs to.
//
// On SQLite the owner is the connection handle: a cache filled for one `db` is never served for another (a test or a
// recovery path that calls `initDatabase()` again gets a fresh handle). That is the rule the caches always had and the
// SQLite path keeps it byte for byte.
//
// On the PostgreSQL backend there is no handle, so the owner is the BACKEND: `dbxBackendEpoch()` counts every
// `useDbxBackend` call, and a cache filled under one epoch is not served under another. A cache that belongs to a
// previous test's database is therefore never read by the next test.
//
// Pure helpers, no cache state: each cache module keeps its own rows and calls these.
import { db } from './connection.js'
import { dbxBackendEpoch, dbxDialect } from './facade.js'

export interface CacheOwner {
  /** The SQLite handle the fill belongs to (null for a PG fill). */
  handle: unknown
  /** The backend epoch the fill belongs to (null for a SQLite fill). */
  epoch: number | null
}

/** The owner a fill started now would have. */
export function ownerNow(): CacheOwner {
  return dbxDialect() === 'pg' ? { handle: null, epoch: dbxBackendEpoch() } : { handle: db, epoch: null }
}

/** True when `owner` is still the current owner: the same handle on SQLite, the same epoch on PG. */
export function ownerLive(owner: CacheOwner | null): boolean {
  if (owner === null) return false
  const now = ownerNow()
  return owner.handle === now.handle && owner.epoch === now.epoch
}

/** The error a synchronous reader throws on the PG backend when nothing was loaded for it (instead of a TypeError on the missing handle). */
export function notLoadedInPg(loader: string): Error {
  return new Error(`cache not loaded in PG mode: call ${loader}`)
}

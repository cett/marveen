// A synchronous write-through cache of the `model_profile_map` table, mirroring config-cache.ts.
//
// Why: `agent-config.ts`'s `readModelProfileMap()` sits on the model-resolution hot path (agent spawn/restart,
// the model-fallback runner, federation capabilities) -- 27 functions in 11 files reach it transitively, and
// those callers must NOT become asynchronous when model-profile-map.ts's writers move onto the async db
// facade. Same situation as `system_config` (config-cache.ts): the reads stay synchronous, served from
// memory, and only the writes go to the database (and, through it, to the facade).
//
//   - load: `initDatabase()` fills the cache after the migrations (every start, every re-initialisation),
//   - read: `listModelProfileMap` / `getModelProfileMapEntry` answer from the cache, no statement is prepared,
//   - write: the DATABASE FIRST, THEN the cache (write-through). The row put in the cache is the row the
//     database holds after the write (its `updated_at` comes from the database clock, via `unixepoch()`),
//   - the cache belongs to one connection handle: if the handle changed (a test or a recovery path called
//     `initDatabase()` or the connection initialiser directly) the cache is ignored and the table is read,
//     until the next load. A cache for a closed handle is never served.
//
// Single writer: the dashboard process (this module's `setModelProfileMapEntry` / `upsertModelProfileMapEntry`)
// is the only writer of `model_profile_map` -- a grep of `scripts/` for the table name found nothing (no
// shell/Python hook touches it directly). A script or a test that writes the table directly calls
// `reloadModelProfileMapCache()`.

import { db } from './connection.js'
import { dbx, dbxDialect, type SqlOps } from './facade.js'
import { notLoadedInPg, ownerLive, ownerNow, type CacheOwner } from './cache-owner.js'
import type { ModelProfileMapRow } from './model-profile-map.js'

const SELECT_COLUMNS = 'profile_id, model_id, updated_at, updated_by'
const SELECT_ALL = `SELECT ${SELECT_COLUMNS} FROM model_profile_map ORDER BY profile_id`

let rows: Map<string, ModelProfileMapRow> | null = null
let owner: CacheOwner | null = null

function readTable(): ModelProfileMapRow[] {
  return db.prepare(SELECT_ALL).all() as ModelProfileMapRow[]
}

/** Load the cache from the table for the CURRENT connection. Called by `initDatabase()` after the migrations. */
export function loadModelProfileMapCache(): void {
  const next = new Map<string, ModelProfileMapRow>()
  for (const row of readTable()) next.set(row.profile_id, row)
  rows = next
  owner = { handle: db, epoch: null }
}

/** Re-read the table: for a script or a test that wrote `model_profile_map` directly. */
export function reloadModelProfileMapCache(): void {
  loadModelProfileMapCache()
}

/** Forget the cache (the next reads go to the table until the next load). */
export function clearModelProfileMapCache(): void {
  rows = null
  owner = null
}

/** A synchronous reader: on the PG backend an unloaded cache is an error that names the loader. */
function liveForRead(): ReturnType<typeof live> {
  const map = live()
  if (map === null && dbxDialect() === 'pg') throw notLoadedInPg('loadModelProfileMapCacheAsync()')
  return map
}

function live(): Map<string, ModelProfileMapRow> | null {
  return rows !== null && ownerLive(owner) ? rows : null
}

export function cachedModelProfileMapEntry(profileId: string): ModelProfileMapRow | undefined | null {
  const map = liveForRead()
  if (map === null) return null
  const row = map.get(profileId)
  return row === undefined ? undefined : { ...row }
}

export function cachedModelProfileMapList(): ModelProfileMapRow[] | null {
  const map = liveForRead()
  if (map === null) return null
  return [...map.values()].sort((a, b) => (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0)).map((r) => ({ ...r }))
}

/** After a write: put the row the database now holds in the cache (only if the cache is live). */
export function cacheAfterModelProfileWrite(profileId: string): void {
  const map = live()
  if (map === null) return
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM model_profile_map WHERE profile_id = ?`).get(profileId) as
    | ModelProfileMapRow
    | undefined
  if (row === undefined) map.delete(profileId)
  else map.set(profileId, row)
}

/**
 * Load the cache through the facade (`dbx.all`: a plain SELECT, the same text on both engines). On the PG backend the
 * cache then belongs to that backend's epoch; on SQLite it belongs to the handle, as the synchronous load makes it.
 * If the backend was switched while the rows were read, they belong to nobody and are dropped.
 */
export async function loadModelProfileMapCacheAsync(): Promise<void> {
  const mine = ownerNow()
  const all = await dbx.all<ModelProfileMapRow>(SELECT_ALL)
  if (!ownerLive(mine)) return
  const next: Map<string, ModelProfileMapRow> = new Map()
  for (const row of all) next.set(row.profile_id, row)
  rows = next
  owner = mine
}

/**
 * After a write, from an async writer: on the PG backend the row is read back with an awaited `dbx.get` and put in the
 * cache (only if the cache is live for this backend); on SQLite it is the synchronous read-back of cacheAfterModelProfileWrite.
 * Known limit on PG: two overlapping writers can leave the cache stale until the cross-process invalidation of P2-5;
 * a test with one connection does not see it.
 * `ops` is the handle the read-back runs on: the transaction handle of a writer that has not committed yet (the outer
 * dbx is refused inside a transaction body on PG and would not see the uncommitted row). The cache then holds the
 * uncommitted value; a caller whose transaction rolls back re-reads the cache afterwards.
 */
export async function cacheAfterModelProfileWriteAsync(profileId: string, ops: SqlOps = dbx): Promise<void> {
  if (dbxDialect() !== 'pg') {
    cacheAfterModelProfileWrite(profileId)
    return
  }
  const map = live()
  if (map === null) return
  const row = await ops.get<ModelProfileMapRow>(`SELECT ${SELECT_COLUMNS} FROM model_profile_map WHERE profile_id = ?`, profileId)
  // `map` is the map checked above: if the backend was switched meanwhile and the cache reloaded, the reloaded one is a
  // different object and this (older) row lands in the dead one
  if (row === undefined) map.delete(profileId)
  else map.set(profileId, row)
}

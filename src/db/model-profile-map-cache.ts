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
import type { ModelProfileMapRow } from './model-profile-map.js'

const SELECT_COLUMNS = 'profile_id, model_id, updated_at, updated_by'
const SELECT_ALL = `SELECT ${SELECT_COLUMNS} FROM model_profile_map ORDER BY profile_id`

let rows: Map<string, ModelProfileMapRow> | null = null
let cachedFor: unknown = null

function readTable(): ModelProfileMapRow[] {
  return db.prepare(SELECT_ALL).all() as ModelProfileMapRow[]
}

/** Load the cache from the table for the CURRENT connection. Called by `initDatabase()` after the migrations. */
export function loadModelProfileMapCache(): void {
  const next = new Map<string, ModelProfileMapRow>()
  for (const row of readTable()) next.set(row.profile_id, row)
  rows = next
  cachedFor = db
}

/** Re-read the table: for a script or a test that wrote `model_profile_map` directly. */
export function reloadModelProfileMapCache(): void {
  loadModelProfileMapCache()
}

/** Forget the cache (the next reads go to the table until the next load). */
export function clearModelProfileMapCache(): void {
  rows = null
  cachedFor = null
}

function live(): Map<string, ModelProfileMapRow> | null {
  return rows !== null && cachedFor === db ? rows : null
}

export function cachedModelProfileMapEntry(profileId: string): ModelProfileMapRow | undefined | null {
  const map = live()
  if (map === null) return null
  const row = map.get(profileId)
  return row === undefined ? undefined : { ...row }
}

export function cachedModelProfileMapList(): ModelProfileMapRow[] | null {
  const map = live()
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

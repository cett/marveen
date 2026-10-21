// A synchronous write-through cache of the `system_config` table (Phase 1).
//
// Why: the configuration readers (`getEffectiveSettingValue` and 56 calls in 23 files, the model fallback,
// the schedule runner, the terminal input switch, ...) are synchronous and sit on hot paths. They must NOT
// become asynchronous when the db layer does, so their reads are served from memory and only the writes go
// to the database (and, later, through the facade).
//
//   - load: `initDatabase()` fills the cache after the migrations (every start, every re-initialisation),
//   - read: `getSystemConfig` / `listSystemConfig` answer from the cache, no statement is prepared,
//   - write: the DATABASE FIRST, THEN the cache (write-through). The row put in the cache is the row the
//     database holds after the write (its `updated_at` comes from the database clock),
//   - the cache belongs to one connection handle: if the handle changed (a test or a recovery path called
//     `initDatabase()` or the connection initialiser directly) the cache is ignored and the table is read,
//     until the next load. A cache for a closed handle is never served.
//
// Single writer: the dashboard process is the only one that writes `system_config`. `scripts/eval/recall-eval.ts`
// writes an ISOLATED COPY of the database, `config.ts` reads the table through its own read-only connection at
// load time (not through this cache). If any other process ever writes the table, this cache goes stale; a
// script or a test that writes the table directly calls `reloadSystemConfigCache()`.

import { db } from './connection.js'
import type { SystemConfigRow } from './system-config.js'

const SELECT_ALL = 'SELECT key, value, updated_at, source FROM system_config ORDER BY key'

let rows: Map<string, SystemConfigRow> | null = null
let cachedFor: unknown = null

function readTable(): SystemConfigRow[] {
  return db.prepare(SELECT_ALL).all() as SystemConfigRow[]
}

/** Load the cache from the table for the CURRENT connection. Called by `initDatabase()` after the migrations. */
export function loadSystemConfigCache(): void {
  const next = new Map<string, SystemConfigRow>()
  for (const row of readTable()) next.set(row.key, row)
  rows = next
  cachedFor = db
}

/** Re-read the table: for a script or a test that wrote `system_config` directly. */
export function reloadSystemConfigCache(): void {
  loadSystemConfigCache()
}

/** Forget the cache (the next reads go to the table until the next load). */
export function clearSystemConfigCache(): void {
  rows = null
  cachedFor = null
}

function live(): Map<string, SystemConfigRow> | null {
  return rows !== null && cachedFor === db ? rows : null
}

export function cachedSystemConfig(key: string): SystemConfigRow | undefined | null {
  const map = live()
  if (map === null) return null
  const row = map.get(key)
  return row === undefined ? undefined : { ...row }
}

export function cachedSystemConfigList(): SystemConfigRow[] | null {
  const map = live()
  if (map === null) return null
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((r) => ({ ...r }))
}

/** After a write: put the row the database now holds in the cache (only if the cache is live). */
export function cacheAfterWrite(key: string): void {
  const map = live()
  if (map === null) return
  const row = db.prepare('SELECT key, value, updated_at, source FROM system_config WHERE key = ?').get(key) as
    | SystemConfigRow
    | undefined
  if (row === undefined) map.delete(key)
  else map.set(key, row)
}

/** After a bulk write (the migrators): re-read the table if the cache is live; a cache that is not loaded stays unloaded. */
export function refreshSystemConfigCacheIfLive(): void {
  if (live() !== null) loadSystemConfigCache()
}

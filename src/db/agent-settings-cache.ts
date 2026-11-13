// A synchronous write-through cache of the `agent_settings` table, mirroring model-profile-map-cache.ts.
//
// Why: the context-guard/auto-restart/context-restart-gate config readers (context-guard-runner.ts,
// auto-restart-runner.ts, startup-reconciliation.ts, the agent-detail routes) sit on a synchronous,
// non-request path and must NOT become asynchronous when agent-settings.ts's writer (setAgentSetting)
// moves onto the async db facade. Same situation as model_profile_map (model-profile-map-cache.ts) and
// system_config (config-cache.ts): reads stay synchronous, served from memory, only the write goes to
// the database (and, through it, to the facade).
//
//   - load: `initDatabase()` fills the cache after the migrations (every start, every re-initialisation),
//   - read: `getAgentSetting` / `listAgentSettingsByKey` answer from the cache, no statement is prepared,
//   - write: the DATABASE FIRST, THEN the cache (write-through). The row put in the cache is the row the
//     database holds after the write (its `updated_at` comes from the database clock, via `unixepoch()`),
//   - the cache belongs to one connection handle: if the handle changed (a test or a recovery path called
//     `initDatabase()` or the connection initialiser directly) the cache is ignored and the table is read,
//     until the next load. A cache for a closed handle is never served.
//
// Single writer in the normal request path: the dashboard process (`setAgentSetting`, the importer
// `importAgentSettingsFromFile`, and fleet-transfer.ts's import loop). `deleteTenant` (db/observability.ts)
// also deletes/retags rows directly on the raw connection as part of its own transaction -- it calls
// `reloadAgentSettingsCache()` itself right after, so that bypass write is covered too.
// `scripts/hooks/context-watchdog.py` reads the table directly via sqlite3 (a reader, not a writer, so
// the cache rule is not broken by it, but the "database first" ordering still matters to it).
//
// Keyed by (agent_id, setting_key): unlike model_profile_map's single `profile_id` key, this table has a
// composite key, so the cache is one `Map<string, AgentSettingRow>` keyed by a joined string; the
// `listAgentSettingsByKey()` view is built by filtering that one map (mirrors the JSON side-cars' former
// per-key `{ [agentId]: config }` shape).

import { db } from './connection.js'
import { dbx, dbxDialect, type SqlOps } from './facade.js'
import { notLoadedInPg, ownerLive, ownerNow, type CacheOwner } from './cache-owner.js'
import type { AgentSettingKey, AgentSettingRow } from './agent-settings.js'

const SELECT_COLUMNS = 'agent_id, setting_key, setting_value, tenant_id, updated_at'
const SELECT_ALL = `SELECT ${SELECT_COLUMNS} FROM agent_settings`

function cacheKey(agentId: string, key: AgentSettingKey): string {
  return `${agentId}\u0000${key}`
}

let rows: Map<string, AgentSettingRow> | null = null
let owner: CacheOwner | null = null

function readTable(): AgentSettingRow[] {
  return db.prepare(SELECT_ALL).all() as AgentSettingRow[]
}

/** Load the cache from the table for the CURRENT connection. Called by `initDatabase()` after the migrations. */
export function loadAgentSettingsCache(): void {
  const next = new Map<string, AgentSettingRow>()
  for (const row of readTable()) next.set(cacheKey(row.agent_id, row.setting_key), row)
  rows = next
  owner = { handle: db, epoch: null }
}

/** Re-read the table: for a script, a test, or a bypass writer (deleteTenant) that wrote `agent_settings` directly. */
export function reloadAgentSettingsCache(): void {
  loadAgentSettingsCache()
}

/** Forget the cache (the next reads go to the table until the next load). */
export function clearAgentSettingsCache(): void {
  rows = null
  owner = null
}

/** A synchronous reader: on the PG backend an unloaded cache is an error that names the loader. */
function liveForRead(): ReturnType<typeof live> {
  const map = live()
  if (map === null && dbxDialect() === 'pg') throw notLoadedInPg('loadAgentSettingsCacheAsync()')
  return map
}

function live(): Map<string, AgentSettingRow> | null {
  return rows !== null && ownerLive(owner) ? rows : null
}

export function cachedAgentSetting(agentId: string, key: AgentSettingKey): AgentSettingRow | undefined | null {
  const map = liveForRead()
  if (map === null) return null
  const row = map.get(cacheKey(agentId, key))
  return row === undefined ? undefined : { ...row }
}

export function cachedAgentSettingsByKey(key: AgentSettingKey): Record<string, unknown> | null {
  const map = liveForRead()
  if (map === null) return null
  const out: Record<string, unknown> = {}
  for (const row of map.values()) {
    if (row.setting_key !== key) continue
    try { out[row.agent_id] = JSON.parse(row.setting_value) } catch { /* skip a corrupt row */ }
  }
  return out
}

/** After a write: put the row the database now holds in the cache (only if the cache is live). */
export function cacheAfterAgentSettingWrite(agentId: string, key: AgentSettingKey): void {
  const map = live()
  if (map === null) return
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM agent_settings WHERE agent_id = ? AND setting_key = ?`)
    .get(agentId, key) as AgentSettingRow | undefined
  const k = cacheKey(agentId, key)
  if (row === undefined) map.delete(k)
  else map.set(k, row)
}

/**
 * Load the cache through the facade (`dbx.all`: a plain SELECT, the same text on both engines). On the PG backend the
 * cache then belongs to that backend's epoch; on SQLite it belongs to the handle, as the synchronous load makes it.
 * If the backend was switched while the rows were read, they belong to nobody and are dropped.
 */
export async function loadAgentSettingsCacheAsync(): Promise<void> {
  const mine = ownerNow()
  const all = await dbx.all<AgentSettingRow>(SELECT_ALL)
  if (!ownerLive(mine)) return
  const next: Map<string, AgentSettingRow> = new Map()
  for (const row of all) next.set(cacheKey(row.agent_id, row.setting_key), row)
  rows = next
  owner = mine
}

/**
 * After a write, from an async writer: on the PG backend the row is read back with an awaited `dbx.get` and put in the
 * cache (only if the cache is live for this backend); on SQLite it is the synchronous read-back of cacheAfterAgentSettingWrite.
 * Known limit on PG: two overlapping writers can leave the cache stale until the cross-process invalidation of P2-5;
 * a test with one connection does not see it.
 * `ops` is the handle the read-back runs on: the transaction handle of a writer that has not committed yet (the outer
 * dbx is refused inside a transaction body on PG and would not see the uncommitted row). The cache then holds the
 * uncommitted value; a caller whose transaction rolls back re-reads the cache afterwards.
 */
export async function cacheAfterAgentSettingWriteAsync(agentId: string, key: AgentSettingKey, ops: SqlOps = dbx): Promise<void> {
  if (dbxDialect() !== 'pg') {
    cacheAfterAgentSettingWrite(agentId, key)
    return
  }
  const map = live()
  if (map === null) return
  const k = cacheKey(agentId, key)
  const row = await ops.get<AgentSettingRow>(`SELECT ${SELECT_COLUMNS} FROM agent_settings WHERE agent_id = ? AND setting_key = ?`, agentId, key)
  // `map` is the map checked above: if the backend was switched meanwhile and the cache reloaded, the reloaded one is a
  // different object and this (older) row lands in the dead one
  if (row === undefined) map.delete(k)
  else map.set(k, row)
}

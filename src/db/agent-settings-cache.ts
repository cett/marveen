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
import type { AgentSettingKey, AgentSettingRow } from './agent-settings.js'

const SELECT_COLUMNS = 'agent_id, setting_key, setting_value, tenant_id, updated_at'
const SELECT_ALL = `SELECT ${SELECT_COLUMNS} FROM agent_settings`

function cacheKey(agentId: string, key: AgentSettingKey): string {
  return `${agentId}\u0000${key}`
}

let rows: Map<string, AgentSettingRow> | null = null
let cachedFor: unknown = null

function readTable(): AgentSettingRow[] {
  return db.prepare(SELECT_ALL).all() as AgentSettingRow[]
}

/** Load the cache from the table for the CURRENT connection. Called by `initDatabase()` after the migrations. */
export function loadAgentSettingsCache(): void {
  const next = new Map<string, AgentSettingRow>()
  for (const row of readTable()) next.set(cacheKey(row.agent_id, row.setting_key), row)
  rows = next
  cachedFor = db
}

/** Re-read the table: for a script, a test, or a bypass writer (deleteTenant) that wrote `agent_settings` directly. */
export function reloadAgentSettingsCache(): void {
  loadAgentSettingsCache()
}

/** Forget the cache (the next reads go to the table until the next load). */
export function clearAgentSettingsCache(): void {
  rows = null
  cachedFor = null
}

function live(): Map<string, AgentSettingRow> | null {
  return rows !== null && cachedFor === db ? rows : null
}

export function cachedAgentSetting(agentId: string, key: AgentSettingKey): AgentSettingRow | undefined | null {
  const map = live()
  if (map === null) return null
  const row = map.get(cacheKey(agentId, key))
  return row === undefined ? undefined : { ...row }
}

export function cachedAgentSettingsByKey(key: AgentSettingKey): Record<string, unknown> | null {
  const map = live()
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

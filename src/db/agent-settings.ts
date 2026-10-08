// Read/write access to agent_settings (migration 0058; #985 group 3/8).
//
// Backs three per-agent config JSON side-cars: store/context-guard.json,
// store/auto-restart.json, and the config half of store/context-restart-gate.json
// (the run-state half, context-restart-gate-state.json, stays file-based --
// group 4/8, no HTTP route touches it). One row per (agent_id, setting_key);
// setting_value is the normalized config object as JSON text -- the three
// configs have unrelated shapes, so this stays a single narrow module rather
// than three near-identical ones.
//
// Unlike egress-allowlist.ts (module has no tenant knowledge of its own,
// tenant_id is just a filter the caller passes through), this module also
// has no tenant knowledge -- the CALLER (agents-process.ts route, or the
// importer below) resolves which tenant a row belongs to via
// agentBelongsToTenant()/resolveAgentOwningTenantId() (db/agents.ts) and
// passes it in. Keeping that resolution out of this module mirrors the
// existing db/*.ts split (agents.ts owns tenant_agent_availability, this
// module just stores what it's told).

import { db } from './connection.js'

export type AgentSettingKey = 'context_guard' | 'auto_restart' | 'context_restart_gate'

export interface AgentSettingRow {
  agent_id: string
  setting_key: AgentSettingKey
  setting_value: string
  tenant_id: string
  updated_at: number
}

const SELECT_COLUMNS = 'agent_id, setting_key, setting_value, tenant_id, updated_at'

export function getAgentSetting(agentId: string, key: AgentSettingKey): AgentSettingRow | undefined {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM agent_settings WHERE agent_id = ? AND setting_key = ?`)
    .get(agentId, key) as AgentSettingRow | undefined
}

/**
 * Upsert one agent's setting. `value` is JSON-stringified as stored (callers
 * pass the already-normalized config object, mirroring how the JSON
 * side-cars held one normalized entry per agent). `tenantId` defaults to
 * 'default' for callers (tests, scripts) that have no tenant context --
 * the route always resolves and passes the real owning tenant.
 */
export function setAgentSetting(agentId: string, key: AgentSettingKey, value: unknown, tenantId = 'default'): void {
  db.prepare(`
    INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(agent_id, setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      tenant_id = excluded.tenant_id,
      updated_at = excluded.updated_at
  `).run(agentId, key, JSON.stringify(value), tenantId)
}

/**
 * One-time import of a JSON side-car's `{ [agentId]: config }` map into
 * agent_settings, mirroring migrateScheduleLastRunFromFile's (db/tasks.ts)
 * "only if absent" idempotence -- INSERT OR IGNORE per row, so a later
 * dashboard edit (or a prior boot's import) is never clobbered by a stale
 * file re-read after restart. `resolveTenantId` lets the caller (db/index.ts)
 * stamp each imported row with its agent's actual owning tenant instead of a
 * blind 'default', using the same lookup the write-check itself uses (see
 * db/agents.ts's resolveAgentOwningTenantId/agentBelongsToTenant). Returns
 * the number of rows actually inserted.
 */
export function importAgentSettingsFromFile(
  key: AgentSettingKey,
  entries: Record<string, unknown>,
  resolveTenantId: (agentId: string) => string,
): number {
  let migrated = 0
  const stmt = db.prepare(`
    INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT DO NOTHING
  `)
  for (const [agentId, cfg] of Object.entries(entries)) {
    if (cfg === null || cfg === undefined) continue
    if (stmt.run(agentId, key, JSON.stringify(cfg), resolveTenantId(agentId)).changes > 0) migrated++
  }
  return migrated
}

/** All agents with an explicit row for `key`, keyed by agent_id, parsed
 *  back to objects. Mirrors the JSON side-cars' readAllXConfigs() shape --
 *  used by fleet-transfer.ts export and by any future "list every agent's
 *  config" caller. */
export function listAgentSettingsByKey(key: AgentSettingKey): Record<string, unknown> {
  const rows = db
    .prepare(`SELECT agent_id, setting_value FROM agent_settings WHERE setting_key = ?`)
    .all(key) as { agent_id: string; setting_value: string }[]
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    try { out[row.agent_id] = JSON.parse(row.setting_value) } catch { /* skip a corrupt row */ }
  }
  return out
}

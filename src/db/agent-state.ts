// Read/write access to agent_state (migration 0060; #985 group 4/8).
//
// Backs per-agent RUNTIME state, as opposed to agent_settings' operator
// CONFIG (migration 0058, see agent-settings.ts's header for the
// settings-vs-state distinction). Same no-tenant-knowledge shape as
// agent-settings.ts: the caller resolves and passes tenant_id, this module
// just stores what it's told.

import { db } from './connection.js'

export type AgentStateKey = 'gate_run_state'

export interface AgentStateRow {
  agent_id: string
  state_key: AgentStateKey
  state_value: string
  tenant_id: string
  updated_at: number
}

const SELECT_COLUMNS = 'agent_id, state_key, state_value, tenant_id, updated_at'

export function getAgentState(agentId: string, key: AgentStateKey): AgentStateRow | undefined {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM agent_state WHERE agent_id = ? AND state_key = ?`)
    .get(agentId, key) as AgentStateRow | undefined
}

/** Upsert one agent's state. `tenantId` defaults to 'default' for callers
 *  with no tenant context (tests, scripts, or -- for this table's current
 *  sole consumer -- an internal runner with no per-request tenant at all). */
export function setAgentState(agentId: string, key: AgentStateKey, value: unknown, tenantId = 'default'): void {
  db.prepare(`
    INSERT INTO agent_state (agent_id, state_key, state_value, tenant_id, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(agent_id, state_key) DO UPDATE SET
      state_value = excluded.state_value,
      updated_at = excluded.updated_at
  `).run(agentId, key, JSON.stringify(value), tenantId)
}

/**
 * One-time import of a JSON side-car's `{ [agentId]: state }` map into
 * agent_state, mirroring importAgentSettingsFromFile's (agent-settings.ts)
 * "only if absent" idempotence via INSERT OR IGNORE. Returns the number of
 * rows actually inserted.
 */
export function importAgentStateFromFile(key: AgentStateKey, entries: Record<string, unknown>): number {
  let migrated = 0
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agent_state (agent_id, state_key, state_value, tenant_id, updated_at)
    VALUES (?, ?, ?, 'default', unixepoch())
  `)
  for (const [agentId, state] of Object.entries(entries)) {
    if (state === null || state === undefined) continue
    if (stmt.run(agentId, key, JSON.stringify(state)).changes > 0) migrated++
  }
  return migrated
}

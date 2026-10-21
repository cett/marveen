// Read/write access to agent_state (migration 0060; #985 group 4/8).
//
// Backs per-agent RUNTIME state, as opposed to agent_settings' operator
// CONFIG (migration 0058, see agent-settings.ts's header for the
// settings-vs-state distinction). Same no-tenant-knowledge shape as
// agent-settings.ts: the caller resolves and passes tenant_id, this module
// just stores what it's told.

import { db } from './connection.js'
import { dbx } from './facade.js'

export const AGENT_STATE_KEYS = [
  'gate_run_state',
  'kanban_audit_last_audit_at',
  'blackboard_hygiene_nudges',
  'blackboard_hygiene_last_sweep',
] as const

export type AgentStateKey = (typeof AGENT_STATE_KEYS)[number]

export interface AgentStateRow {
  agent_id: string
  state_key: AgentStateKey
  state_value: string
  tenant_id: string
  updated_at: number
}

const SELECT_COLUMNS = 'agent_id, state_key, state_value, tenant_id, updated_at'

const SELECT_ONE = `SELECT ${SELECT_COLUMNS} FROM agent_state WHERE agent_id = ? AND state_key = ?`

const UPSERT = `
    INSERT INTO agent_state (agent_id, state_key, state_value, tenant_id, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(agent_id, state_key) DO UPDATE SET
      state_value = excluded.state_value,
      updated_at = excluded.updated_at
  `

// The first module on the async db facade (1017 Phase 1 pilot): both operations go through `dbx` and return
// a Promise. Read-modify-write over the two calls is NOT atomic (another caller can run between them): the
// only RMW user today is the context restart gate, which runs one sweep timer per agent, so there is no
// concurrent run for the same agent.
export function getAgentState(agentId: string, key: AgentStateKey): Promise<AgentStateRow | undefined> {
  return dbx.get<AgentStateRow>(SELECT_ONE, agentId, key)
}

/** Upsert one agent's state. `tenantId` defaults to 'default' for callers
 *  with no tenant context (tests, scripts, or -- for this table's current
 *  sole consumer -- an internal runner with no per-request tenant at all). */
export async function setAgentState(agentId: string, key: AgentStateKey, value: unknown, tenantId = 'default'): Promise<void> {
  await dbx.run(UPSERT, agentId, key, JSON.stringify(value), tenantId)
}

// BOOT-SYNCHRONOUS twins. initDatabase() runs a synchronous chain (db/index.ts: the one-time importers of the
// JSON side-cars), which cannot await. These two keep the raw handle and are for that chain ONLY: nothing else
// may call them (a test pins this). The Phase 2 initDatabase() is asynchronous and the twins go away with it.
export function getAgentStateSync(agentId: string, key: AgentStateKey): AgentStateRow | undefined {
  return db.prepare(SELECT_ONE).get(agentId, key) as AgentStateRow | undefined
}

export function setAgentStateSync(agentId: string, key: AgentStateKey, value: unknown, tenantId = 'default'): void {
  db.prepare(UPSERT).run(agentId, key, JSON.stringify(value), tenantId)
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
    INSERT INTO agent_state (agent_id, state_key, state_value, tenant_id, updated_at)
    VALUES (?, ?, ?, 'default', unixepoch())
    ON CONFLICT DO NOTHING
  `)
  for (const [agentId, state] of Object.entries(entries)) {
    if (state === null || state === undefined) continue
    if (stmt.run(agentId, key, JSON.stringify(state)).changes > 0) migrated++
  }
  return migrated
}

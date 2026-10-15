// Database side of the OTLP log export (OTel H5a, src/otel-logs.ts maps the rows, the push exporter sends
// them). Two rules shape this file:
//
//   1. Every SELECT names its columns. The content columns of the audit tables (config_change_log.old_value /
//      new_value, agent_audit_log.detail / entity_id, approval_events.ref, rbac_shadow_log.route, which is the
//      raw request path) are never read here, so a later change to the mapper cannot export them by accident.
//   2. A source's cursor is the highest row id already pushed. It starts at the source's current highest id the
//      first time the export runs, so enabling it does not replay the history of an audit table.

import { randomBytes } from 'node:crypto'
import { db } from './connection.js'

export const OTEL_LOG_SOURCES = [
  'approval_events', 'rbac_shadow_log', 'config_change_log', 'agent_audit_log', 'hook_audit_log',
  'fleet_blackboard_history', 'kanban_card_events',
] as const
export type OtelLogSource = (typeof OTEL_LOG_SOURCES)[number]

export interface ApprovalEventLogRow {
  id: number
  approval_id: string
  tenant_id: string | null
  event: string
  reason: string | null
  actor: string | null
  created_at: number
}

export interface RbacDecisionLogRow {
  id: number
  ts: number
  tenant_id: string | null
  principal_kind: string
  principal: string
  role: string
  method: string
  permission: string
  decision: string
  reason: string
}

export interface ConfigChangeExportRow {
  id: number
  key: string
  actor: string
  created_at: number
}

export interface AgentAuditExportRow {
  id: number
  agent_id: string
  entity: string
  action: string
  created_at: number
}

export interface HookAuditExportRow {
  id: number
  ts: number
  agent_id: string | null
  hook_type: string
  verdict: string
  trigger_source: string | null
  reason: string | null
  tenant_id: string | null
}

// What an agent announced on the blackboard: who and which state. The summary text and the task reference are not read.
export interface BlackboardExportRow {
  id: number
  agent_id: string
  status: string
  created_at: number
}

// A kanban card moving between columns: the card id (only as a keyed hash, to follow one card), the two statuses and
// the actor. The title, description and comments are not in this table and are not read.
export interface KanbanEventExportRow {
  id: number
  card_id: string
  from_status: string | null
  to_status: string
  actor: string | null
  created_at: number
}

export interface OtelLogRows {
  approval_events: ApprovalEventLogRow[]
  rbac_shadow_log: RbacDecisionLogRow[]
  config_change_log: ConfigChangeExportRow[]
  agent_audit_log: AgentAuditExportRow[]
  hook_audit_log: HookAuditExportRow[]
  fleet_blackboard_history: BlackboardExportRow[]
  kanban_card_events: KanbanEventExportRow[]
}

function currentMaxId(source: OtelLogSource): number {
  // One fixed statement per source: a table name is never built from a variable.
  const row = (() => {
    switch (source) {
      case 'approval_events': return db.prepare('SELECT MAX(id) AS m FROM approval_events').get()
      case 'rbac_shadow_log': return db.prepare('SELECT MAX(id) AS m FROM rbac_shadow_log').get()
      case 'config_change_log': return db.prepare('SELECT MAX(id) AS m FROM config_change_log').get()
      case 'agent_audit_log': return db.prepare('SELECT MAX(id) AS m FROM agent_audit_log').get()
      case 'hook_audit_log': return db.prepare('SELECT MAX(id) AS m FROM hook_audit_log').get()
      case 'fleet_blackboard_history': return db.prepare('SELECT MAX(id) AS m FROM fleet_blackboard_history').get()
      case 'kanban_card_events': return db.prepare('SELECT MAX(id) AS m FROM kanban_card_events').get()
    }
  })() as { m: number | null } | undefined
  return row?.m ?? 0
}

// The cursor of one source; created at the source's current highest id when it does not exist yet.
export function getOtelLogCursor(source: OtelLogSource): number {
  const existing = db.prepare('SELECT last_id FROM otel_logs_export_state WHERE source = ?').get(source) as
    { last_id: number } | undefined
  if (existing) return existing.last_id
  const start = currentMaxId(source)
  db.prepare('INSERT INTO otel_logs_export_state (source, last_id) VALUES (?, ?) ON CONFLICT(source) DO NOTHING').run(source, start)
  const row = db.prepare('SELECT last_id FROM otel_logs_export_state WHERE source = ?').get(source) as { last_id: number }
  return row.last_id
}

// Moves a cursor forward, never back (a stale caller cannot make the export replay rows).
export function setOtelLogCursor(source: OtelLogSource, lastId: number): void {
  db.prepare(
    `INSERT INTO otel_logs_export_state (source, last_id) VALUES (?, ?)
     ON CONFLICT(source) DO UPDATE SET last_id = CASE WHEN excluded.last_id > otel_logs_export_state.last_id THEN excluded.last_id ELSE otel_logs_export_state.last_id END`,
  ).run(source, lastId)
}

// The salt of the actor pseudonym, created on first use. 32 random bytes, hex.
export function getOtelLogHashSalt(): string {
  db.prepare('INSERT INTO otel_logs_hash_salt (id, salt) VALUES (1, ?) ON CONFLICT(id) DO NOTHING').run(randomBytes(32).toString('hex'))
  return (db.prepare('SELECT salt FROM otel_logs_hash_salt WHERE id = 1').get() as { salt: string }).salt
}

// Gate verdict counts (migration 0083), for the marveen.gate.decisions counter: one row per gate, decision and
// reason code, with the running count and the time of the first one.
export interface GateDecisionCountRow {
  gate: string
  decision: string
  reason: string
  count: number
  first_at: number
}
export function getGateDecisionCounts(): GateDecisionCountRow[] {
  return db.prepare('SELECT gate, decision, reason, count, first_at FROM gate_decision_counts ORDER BY gate, decision, reason')
    .all() as GateDecisionCountRow[]
}

// The next batch of every source, oldest first, `limit` rows per source. rbac 'permitted' rows are not
// exported: that is request-level traffic of non-admin callers, a volume the log stream should not carry
// (the refusals, which is what an audit reads, are exported).
export function getOtelLogBatch(limit: number): OtelLogRows {
  return {
    approval_events: db.prepare(
      `SELECT id, approval_id, tenant_id, event, reason, actor, created_at
       FROM approval_events WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('approval_events'), limit) as ApprovalEventLogRow[],
    rbac_shadow_log: db.prepare(
      `SELECT id, ts, tenant_id, principal_kind, principal, role, method, permission, decision, reason
       FROM rbac_shadow_log WHERE id > ? AND decision != 'permitted' ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('rbac_shadow_log'), limit) as RbacDecisionLogRow[],
    config_change_log: db.prepare(
      `SELECT id, key, actor, created_at FROM config_change_log WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('config_change_log'), limit) as ConfigChangeExportRow[],
    agent_audit_log: db.prepare(
      `SELECT id, agent_id, entity, action, created_at FROM agent_audit_log WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('agent_audit_log'), limit) as AgentAuditExportRow[],
    // Only the refusals. tool_name, content_hash and session_id are not read: the row says which gate said no,
    // for which agent, with which reason code. (The allow rows of browser-content-notice and the handoff rows of
    // the context watchdog are not security events.)
    hook_audit_log: db.prepare(
      `SELECT id, ts, agent_id, hook_type, verdict, trigger_source, reason, tenant_id
       FROM hook_audit_log WHERE id > ? AND verdict IN ('deny', 'defer') ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('hook_audit_log'), limit) as HookAuditExportRow[],
    fleet_blackboard_history: db.prepare(
      `SELECT id, agent_id, status, created_at FROM fleet_blackboard_history WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('fleet_blackboard_history'), limit) as BlackboardExportRow[],
    kanban_card_events: db.prepare(
      `SELECT id, card_id, from_status, to_status, actor, created_at FROM kanban_card_events WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(getOtelLogCursor('kanban_card_events'), limit) as KanbanEventExportRow[],
  }
}

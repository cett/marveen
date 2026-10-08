// db/overview.ts -- read-only aggregates behind GET /api/overview.
//
// Each function throws when its table is absent (fresh installs before the
// migration ran); the route wraps every call and degrades to a zero value.
// tenantId null = fleet-wide (admin default), a string = narrow to one tenant.

import { db } from './connection.js'

function tenantFilter(tenantId: string | null): { tc: string; tp: string[] } {
  return tenantId ? { tc: ' AND tenant_id = ?', tp: [tenantId] } : { tc: '', tp: [] }
}

export function countOverviewMemories(tenantId: string | null): number {
  const { tc, tp } = tenantFilter(tenantId)
  const row = db.prepare(`SELECT COUNT(*) as c FROM memories WHERE 1=1${tc}`).get(...tp) as { c: number }
  return row.c
}

export function countOverviewMemoryCategories(tenantId: string | null): number {
  const { tc, tp } = tenantFilter(tenantId)
  const row = db.prepare(`SELECT COUNT(DISTINCT category) as c FROM memories WHERE 1=1${tc}`).get(...tp) as { c: number }
  return row.c
}

export function countOverviewArtifacts(tenantId: string | null): number {
  const { tc, tp } = tenantFilter(tenantId)
  const row = db.prepare(`SELECT COUNT(*) as c FROM artifacts WHERE 1=1${tc}`).get(...tp) as { c: number }
  return row.c
}

// Per-agent last token_usage timestamp (ms epoch). Not tenant-scoped.
export function listOverviewLastActive(): { agent: string; last_active: number }[] {
  return db.prepare(
    'SELECT agent, MAX(timestamp) as last_active FROM token_usage GROUP BY agent'
  ).all() as { agent: string; last_active: number }[]
}

export function sumOverviewTokensSince(sinceSec: number, tenantId: string | null): number {
  const { tc, tp } = tenantFilter(tenantId)
  const rows = db.prepare(
    `SELECT input_tokens, output_tokens FROM token_usage WHERE timestamp >= ?${tc}`
  ).all(sinceSec, ...tp) as { input_tokens: number; output_tokens: number }[]
  let total = 0
  for (const r of rows) total += r.input_tokens + r.output_tokens
  return total
}

export function countOverviewPendingApprovals(tenantId: string | null): number {
  const { tc, tp } = tenantFilter(tenantId)
  const row = db.prepare(`SELECT COUNT(*) as c FROM approvals WHERE status='pending'${tc}`).get(...tp) as { c: number }
  return row.c
}

// Error/timeout spans since sinceMs (otel_spans.start_ms is milliseconds). Not tenant-scoped.
export function countOverviewErrorSpansSince(sinceMs: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM otel_spans WHERE status IN ('error','timeout') AND start_ms >= ?"
  ).get(sinceMs) as { c: number }
  return row.c
}

export function countOverviewPendingMessages(tenantId: string | null): number {
  const { tc, tp } = tenantFilter(tenantId)
  const row = db.prepare(`SELECT COUNT(*) as c FROM agent_messages WHERE status='pending'${tc}`).get(...tp) as { c: number }
  return row.c
}

// Legacy scheduled_tasks table: no tenant_id column, fleet-level figure only.
export function countOverviewStuckScheduledTasks(nextRunBeforeSec: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM scheduled_tasks WHERE status='active' AND next_run < ?"
  ).get(nextRunBeforeSec) as { c: number }
  return row.c
}

export function listOverviewRecentMemories(
  sinceSec: number,
  tenantId: string | null,
): { content: string; created_at: number; agent_id: string }[] {
  const { tc, tp } = tenantFilter(tenantId)
  return db.prepare(
    `SELECT content, created_at, agent_id FROM memories WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 20`
  ).all(sinceSec, ...tp) as { content: string; created_at: number; agent_id: string }[]
}

export function listOverviewRecentMessages(
  sinceSec: number,
  tenantId: string | null,
): { from_agent: string; to_agent: string; content: string; created_at: number }[] {
  const { tc, tp } = tenantFilter(tenantId)
  return db.prepare(
    `SELECT from_agent, to_agent, content, created_at FROM agent_messages WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 15`
  ).all(sinceSec, ...tp) as { from_agent: string; to_agent: string; content: string; created_at: number }[]
}

export function listOverviewRecentApprovals(
  sinceSec: number,
  tenantId: string | null,
): { agent_id: string; action_description: string; status: string; created_at: number }[] {
  const { tc, tp } = tenantFilter(tenantId)
  return db.prepare(
    `SELECT agent_id, action_description, status, created_at FROM approvals WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 10`
  ).all(sinceSec, ...tp) as { agent_id: string; action_description: string; status: string; created_at: number }[]
}

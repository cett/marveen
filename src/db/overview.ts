// db/overview.ts -- read-only aggregates behind GET /api/overview.
//
// Each function throws when its table is absent (fresh installs before the
// migration ran); the route wraps every call and degrades to a zero value.
// tenantId null = fleet-wide (admin default), a string = narrow to one tenant.

import { dbx } from './facade.js'

function tenantFilter(tenantId: string | null): { tc: string; tp: string[] } {
  return tenantId ? { tc: ' AND tenant_id = ?', tp: [tenantId] } : { tc: '', tp: [] }
}

export async function countOverviewMemories(tenantId: string | null): Promise<number> {
  const { tc, tp } = tenantFilter(tenantId)
  const row = (await dbx.get(`SELECT COUNT(*) as c FROM memories WHERE 1=1${tc}`, ...tp)) as { c: number }
  return row.c
}

export async function countOverviewMemoryCategories(tenantId: string | null): Promise<number> {
  const { tc, tp } = tenantFilter(tenantId)
  const row = (await dbx.get(`SELECT COUNT(DISTINCT category) as c FROM memories WHERE 1=1${tc}`, ...tp)) as { c: number }
  return row.c
}

export async function countOverviewArtifacts(tenantId: string | null): Promise<number> {
  const { tc, tp } = tenantFilter(tenantId)
  const row = (await dbx.get(`SELECT COUNT(*) as c FROM artifacts WHERE 1=1${tc}`, ...tp)) as { c: number }
  return row.c
}

// Per-agent last token_usage timestamp (ms epoch). Not tenant-scoped.
export async function listOverviewLastActive(): Promise<{ agent: string; last_active: number }[]> {
  return (await dbx.all('SELECT agent, MAX(timestamp) as last_active FROM token_usage GROUP BY agent')) as { agent: string; last_active: number }[]
}

export async function sumOverviewTokensSince(sinceSec: number, tenantId: string | null): Promise<number> {
  const { tc, tp } = tenantFilter(tenantId)
  const rows = (await dbx.all(`SELECT input_tokens, output_tokens FROM token_usage WHERE timestamp >= ?${tc}`, sinceSec, ...tp)) as { input_tokens: number; output_tokens: number }[]
  let total = 0
  for (const r of rows) total += r.input_tokens + r.output_tokens
  return total
}

export async function countOverviewPendingApprovals(tenantId: string | null): Promise<number> {
  const { tc, tp } = tenantFilter(tenantId)
  const row = (await dbx.get(`SELECT COUNT(*) as c FROM approvals WHERE status='pending'${tc}`, ...tp)) as { c: number }
  return row.c
}

// Error/timeout spans since sinceMs (otel_spans.start_ms is milliseconds). Not tenant-scoped.
export async function countOverviewErrorSpansSince(sinceMs: number): Promise<number> {
  const row = (await dbx.get("SELECT COUNT(*) as c FROM otel_spans WHERE status IN ('error','timeout') AND start_ms >= ?", sinceMs)) as { c: number }
  return row.c
}

export interface OverviewErrorSpan {
  trace_id: string
  span_id: string
  agent_id: string
  operation: string
  status: 'error' | 'timeout'
  start_ms: number
  duration_ms: number | null
  // A short what-was-it label built only from the attribute keys the writers of these spans set
  // (a schedule name, an HTTP method + route template + status); never the raw attributes.
  detail: string
}

function errorSpanDetail(operation: string, attributes: string | null): string {
  if (!attributes) return ''
  try {
    const a = JSON.parse(attributes) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 120) : '')
    if (operation === 'http.server') return [str(a.http_method), str(a.http_route), str(a.http_status)].filter(Boolean).join(' ')
    return str(a.schedule)
  } catch {
    return ''
  }
}

// The newest error/timeout spans since sinceMs, the rows behind countOverviewErrorSpansSince.
export async function listOverviewErrorSpansSince(sinceMs: number, limit: number): Promise<OverviewErrorSpan[]> {
  const rows = (await dbx.all(`SELECT trace_id, span_id, agent_id, operation, status, start_ms, end_ms, attributes
       FROM otel_spans WHERE status IN ('error','timeout') AND start_ms >= ?
      ORDER BY start_ms DESC LIMIT ?`, sinceMs, limit)) as Array<{
    trace_id: string; span_id: string; agent_id: string; operation: string; status: 'error' | 'timeout'
    start_ms: number; end_ms: number | null; attributes: string | null
  }>
  return rows.map(r => ({
    trace_id: r.trace_id, span_id: r.span_id, agent_id: r.agent_id, operation: r.operation, status: r.status,
    start_ms: r.start_ms,
    duration_ms: r.end_ms == null ? null : Math.max(0, r.end_ms - r.start_ms),
    detail: errorSpanDetail(r.operation, r.attributes),
  }))
}

export async function countOverviewPendingMessages(tenantId: string | null): Promise<number> {
  const { tc, tp } = tenantFilter(tenantId)
  const row = (await dbx.get(`SELECT COUNT(*) as c FROM agent_messages WHERE status='pending'${tc}`, ...tp)) as { c: number }
  return row.c
}

// Legacy scheduled_tasks table: no tenant_id column, fleet-level figure only.
export async function countOverviewStuckScheduledTasks(nextRunBeforeSec: number): Promise<number> {
  const row = (await dbx.get("SELECT COUNT(*) as c FROM scheduled_tasks WHERE status='active' AND next_run < ?", nextRunBeforeSec)) as { c: number }
  return row.c
}

export async function listOverviewRecentMemories(
  sinceSec: number,
  tenantId: string | null,
): Promise<{ content: string; created_at: number; agent_id: string }[]> {
  const { tc, tp } = tenantFilter(tenantId)
  return (await dbx.all(`SELECT content, created_at, agent_id FROM memories WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 20`, sinceSec, ...tp)) as { content: string; created_at: number; agent_id: string }[]
}

export async function listOverviewRecentMessages(
  sinceSec: number,
  tenantId: string | null,
): Promise<{ from_agent: string; to_agent: string; content: string; created_at: number }[]> {
  const { tc, tp } = tenantFilter(tenantId)
  return (await dbx.all(`SELECT from_agent, to_agent, content, created_at FROM agent_messages WHERE created_at >= ?${tc} ORDER BY created_at DESC LIMIT 15`, sinceSec, ...tp)) as { from_agent: string; to_agent: string; content: string; created_at: number }[]
}

export async function listOverviewRecentApprovals(
  sinceSec: number,
  tenantId: string | null,
): Promise<{ agent_id: string; action_description: string; status: string; created_at: number }[]> {
  const { tc, tp } = tenantFilter(tenantId)
  return (await dbx.all(
    // approvals has requested_at, not created_at; the alias keeps the shape the route reads.
    `SELECT agent_id, action_description, status, requested_at AS created_at FROM approvals WHERE requested_at >= ?${tc} ORDER BY requested_at DESC LIMIT 10`,
    sinceSec,
    ...tp,
  )) as { agent_id: string; action_description: string; status: string; created_at: number }[]
}

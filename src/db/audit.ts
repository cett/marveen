// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { logger } from '../logger.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { db } from './connection.js'
import { upsertOtelSpan } from './observability.js'

// mcp__<server>__<tool> -- split into (server, tool) for the OTel span
// attributes. Split on the FIRST "__" so a server name that itself contains
// underscores (e.g. mcp__plugin_telegram_telegram__reply) still keeps its
// full name in mcp_server. Non-MCP tool names (Bash, Read, ...) don't match
// and get neither attribute. Moved here (was private to
// web/routes/tool-log.ts) because logToolCall is now the sole tool.call
// span writer -- see the retirement of tool_call_log in favor of otel_spans.
function mcpServerAndToolFromToolName(toolName: string): { server: string; tool: string } | undefined {
  const m = toolName.match(/^mcp__([^_].*?)__(.+)$/)
  return m ? { server: m[1], tool: m[2] } : undefined
}

// tool_call_log has been retired in favor of otel_spans: this now writes a
// closed `tool.<name>` OTel span directly (trace_id = session_id, span_id =
// the CC-native tool_use_id) instead of a separate table row. A missing
// traceId or agentId means the call can't be correlated or attributed, and
// otel_spans requires both (agent_id is NOT NULL, span_id is part of the
// primary key) -- such a call is logged and dropped rather than stored, a
// deliberate behavior change from the old table (which accepted nulls).
export function logToolCall(
  sessionId: string,
  toolName: string,
  inputSummary: string | null,
  success = true,
  agentId: string | null = null,
  traceId: string | null = null,
  durationMs: number | null = null,
): void {
  if (!traceId || !agentId) {
    logger.warn({ sessionId, toolName, traceId, agentId }, 'logToolCall: missing trace_id or agent_id, skipping tool.call span')
    return
  }
  const endMs = Date.now()
  const startMs = typeof durationMs === 'number' ? endMs - durationMs : endMs
  const mcp = mcpServerAndToolFromToolName(toolName)
  upsertOtelSpan({
    trace_id: sessionId,
    span_id: traceId,
    parent_span_id: null,
    agent_id: agentId,
    operation: `tool.${toolName}`,
    start_ms: startMs,
    end_ms: endMs,
    status: success ? 'ok' : 'error',
    attributes: JSON.stringify({
      tool_name: toolName,
      ...(inputSummary ? { input_summary: inputSummary } : {}),
      ...(mcp ? { mcp_server: mcp.server, mcp_tool: mcp.tool } : {}),
    }),
  })
}

// Shape kept for compatibility with existing readers/consumers even though
// the backing store is now otel_spans, not tool_call_log.
export interface ToolCallLogRow {
  id: number
  session_id: string
  tool_name: string
  input_summary: string | null
  success: number
  created_at: number
  agent_id: string | null
  trace_id: string | null
  duration_ms: number | null
}

export interface WorkflowCandidate {
  session_id: string
  tool_calls: ToolCallLogRow[]
  start_ts: number
  end_ts: number
  duration_minutes: number
}

interface OtelSpanRow {
  trace_id: string
  span_id: string
  agent_id: string
  operation: string
  start_ms: number
  end_ms: number | null
  status: string
  attributes: string | null
}

function toolCallRowFromSpan(span: OtelSpanRow, id: number): ToolCallLogRow {
  let attrs: { tool_name?: string; input_summary?: string } = {}
  try { attrs = span.attributes ? JSON.parse(span.attributes) : {} } catch { /* malformed attributes -- treat as empty */ }
  return {
    id,
    session_id: span.trace_id,
    tool_name: attrs.tool_name ?? span.operation.replace(/^tool\./, ''),
    input_summary: attrs.input_summary ?? null,
    success: span.status === 'error' ? 0 : 1,
    created_at: Math.floor(span.start_ms / 1000),
    agent_id: span.agent_id,
    trace_id: span.span_id,
    duration_ms: span.end_ms != null ? span.end_ms - span.start_ms : null,
  }
}

export function getRecentToolCalls(sinceSecs: number): ToolCallLogRow[] {
  const cutoffMs = Date.now() - sinceSecs * 1000
  // Ordered by rowid (= logging/insertion order), not the derived start_ms:
  // start_ms is computed as end_ms - duration_ms, so two calls logged a
  // millisecond apart with very different durations can invert on start_ms
  // alone. rowid matches the old tool_call_log's autoincrement-id ordering,
  // which is what callers actually rely on (calls in the order they happened).
  const rows = db.prepare(
    `SELECT trace_id, span_id, agent_id, operation, start_ms, end_ms, status, attributes
       FROM otel_spans
      WHERE operation LIKE 'tool.%' AND start_ms >= ?
      ORDER BY rowid ASC`,
  ).all(cutoffMs) as OtelSpanRow[]
  return rows.map((row, i) => toolCallRowFromSpan(row, i))
}

export function analyzeWorkflowCandidates(sinceSecs = 3600, minToolCalls = 5, gapSecs = 300): WorkflowCandidate[] {
  const calls = getRecentToolCalls(sinceSecs)
  if (calls.length === 0) return []

  // Group by session_id, then split by time gaps > gapSecs
  const bySession: Map<string, ToolCallLogRow[]> = new Map()
  for (const c of calls) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, [])
    bySession.get(c.session_id)!.push(c)
  }

  const candidates: WorkflowCandidate[] = []
  for (const [sessionId, sessionCalls] of bySession) {
    // Split into chunks by time gap
    const chunks: ToolCallLogRow[][] = []
    let current: ToolCallLogRow[] = [sessionCalls[0]]
    for (let i = 1; i < sessionCalls.length; i++) {
      if (sessionCalls[i].created_at - sessionCalls[i - 1].created_at > gapSecs) {
        chunks.push(current)
        current = []
      }
      current.push(sessionCalls[i])
    }
    chunks.push(current)

    for (const chunk of chunks) {
      if (chunk.length >= minToolCalls) {
        candidates.push({
          session_id: sessionId,
          tool_calls: chunk,
          start_ts: chunk[0].created_at,
          end_ts: chunk[chunk.length - 1].created_at,
          duration_minutes: Math.round((chunk[chunk.length - 1].created_at - chunk[0].created_at) / 60),
        })
      }
    }
  }

  return candidates
}

export interface SkillUsageRow {
  id: number
  agent_id: string
  skill_name: string
  trigger_type: 'tool_call' | 'skill_read'
  session_id: string | null
  created_at: number
}

export interface SkillUsageStatRow {
  skill_name: string
  call_count: number
  read_count: number
  total_count: number
  agent_count: number
  last_used_at: number
}

export function logSkillUsage(
  agentId: string,
  skillName: string,
  triggerType: 'tool_call' | 'skill_read',
  sessionId?: string | null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(agentId, skillName, triggerType, sessionId ?? null, now)
}

export function getSkillUsageRows(opts: {
  since?: number
  agentId?: string
  skillName?: string
  limit?: number
}): SkillUsageRow[] {
  const { since, agentId, skillName, limit = 500 } = opts
  const cutoff = since ? Math.floor(Date.now() / 1000) - since : 0
  const conditions: string[] = ['created_at >= ?']
  const params: unknown[] = [cutoff]
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId) }
  if (skillName) { conditions.push('skill_name = ?'); params.push(skillName) }
  params.push(limit)
  return db.prepare(
    `SELECT * FROM skill_usage WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params) as SkillUsageRow[]
}

export function getSkillUsageStats(sinceSecs?: number): SkillUsageStatRow[] {
  const cutoff = sinceSecs ? Math.floor(Date.now() / 1000) - sinceSecs : 0
  return db.prepare(`
    SELECT
      skill_name,
      SUM(CASE WHEN trigger_type = 'tool_call' THEN 1 ELSE 0 END) AS call_count,
      SUM(CASE WHEN trigger_type = 'skill_read' THEN 1 ELSE 0 END) AS read_count,
      COUNT(*) AS total_count,
      COUNT(DISTINCT agent_id) AS agent_count,
      MAX(created_at) AS last_used_at
    FROM skill_usage
    WHERE created_at >= ?
    GROUP BY skill_name
    ORDER BY total_count DESC
  `).all(cutoff) as SkillUsageStatRow[]
}

export interface SkillUsageSummaryRow {
  skill_name: string
  last_used_at: number
  total_count: number
  count_30d: number
  count_90d: number
}

export function getSkillUsageSummary(): SkillUsageSummaryRow[] {
  const now = Math.floor(Date.now() / 1000)
  const cutoff30 = now - 30 * 86400
  const cutoff90 = now - 90 * 86400
  return db.prepare(`
    SELECT
      skill_name,
      MAX(created_at) AS last_used_at,
      COUNT(*) AS total_count,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS count_30d,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS count_90d
    FROM skill_usage
    GROUP BY skill_name
    ORDER BY last_used_at DESC
  `).all(cutoff30, cutoff90) as SkillUsageSummaryRow[]
}

// Originally deny-only (the injection-detection gate); 'handoff' was added
// for the context watchdog's proactive-compaction rows and 'allow' gained a
// second producer (context-compact-monitor.sh's PreCompact rows) -- see
// src/watchdog-validation.ts for the query that correlates the two.
// trigger_source (migration 0038) names which of those two producers wrote
// a given handoff/PreCompact row directly, instead of leaving it to be
// inferred from the hook_type+verdict combination.

export interface HookAuditLogEntry {
  id: number
  ts: number
  agent_id: string | null
  hook_type: 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'Stop'
  verdict: 'allow' | 'deny' | 'defer' | 'handoff'
  tool_name: string | null
  content_hash: string | null
  reason: string | null
  session_id: string | null
  trigger_source: 'watchdog' | 'compact-monitor' | null
}

export function insertHookAuditLog(entry: {
  agent_id?: string | null
  hook_type: string
  verdict: string
  tool_name?: string | null
  content_hash?: string | null
  reason?: string | null
  session_id?: string | null
  trigger_source?: string | null
}): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    now,
    entry.agent_id ?? null,
    entry.hook_type,
    entry.verdict,
    entry.tool_name ?? null,
    entry.content_hash ?? null,
    entry.reason ?? null,
    entry.session_id ?? null,
    entry.trigger_source ?? null,
  )
}

export function listHookAuditLog(opts: {
  sinceSecs?: number
  verdict?: string
  agent_id?: string
  trigger_source?: string
  limit?: number
} = {}): HookAuditLogEntry[] {
  const clauses: string[] = []
  const params: unknown[] = []

  const sinceSecs = opts.sinceSecs ?? 3600
  const cutoff = Math.floor(Date.now() / 1000) - sinceSecs
  clauses.push('ts >= ?')
  params.push(cutoff)

  if (opts.verdict) { clauses.push('verdict = ?'); params.push(opts.verdict) }
  if (opts.agent_id) { clauses.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.trigger_source) { clauses.push('trigger_source = ?'); params.push(opts.trigger_source) }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(
    `SELECT * FROM hook_audit_log ${where} ORDER BY ts DESC LIMIT ?`,
  ).all(...params, limit) as HookAuditLogEntry[]
}

export function pruneHookAuditLog(olderThanSecs = 30 * 86400): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs
  db.prepare('DELETE FROM hook_audit_log WHERE ts < ?').run(cutoff)
}

// Pass null for oldValue/newValue when the registry entry is secret:true --
// this keeps secret values out of the audit trail entirely rather than
// relying on a UI to not display them.
export function logConfigChange(
  key: string,
  oldValue: string | number | null,
  newValue: string | number | null,
  actor: string,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(key, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), actor, now)
}

export interface ConfigChangeLogRow {
  id: number
  key: string
  old_value: string | null
  new_value: string | null
  actor: string
  created_at: number
}

export function getRecentConfigChanges(limit = 200): ConfigChangeLogRow[] {
  // id DESC as a tiebreaker: created_at has 1-second resolution, so two
  // saves in the same second would otherwise sort arbitrarily.
  return db.prepare('SELECT * FROM config_change_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as ConfigChangeLogRow[]
}

export interface StoreFileAuditRow {
  id: number
  rel_path: string
  event_type: string
  is_sensitive: number
  file_size: number | null
  agent: string | null
  created_at: number
}

export function logStoreFileEvent(
  relPath: string,
  eventType: string,
  isSensitive: number,
  fileSize: number | null,
  agent: string | null = null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO store_file_audit (rel_path, event_type, is_sensitive, file_size, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(relPath, eventType, isSensitive, fileSize, agent, now)
}

export function getRecentStoreFileEvents(limit = 200): StoreFileAuditRow[] {
  return db.prepare('SELECT * FROM store_file_audit ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as StoreFileAuditRow[]
}

export type AuditSource = 'config' | 'idea' | 'store' | 'diary' | 'agent' | 'hook'

export interface AuditLogEntry {
  id: number
  source: AuditSource
  created_at: number
  actor?: string
  // config
  key?: string
  old_value?: string | null
  new_value?: string | null
  // idea
  idea_id?: string
  from_status?: string | null
  to_status?: string
  note?: string | null
  // store
  rel_path?: string
  event_type?: string
  is_sensitive?: number
  file_size?: number | null
  // diary (daily_logs + memories)
  agent_id?: string
  content?: string
  category?: string
  keywords?: string
  entry_type?: 'log' | 'memory'
  // agent
  entity?: string
  action?: string
  entity_id?: string
  detail?: string
  // hook (hook_audit_log -- shares agent_id above for the acting agent)
  hook_type?: string
  verdict?: string
  tool_name?: string | null
  content_hash?: string | null
  reason?: string | null
  session_id?: string | null
}

export interface AgentAuditLogRow {
  id: number
  agent_id: string
  entity: string
  action: string
  entity_id: string | null
  detail: string | null
  created_at: number
}

export function writeAgentAuditLog(opts: {
  agent_id: string
  entity: 'memory' | 'kanban' | 'message' | 'agent' | 'blackboard' | 'approval'
  action: 'create' | 'update' | 'delete'
  entity_id?: string | number | null
  detail?: Record<string, unknown> | null
}): void {
  db.prepare(
    'INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(
    opts.agent_id,
    opts.entity,
    opts.action,
    opts.entity_id != null ? String(opts.entity_id) : null,
    opts.detail != null ? JSON.stringify(opts.detail) : null
  )
}

export function queryAuditLog(opts: {
  sources: AuditSource[]
  from?: number
  to?: number
  q?: string
  agent?: string
  limit: number
}): AuditLogEntry[] {
  const { sources, from, to, q, agent, limit } = opts
  const all: AuditSource[] = ['config', 'idea', 'store', 'diary', 'agent', 'hook']
  const active = sources.length > 0 ? sources : all

  const parts: AuditLogEntry[] = []

  if (active.includes('config')) {
    let sql = 'SELECT id, key, old_value, new_value, actor, created_at FROM config_change_log WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (q)    { sql += ' AND (key LIKE ? OR old_value LIKE ? OR new_value LIKE ? OR actor LIKE ?)'; const p = `%${q}%`; params.push(p, p, p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as ConfigChangeLogRow[]
    for (const r of rows) parts.push({ ...r, source: 'config' })
  }

  if (active.includes('idea')) {
    let sql = 'SELECT id, idea_id, from_status, to_status, actor, note, created_at FROM idea_status_log WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (q)    { sql += ' AND (idea_id LIKE ? OR to_status LIKE ? OR note LIKE ? OR actor LIKE ?)'; const p = `%${q}%`; params.push(p, p, p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as Array<{ id: number; idea_id: string; from_status: string | null; to_status: string; actor: string; note: string | null; created_at: number }>
    for (const r of rows) parts.push({ ...r, source: 'idea' })
  }

  if (active.includes('store')) {
    let sql = 'SELECT id, rel_path, event_type, is_sensitive, file_size, agent, created_at FROM store_file_audit WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (agent) { sql += ' AND agent = ?'; params.push(agent) }
    if (q)    { sql += ' AND (rel_path LIKE ? OR agent LIKE ?)'; const p = `%${q}%`; params.push(p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as StoreFileAuditRow[]
    for (const r of rows) parts.push({ ...r, source: 'store' })
  }

  if (active.includes('diary')) {
    // daily_logs
    let logSql = 'SELECT id, agent_id, content, created_at FROM daily_logs WHERE 1=1'
    const logParams: unknown[] = []
    if (from)  { logSql += ' AND created_at >= ?'; logParams.push(from) }
    if (to)    { logSql += ' AND created_at <= ?'; logParams.push(to) }
    if (agent) { logSql += ' AND agent_id = ?'; logParams.push(agent) }
    if (q)     { logSql += ' AND content LIKE ?'; logParams.push(`%${q}%`) }
    logSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; logParams.push(limit)
    const logRows = db.prepare(logSql).all(...logParams) as Array<{ id: number; agent_id: string; content: string; created_at: number }>
    for (const r of logRows) parts.push({ id: r.id, source: 'diary', created_at: r.created_at, agent_id: r.agent_id, content: r.content, entry_type: 'log' })

    // memories
    let memSql = 'SELECT id, agent_id, content, category, keywords, created_at FROM memories WHERE 1=1'
    const memParams: unknown[] = []
    if (from)  { memSql += ' AND created_at >= ?'; memParams.push(from) }
    if (to)    { memSql += ' AND created_at <= ?'; memParams.push(to) }
    if (agent) { memSql += ' AND agent_id = ?'; memParams.push(agent) }
    if (q)     { memSql += ' AND (content LIKE ? OR keywords LIKE ?)'; memParams.push(`%${q}%`, `%${q}%`) }
    memSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; memParams.push(limit)
    const memRows = db.prepare(memSql).all(...memParams) as Array<{ id: number; agent_id: string; content: string; category: string; keywords: string | null; created_at: number }>
    for (const r of memRows) parts.push({ id: r.id, source: 'diary', created_at: r.created_at, agent_id: r.agent_id, content: r.content, category: r.category, keywords: r.keywords ?? undefined, entry_type: 'memory' })
  }

  if (active.includes('agent')) {
    let agentSql = 'SELECT id, agent_id, entity, action, entity_id, detail, created_at FROM agent_audit_log WHERE 1=1'
    const agentParams: unknown[] = []
    if (from)  { agentSql += ' AND created_at >= ?'; agentParams.push(from) }
    if (to)    { agentSql += ' AND created_at <= ?'; agentParams.push(to) }
    if (agent) { agentSql += ' AND agent_id = ?'; agentParams.push(agent) }
    if (q)     { agentSql += ' AND (agent_id LIKE ? OR entity LIKE ? OR action LIKE ? OR detail LIKE ?)'; const p = `%${q}%`; agentParams.push(p, p, p, p) }
    agentSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; agentParams.push(limit)
    const agentRows = db.prepare(agentSql).all(...agentParams) as AgentAuditLogRow[]
    for (const r of agentRows) parts.push({
      id: r.id, source: 'agent', created_at: r.created_at,
      agent_id: r.agent_id, entity: r.entity, action: r.action,
      entity_id: r.entity_id ?? undefined, detail: r.detail ?? undefined,
    })
  }

  // hook_audit_log uses its own `ts` column name (not created_at) -- aliased
  // below so it merges into the same AuditLogEntry.created_at field as every
  // other source.
  if (active.includes('hook')) {
    let hookSql = 'SELECT id, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, ts AS created_at FROM hook_audit_log WHERE 1=1'
    const hookParams: unknown[] = []
    if (from)  { hookSql += ' AND ts >= ?'; hookParams.push(from) }
    if (to)    { hookSql += ' AND ts <= ?'; hookParams.push(to) }
    if (agent) { hookSql += ' AND agent_id = ?'; hookParams.push(agent) }
    if (q)     { hookSql += ' AND (agent_id LIKE ? OR hook_type LIKE ? OR verdict LIKE ? OR tool_name LIKE ? OR reason LIKE ?)'; const p = `%${q}%`; hookParams.push(p, p, p, p, p) }
    hookSql += ' ORDER BY ts DESC, id DESC LIMIT ?'; hookParams.push(limit)
    const hookRows = db.prepare(hookSql).all(...hookParams) as Array<{
      id: number; agent_id: string | null; hook_type: string; verdict: string
      tool_name: string | null; content_hash: string | null; reason: string | null
      session_id: string | null; created_at: number
    }>
    for (const r of hookRows) parts.push({
      id: r.id, source: 'hook', created_at: r.created_at,
      agent_id: r.agent_id ?? undefined, hook_type: r.hook_type, verdict: r.verdict,
      tool_name: r.tool_name, content_hash: r.content_hash, reason: r.reason, session_id: r.session_id,
    })
  }

  // Merge and sort by created_at DESC, then id DESC as tiebreaker
  parts.sort((a, b) => b.created_at - a.created_at || (b.id ?? 0) - (a.id ?? 0))
  return parts.slice(0, limit)
}

// Prune all three audit tables to AUDIT_LOG_RETENTION_DAYS. Called from the
// daily decay sweep so old entries do not accumulate indefinitely.
export function pruneAuditLogs(): void {
  const retentionDays = Number(getEffectiveSettingValue('AUDIT_LOG_RETENTION_DAYS'))
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
  db.prepare('DELETE FROM config_change_log WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM idea_status_log WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM store_file_audit WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM agent_audit_log WHERE created_at < ?').run(cutoff)
}

export interface TokenUsagePruneResult {
  rawDeleted: number
  dailyUpserted: number
  monthlyUpserted: number
}

// Prune token_usage rows older than TOKEN_USAGE_RETENTION_DAYS. The table is the
// main DB-growth driver (one row per inbound token-log event); without aggregation
// it grows unbounded. Called from the daily decay sweep.
//
// Strategy: aggregate rows older than the raw window into token_usage_daily and
// token_usage_monthly (idempotent upserts) BEFORE deleting the raw rows, so
// billing/cost-audit history is never lost. The aggregator tables are then pruned
// to their own retention windows (daily: 1 year, monthly: 3 years).
//
// `timestamp` is unix SECONDS.
export function pruneTokenUsage(): TokenUsagePruneResult {
  const rawRetentionDays    = Number(getEffectiveSettingValue('TOKEN_USAGE_RETENTION_DAYS'))
  const dailyRetentionDays  = Number(getEffectiveSettingValue('TOKEN_USAGE_DAILY_RETENTION_DAYS'))
  const monthlyRetentionDays = Number(getEffectiveSettingValue('TOKEN_USAGE_MONTHLY_RETENTION_DAYS'))

  const rawCutoff = Math.floor(Date.now() / 1000) - rawRetentionDays * 86400

  // 1. Daily rollup upsert (idempotent: ON CONFLICT overwrites with fresh aggregate).
  //    Runs only over rows that fall outside the raw retention window.
  const dailyResult = db.prepare(`
    INSERT INTO token_usage_daily
      (day, agent, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, thinking_tokens, row_count)
    SELECT
      date(timestamp, 'unixepoch', 'localtime') AS day,
      agent,
      COALESCE(model, '') AS model,
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(cache_read_tokens),
      SUM(cache_creation_tokens),
      SUM(thinking_tokens),
      COUNT(*)
    FROM token_usage
    WHERE timestamp < ?
    GROUP BY date(timestamp, 'unixepoch', 'localtime'), agent, COALESCE(model, '')
    ON CONFLICT(day, agent, model) DO UPDATE SET
      input_tokens          = excluded.input_tokens,
      output_tokens         = excluded.output_tokens,
      cache_read_tokens     = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      thinking_tokens       = excluded.thinking_tokens,
      row_count             = excluded.row_count
  `).run(rawCutoff)

  // 2. Monthly rollup upsert (idempotent).
  const monthlyResult = db.prepare(`
    INSERT INTO token_usage_monthly
      (month, agent, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, thinking_tokens, session_count, row_count)
    SELECT
      strftime('%Y-%m', timestamp, 'unixepoch', 'localtime') AS month,
      agent,
      COALESCE(model, '') AS model,
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(cache_read_tokens),
      SUM(cache_creation_tokens),
      SUM(thinking_tokens),
      COUNT(DISTINCT session_id),
      COUNT(*)
    FROM token_usage
    WHERE timestamp < ?
    GROUP BY strftime('%Y-%m', timestamp, 'unixepoch', 'localtime'), agent, COALESCE(model, '')
    ON CONFLICT(month, agent, model) DO UPDATE SET
      input_tokens          = excluded.input_tokens,
      output_tokens         = excluded.output_tokens,
      cache_read_tokens     = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      thinking_tokens       = excluded.thinking_tokens,
      session_count         = excluded.session_count,
      row_count             = excluded.row_count
  `).run(rawCutoff)

  // 3. Delete raw rows only after both rollups are committed.
  const deleteResult = db.prepare('DELETE FROM token_usage WHERE timestamp < ?').run(rawCutoff)

  // 4. Prune the aggregator tables to their own retention windows.
  db.prepare(
    "DELETE FROM token_usage_daily WHERE day < date(?, 'unixepoch', 'localtime')"
  ).run(Math.floor(Date.now() / 1000) - dailyRetentionDays * 86400)

  db.prepare(
    "DELETE FROM token_usage_monthly WHERE month < strftime('%Y-%m', ?, 'unixepoch', 'localtime')"
  ).run(Math.floor(Date.now() / 1000) - monthlyRetentionDays * 86400)

  return {
    rawDeleted:      deleteResult.changes,
    dailyUpserted:   dailyResult.changes,
    monthlyUpserted: monthlyResult.changes,
  }
}

// Each key is independent of any server -- one key may be assigned to many
// servers. The private key blob lives in the AES-256-GCM vault (vault.ts);
// only its id (vault_key_id) is stored here. public_key and fingerprint are
// safe to surface in the API; the private key never leaves the backend.

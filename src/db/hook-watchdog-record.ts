// The WRITES of the context watchdog hook (scripts/hooks/context-watchdog.py) in PostgreSQL mode, served from the serving backend.
//
// On every PostToolUse the hook records the call it just saw: one token_usage row, the agent.turn and model.call spans, and the
// close of a finished turn's span. In PG mode it does not open the SQLite file (stale since the cutover); it sends ONE request
// (`POST /api/v1/hooks/watchdog-record`) and this module does the writes. The same request answers the restart-gate threshold,
// which the hook needs for the HANDOFF decision: the threshold is ALWAYS answered, whatever happened to the writes, because the
// writes are best-effort telemetry and a bad span or a failed write must not cost the agent its HANDOFF.
//
// ONE system job, `hook-watchdog-record`. Why a system context: a shared agent's row is stamped by the SERVER, with the two resolvers
// the SQLite hook mirrors (they differ on purpose): token_usage.tenant_id = resolveAgentTenant (0 tenants -> default, 1 -> that
// tenant, many -> `_multi_`, the collector's stamp, so the collector's later pass over the same line is a no-op), otel_spans tenant =
// resolveWriteTenant (the fresh tenant context, else the one tenant, else NULL). A request tenant context cannot write the stamp of
// the other resolver (a `_multi_` row, a NULL tenant), so the writes run as the dashboard itself. The statements are FIXED text with
// bound parameters, the agent is the token's (taken by the route, never from the body), and no value of the body is a tenant.
//
// The threshold read is the one H1 had as its own job: the agent's own operating setting (agent_id AND setting_key fixed in the
// statement), not tenant data, so a shared agent in a tenant context still gets its configured value.
import { dbx } from './facade.js'
import { systemJob } from './background-jobs.js'
import { resolveAgentTenant } from './agents.js'
import { resolveWriteTenant } from './write-tenant.js'
import { logger } from '../logger.js'

/** Most spans one request may carry (the hook writes an agent.turn and a model.call). */
export const WATCHDOG_MAX_SPANS = 4
const MAX_ID = 200
const MAX_ATTRIBUTES_BYTES = 4096
const MAX_MODEL = 200
const MAX_PREVIEW = 200
const MAX_TOOL = 200
const MAX_TOKENS = 2_000_000_000
/** A time before this is not a clock of this fleet (2017-07-14, ms); a time more than a day ahead is a bad clock. */
const MIN_MS = 1_500_000_000_000
const FUTURE_SLACK_MS = 86_400_000
const SPAN_OPERATIONS = new Set(['agent.turn', 'model.call'])
const SPAN_STATUSES = new Set(['running', 'ok', 'error', 'timeout'])

export interface WatchdogUsage {
  session_id: string
  /** epoch seconds of the transcript line */
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  model: string | null
  content_preview: string | null
  tool_name: string | null
}

export interface WatchdogSpan {
  operation: string
  trace_id: string
  span_id: string
  parent_span_id: string | null
  start_ms: number
  end_ms: number
  status: string
  attributes: string | null
}

export interface WatchdogCloseStale {
  trace_id: string
  keep_span_id: string
}

/** The request after the structural checks of the route: each item may still be invalid (it is dropped and counted). */
export interface WatchdogRecordRequest {
  usage: unknown
  spans: unknown[]
  close_stale: unknown
}

export interface WatchdogRecordAnswer {
  /** The agent's context_restart_gate thresholdTokens (a positive integer), null when it has none: the hook decides the default. */
  threshold_tokens: number | null
  /** true when the token_usage row was written. */
  usage: boolean
  /** The spans written. */
  spans: number
  /** The items refused: invalid (usage, a span, the close), a span of another agent, a write that failed. */
  dropped: number
}

const stats = { writeFailures: 0, invalidItems: 0, foreignSpans: 0 }

/** Measurement view: how many items the watchdog route dropped since boot, by reason. A failed telemetry write is never a silent success. */
export function getWatchdogRecordStats(): { writeFailures: number; invalidItems: number; foreignSpans: number } {
  return { ...stats }
}

/** Test hook. */
export function resetWatchdogRecordStats(): void {
  stats.writeFailures = 0
  stats.invalidItems = 0
  stats.foreignSpans = 0
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ID && !v.includes('\u0000')
// `w3c-` ids are the server's own (spans.ts): a caller must not write into a trace by naming it.
const isSpanId = (v: unknown): v is string => isId(v) && !v.startsWith('w3c-')
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const isNullableText = (v: unknown, max: number): v is string | null => v === null || (typeof v === 'string' && v.length <= max && !v.includes('\u0000'))

function validUsage(raw: unknown, nowMs: number): WatchdogUsage | null {
  if (!isObj(raw)) return null
  const u = raw
  if (!isId(u['session_id'])) return null
  if (!isInt(u['timestamp'], MIN_MS / 1000, Math.floor((nowMs + FUTURE_SLACK_MS) / 1000))) return null
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
    if (!isInt(u[k], 0, MAX_TOKENS)) return null
  }
  const model = u['model'] ?? null
  const preview = u['content_preview'] ?? null
  const tool = u['tool_name'] ?? null
  if (!isNullableText(model, MAX_MODEL) || !isNullableText(preview, MAX_PREVIEW) || !isNullableText(tool, MAX_TOOL)) return null
  return {
    session_id: u['session_id'], timestamp: u['timestamp'] as number,
    input_tokens: u['input_tokens'] as number, output_tokens: u['output_tokens'] as number,
    cache_read_tokens: u['cache_read_tokens'] as number, cache_creation_tokens: u['cache_creation_tokens'] as number,
    model, content_preview: preview, tool_name: tool,
  }
}

function validSpan(raw: unknown, nowMs: number): WatchdogSpan | null {
  if (!isObj(raw)) return null
  const s = raw
  if (typeof s['operation'] !== 'string' || !SPAN_OPERATIONS.has(s['operation'])) return null
  if (!isSpanId(s['trace_id']) || !isSpanId(s['span_id'])) return null
  const parent = s['parent_span_id'] ?? null
  if (parent !== null && !isSpanId(parent)) return null
  if (!isInt(s['start_ms'], MIN_MS, nowMs + FUTURE_SLACK_MS) || !isInt(s['end_ms'], MIN_MS, nowMs + FUTURE_SLACK_MS)) return null
  if ((s['end_ms'] as number) < (s['start_ms'] as number)) return null
  if (typeof s['status'] !== 'string' || !SPAN_STATUSES.has(s['status'])) return null
  const attributes = s['attributes'] ?? null
  if (attributes !== null && (typeof attributes !== 'string' || Buffer.byteLength(attributes, 'utf8') > MAX_ATTRIBUTES_BYTES || attributes.includes('\u0000'))) return null
  return {
    operation: s['operation'], trace_id: s['trace_id'], span_id: s['span_id'], parent_span_id: parent,
    start_ms: s['start_ms'] as number, end_ms: s['end_ms'] as number, status: s['status'], attributes,
  }
}

function validClose(raw: unknown): WatchdogCloseStale | null {
  if (!isObj(raw)) return null
  if (!isSpanId(raw['trace_id']) || !isSpanId(raw['keep_span_id'])) return null
  return { trace_id: raw['trace_id'], keep_span_id: raw['keep_span_id'] }
}

async function readThreshold(agentId: string): Promise<number | null> {
  const row = await dbx.get<{ setting_value: string }>(
    "SELECT setting_value FROM agent_settings WHERE agent_id = ? AND setting_key = 'context_restart_gate'", agentId,
  )
  if (!row) return null
  try {
    const parsed: unknown = JSON.parse(row.setting_value)
    const v = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['thresholdTokens'] : undefined
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null
  } catch {
    return null
  }
}

/**
 * Records what the watchdog saw on one PostToolUse call and answers the agent's threshold. Every write is its own best-effort
 * step: an invalid item is dropped and counted, a write error is logged at warn, counted and reported as a missing flag, and the
 * threshold is answered in every case (a failed threshold read itself is the one error that propagates: without it the hook has
 * nothing to decide on, and the route answers 500, which the hook reads as "skip the HANDOFF").
 */
export const recordWatchdogTelemetry = systemJob('hook-watchdog-record', async (agentId: string, req: WatchdogRecordRequest): Promise<WatchdogRecordAnswer> => {
  const nowMs = Date.now()
  let dropped = 0
  const refuse = (): void => { dropped += 1; stats.invalidItems += 1 }
  let usageWritten = false
  let spansWritten = 0

  const usage = req.usage === null || req.usage === undefined ? null : validUsage(req.usage, nowMs)
  if (req.usage !== null && req.usage !== undefined && usage === null) refuse()
  if (usage) {
    try {
      // Same upsert as the collector (recordTokenUsageCalls): the conflict target is the unique index of the five columns, so the
      // collector's later pass over this line is a no-op. The stamp is the collector's too (resolveAgentTenant), so the two writers
      // never turn each other's row into another tenant. thinking_tokens stays 0 here: the collector fills it in on its pass.
      await dbx.run(`
        INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
          model = CASE WHEN token_usage.model IS NULL AND excluded.model IS NOT NULL THEN excluded.model ELSE token_usage.model END,
          tenant_id = excluded.tenant_id
      `, agentId, usage.session_id, usage.timestamp, usage.input_tokens, usage.output_tokens,
        usage.cache_read_tokens, usage.cache_creation_tokens, 0, usage.model, usage.content_preview || null, usage.tool_name,
        await resolveAgentTenant(agentId))
      usageWritten = true
    } catch (err) {
      dropped += 1
      stats.writeFailures += 1
      logger.warn({ err, route: 'hooks/watchdog-record', item: 'usage' }, 'watchdog record: the token usage row could not be written')
    }
  }

  const spanTenant = (): Promise<string | null> => resolveWriteTenant(agentId)
  let tenantOfSpans: string | null | undefined
  for (const raw of req.spans) {
    const span = validSpan(raw, nowMs)
    if (!span) { refuse(); continue }
    try {
      if (tenantOfSpans === undefined) tenantOfSpans = await spanTenant()
      // Same upsert as upsertOtelSpan and the hook's SQLite statement (a closed span is never reopened: only end_ms, status and
      // attributes move), plus the guard neither has: the row is refreshed only when it is the caller's OWN, so an agent that
      // knows another agent's trace and span id cannot overwrite that span (0 changes -> refused, counted).
      const res = await dbx.run(`
        INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (trace_id, span_id) DO UPDATE SET
          exported_at = CASE
            WHEN otel_spans.exported_at IS NOT NULL
             AND (excluded.end_ms IS DISTINCT FROM otel_spans.end_ms OR excluded.status IS DISTINCT FROM otel_spans.status)
            THEN NULL ELSE otel_spans.exported_at END,
          end_ms = excluded.end_ms,
          status = excluded.status,
          attributes = COALESCE(excluded.attributes, otel_spans.attributes)
        WHERE otel_spans.agent_id = excluded.agent_id
      `, span.trace_id, span.span_id, span.parent_span_id, agentId, span.operation, span.start_ms, span.end_ms, span.status,
        span.attributes, tenantOfSpans)
      if (res.changes > 0) {
        spansWritten += 1
      } else {
        dropped += 1
        stats.foreignSpans += 1
        logger.warn({ route: 'hooks/watchdog-record', item: 'span' }, 'watchdog record: a span of another agent was refused')
      }
    } catch (err) {
      dropped += 1
      stats.writeFailures += 1
      logger.warn({ err, route: 'hooks/watchdog-record', item: 'span' }, 'watchdog record: a span could not be written')
    }
  }

  if (req.close_stale !== null && req.close_stale !== undefined) {
    const close = validClose(req.close_stale)
    if (!close) {
      refuse()
    } else {
      try {
        // A new turn boundary closes the OTHER still-running agent.turn spans of the trace: the caller's own only (agent_id), so a
        // trace id of another agent closes nothing of theirs.
        await dbx.run(`
          UPDATE otel_spans SET status = 'ok', exported_at = NULL
          WHERE trace_id = ? AND agent_id = ? AND operation = 'agent.turn' AND status = 'running' AND span_id != ?
        `, close.trace_id, agentId, close.keep_span_id)
      } catch (err) {
        dropped += 1
        stats.writeFailures += 1
        logger.warn({ err, route: 'hooks/watchdog-record', item: 'close_stale' }, 'watchdog record: the stale turn spans could not be closed')
      }
    }
  }

  return { threshold_tokens: await readThreshold(agentId), usage: usageWritten, spans: spansWritten, dropped }
})

/** The prior 'handoff' audit row of the caller's own session (the dedup baseline), in the caller's REQUEST tenant context. */
export interface PriorHandoff {
  ts: number
  reason: string | null
  content_hash: string | null
}

export async function getPriorHandoff(agentId: string, sessionId: string): Promise<PriorHandoff | null> {
  const row = await dbx.get<{ ts: number | string; reason: string | null; content_hash: string | null }>(
    "SELECT ts, reason, content_hash FROM hook_audit_log WHERE agent_id = ? AND session_id = ? AND verdict = 'handoff' ORDER BY ts DESC, id DESC LIMIT 1",
    agentId, sessionId,
  )
  return row ? { ts: Number(row.ts), reason: row.reason ?? null, content_hash: row.content_hash ?? null } : null
}

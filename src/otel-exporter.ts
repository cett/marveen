// Thin OTEL JSON exporter: maps otel_spans rows to the OTLP/JSON wire format
// (resourceSpans -> scopeSpans -> spans). Targets the Protobuf-JSON encoding
// used by Grafana Tempo, Jaeger, and any OTLP-HTTP collector.
//
// Spec: opentelemetry-proto/trace/v1/trace.proto (JSON encoding)

import { createHash } from 'node:crypto'
import type { OtelSpan, TokenUsageMetricRow } from './db.js'

interface OtelAttribute {
  key: string
  value: { stringValue?: string; intValue?: string; boolValue?: boolean }
}

interface OtelSpanExport {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: number; message?: string }
  attributes: OtelAttribute[]
}

interface ScopeSpans {
  scope: { name: string; version: string }
  spans: OtelSpanExport[]
}

interface ResourceSpans {
  resource: { attributes: OtelAttribute[] }
  scopeSpans: ScopeSpans[]
}

export interface OtelExportPayload {
  resourceSpans: ResourceSpans[]
}

// OTLP status codes: 0=UNSET, 1=OK, 2=ERROR
function statusCode(status: OtelSpan['status']): number {
  if (status === 'ok') return 1
  if (status === 'error' || status === 'timeout') return 2
  return 0 // running / unknown
}

// Parse the JSON attributes blob stored in the DB into OTEL attribute list.
// The blob is expected to be a flat Record<string, string | number | boolean>.
function parseAttributes(raw: string | null): OtelAttribute[] {
  if (!raw) return []
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(obj).map(([key, val]) => {
      if (typeof val === 'boolean') return { key, value: { boolValue: val } }
      if (typeof val === 'number') return { key, value: { intValue: String(Math.round(val)) } }
      return { key, value: { stringValue: String(val) } }
    })
  } catch {
    return []
  }
}

// ms -> nanosecond string (OTEL uses string to avoid JS integer overflow)
function msToNano(ms: number): string {
  return String(ms * 1_000_000)
}

// OTLP requires traceId to be exactly 16 bytes (32 hex chars) and spanId
// exactly 8 bytes (16 hex chars) of raw hex -- not a UUID, not a Claude-native
// id. Our ids are session_ids, msg_... ids, tool_use ids and transcript UUIDs,
// none of which are hex or the right length, so a collector validates and
// rejects (400) every export. Hash deterministically instead of trying to
// "clean up" the original string: the same input always yields the same
// output, so trace/span correlation (parent-child links across multiple
// export calls) is preserved.
function toHexId(id: string, byteLen: 8 | 16): string {
  return createHash('sha256').update(id).digest('hex').slice(0, byteLen * 2)
}

// Group spans by agent_id, then emit one resourceSpans block per agent
// so Grafana Tempo / Jaeger can filter by service.name. `serviceNamespace`
// distinguishes multiple Marveen deployments pushing to the same collector
// (OTEL_SERVICE_NAME setting); per-agent service.name is unaffected.
export function spansToOtelJson(spans: OtelSpan[], serviceNamespace = 'marveen'): OtelExportPayload {
  const byAgent = new Map<string, OtelSpan[]>()
  for (const span of spans) {
    const bucket = byAgent.get(span.agent_id) ?? []
    bucket.push(span)
    byAgent.set(span.agent_id, bucket)
  }

  const resourceSpans: ResourceSpans[] = []
  for (const [agentId, agentSpans] of byAgent) {
    const exportedSpans: OtelSpanExport[] = agentSpans.map((s) => {
      const endMs = s.end_ms ?? s.start_ms // fallback for still-running spans
      const out: OtelSpanExport = {
        traceId: toHexId(s.trace_id, 16),
        spanId: toHexId(s.span_id, 8),
        name: s.operation,
        startTimeUnixNano: msToNano(s.start_ms),
        endTimeUnixNano: msToNano(endMs),
        status: { code: statusCode(s.status) },
        attributes: [
          { key: 'agent.id', value: { stringValue: s.agent_id } },
          { key: 'span.status', value: { stringValue: s.status } },
          ...parseAttributes(s.attributes),
        ],
      }
      if (s.parent_span_id) out.parentSpanId = toHexId(s.parent_span_id, 8)
      return out
    })

    resourceSpans.push({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: `marveen-agent-${agentId}` } },
          { key: 'service.namespace', value: { stringValue: serviceNamespace } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'marveen', version: '1' },
        spans: exportedSpans,
      }],
    })
  }

  return { resourceSpans }
}

// ── OTLP Metrics (gen_ai.client.token.usage) ──────────────────────────────────
// Spec: opentelemetry-proto/metrics/v1/metrics.proto (JSON encoding).
// Follows the OTel GenAI Semantic Conventions metric name and the
// gen_ai.token.type attribute; marveen.agent.id / marveen.tenant.id are our
// own dimensions (not yet standardised for multi-tenant agent fleets).

interface OtelNumberDataPoint {
  attributes: OtelAttribute[]
  startTimeUnixNano: string
  timeUnixNano: string
  asInt: string
}

interface OtelMetric {
  name: string
  unit: string
  sum: {
    dataPoints: OtelNumberDataPoint[]
    aggregationTemporality: number // 2 = DELTA
    isMonotonic: boolean
  }
}

interface ScopeMetrics {
  scope: { name: string; version: string }
  metrics: OtelMetric[]
}

interface ResourceMetrics {
  resource: { attributes: OtelAttribute[] }
  scopeMetrics: ScopeMetrics[]
}

export interface OtelMetricsExportPayload {
  resourceMetrics: ResourceMetrics[]
}

const TOKEN_TYPE_FIELDS: { field: keyof TokenUsageMetricRow; type: string }[] = [
  { field: 'input_tokens', type: 'input' },
  { field: 'output_tokens', type: 'output' },
  { field: 'cache_read_tokens', type: 'cache_read' },
  { field: 'cache_creation_tokens', type: 'cache_creation' },
  { field: 'thinking_tokens', type: 'thinking' },
]

// One resourceMetrics block per agent (mirrors spansToOtelJson), one data
// point per (model, tenant, token type) with a nonzero delta in the window.
export function tokenUsageToOtelMetricsJson(
  rows: TokenUsageMetricRow[],
  windowStartSec: number,
  windowEndSec: number,
  serviceNamespace = 'marveen',
): OtelMetricsExportPayload {
  const startNano = msToNano(windowStartSec * 1000)
  const endNano = msToNano(windowEndSec * 1000)

  const byAgent = new Map<string, TokenUsageMetricRow[]>()
  for (const row of rows) {
    const bucket = byAgent.get(row.agent) ?? []
    bucket.push(row)
    byAgent.set(row.agent, bucket)
  }

  const resourceMetrics: ResourceMetrics[] = []
  for (const [agentId, agentRows] of byAgent) {
    const dataPoints: OtelNumberDataPoint[] = []
    for (const row of agentRows) {
      for (const { field, type } of TOKEN_TYPE_FIELDS) {
        const value = row[field] as number
        if (!value) continue
        dataPoints.push({
          attributes: [
            { key: 'gen_ai.request.model', value: { stringValue: row.model ?? 'unknown' } },
            { key: 'gen_ai.token.type', value: { stringValue: type } },
            { key: 'marveen.agent.id', value: { stringValue: agentId } },
            { key: 'marveen.tenant.id', value: { stringValue: row.tenant_id } },
          ],
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          asInt: String(Math.round(value)),
        })
      }
    }
    if (dataPoints.length === 0) continue

    resourceMetrics.push({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: `marveen-agent-${agentId}` } },
          { key: 'service.namespace', value: { stringValue: serviceNamespace } },
        ],
      },
      scopeMetrics: [{
        scope: { name: 'marveen', version: '1' },
        metrics: [{
          name: 'gen_ai.client.token.usage',
          unit: '{token}',
          sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true },
        }],
      }],
    })
  }

  return { resourceMetrics }
}

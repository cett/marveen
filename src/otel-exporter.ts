// Thin OTEL JSON exporter: maps otel_spans rows to the OTLP/JSON wire format
// (resourceSpans -> scopeSpans -> spans). Targets the Protobuf-JSON encoding
// used by Grafana Tempo, Jaeger, and any OTLP-HTTP collector.
//
// Spec: opentelemetry-proto/trace/v1/trace.proto (JSON encoding)

import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { PROJECT_ROOT } from './config.js'
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

// Span attribute keys that may leave the machine. An allowlist, not a denylist: every other key of a
// span's attributes blob is dropped, so a future span writer (or POST /api/spans, which takes free
// JSON) cannot push content through the exporter by accident. Identifiers and counters only.
export const EXPORT_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'tool_name', 'mcp_server', 'mcp_tool',
  'msg_id', 'from', 'to',
  'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
])

// Opt-in attribute (OTEL_EXPORT_INPUT_SUMMARY): a short description of what a tool call was given. The
// hook already redacts it heuristically, which is not enough to ship it off the machine by default.
const INPUT_SUMMARY_KEY = 'input_summary'
const INPUT_SUMMARY_MAX_CHARS = 120

export interface OtelExportOptions {
  includeInputSummary?: boolean
  serviceInstanceId?: string
}

// Second scrub for the opt-in input_summary, on top of the hook's own redaction. It removes the credential
// shapes that are cheap to recognise: user:password embedded in a URL (with or without the scheme),
// curl's -u / --user, "Authorization:" / Bearer / Basic values, and password= / token= / secret= /
// api_key= assignments. It also drops the home directory (it names the machine's user). It is a
// heuristic, not a guarantee, which is why the attribute stays off by default. Shortened last, so a cut
// never leaves half a secret behind.
const SCRUBS: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  [/\b[^\s/@:]+:[^\s/@]+@/g, '***@'],
  [/(\s(?:-u|--user)(?:\s+|=))\S+/g, '$1***'],
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?\S+/gi, '$1***'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\b((?:pass(?:word|wd)?|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*)\S+/gi, '$1***'],
  [/(--?(?:pass(?:word|wd)?|token|secret|api[_-]?key)\s+)\S+/gi, '$1***'],
  [/\/(?:Users|home)\/[^/\s]+/g, '/~'],
]

export function scrubInputSummary(value: string): string {
  let out = value
  for (const [rx, replacement] of SCRUBS) out = out.replace(rx, replacement)
  return out.slice(0, INPUT_SUMMARY_MAX_CHARS)
}

// Stable per-installation id: the host name and install path are hashed, so the collector can tell two
// Marveen instances apart without learning either.
export function serviceInstanceId(): string {
  return createHash('sha256').update(`${hostname()}\n${PROJECT_ROOT}`).digest('hex').slice(0, 12)
}

// Parse the JSON attributes blob stored in the DB into the OTEL attribute list, keeping only allowlisted
// keys. The blob is expected to be a flat Record<string, string | number | boolean>.
function parseAttributes(raw: string | null, includeInputSummary: boolean): OtelAttribute[] {
  if (!raw) return []
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(obj)
      .filter(([key]) => EXPORT_ATTRIBUTE_ALLOWLIST.has(key) || (includeInputSummary && key === INPUT_SUMMARY_KEY))
      .map(([key, rawVal]) => {
        const val = key === INPUT_SUMMARY_KEY ? scrubInputSummary(String(rawVal)) : rawVal
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

// Tenant label for a span whose tenant could not be resolved (otel_spans.tenant_id NULL, see migration
// 0077): not 'default', which would pass it off as the default tenant's.
const UNRESOLVED_TENANT = 'unresolved'

// Group spans by (agent_id, tenant), then emit one resourceSpans block per group so Grafana Tempo /
// Jaeger can filter by service.name and tenant. `serviceNamespace` distinguishes multiple Marveen
// deployments pushing to the same collector (OTEL_SERVICE_NAME setting); per-agent service.name is
// unaffected. Only allowlisted span attributes are exported (EXPORT_ATTRIBUTE_ALLOWLIST).
export function spansToOtelJson(
  spans: OtelSpan[],
  serviceNamespace = 'marveen',
  opts: OtelExportOptions = {},
): OtelExportPayload {
  const includeInputSummary = opts.includeInputSummary === true
  const instanceId = opts.serviceInstanceId ?? serviceInstanceId()
  const groups = new Map<string, { agentId: string; tenant: string; spans: OtelSpan[] }>()
  for (const span of spans) {
    const tenant = span.tenant_id ?? UNRESOLVED_TENANT
    const key = `${span.agent_id}\u0000${tenant}`
    const group = groups.get(key) ?? { agentId: span.agent_id, tenant, spans: [] }
    group.spans.push(span)
    groups.set(key, group)
  }

  const resourceSpans: ResourceSpans[] = []
  for (const { agentId, tenant, spans: groupSpans } of groups.values()) {
    const exportedSpans: OtelSpanExport[] = groupSpans.map((s) => {
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
          { key: 'marveen.tenant.id', value: { stringValue: tenant } },
          { key: 'span.status', value: { stringValue: s.status } },
          ...parseAttributes(s.attributes, includeInputSummary),
        ],
      }
      if (s.parent_span_id) out.parentSpanId = toHexId(s.parent_span_id, 8)
      return out
    })

    resourceSpans.push({
      resource: { attributes: resourceAttributes(agentId, serviceNamespace, instanceId, tenant) },
      scopeSpans: [{
        scope: { name: 'marveen', version: '1' },
        spans: exportedSpans,
      }],
    })
  }

  return { resourceSpans }
}

function resourceAttributes(agentId: string, serviceNamespace: string, instanceId: string, tenant?: string): OtelAttribute[] {
  return [
    { key: 'service.name', value: { stringValue: `marveen-agent-${agentId}` } },
    { key: 'service.namespace', value: { stringValue: serviceNamespace } },
    { key: 'service.instance.id', value: { stringValue: instanceId } },
    ...(tenant ? [{ key: 'marveen.tenant.id', value: { stringValue: tenant } }] : []),
  ]
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
  opts: OtelExportOptions = {},
): OtelMetricsExportPayload {
  const instanceId = opts.serviceInstanceId ?? serviceInstanceId()
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
      resource: { attributes: resourceAttributes(agentId, serviceNamespace, instanceId) },
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

// Thin OTEL JSON exporter: maps otel_spans rows to the OTLP/JSON wire format
// (resourceSpans -> scopeSpans -> spans). Targets the Protobuf-JSON encoding
// used by Grafana Tempo, Jaeger, and any OTLP-HTTP collector.
//
// Spec: opentelemetry-proto/trace/v1/trace.proto (JSON encoding)

import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { PROJECT_ROOT } from './config.js'
import type { OtelSpan, TokenUsageMetricRow, TokenHistogramRow } from './db.js'
import type { PendingDurations } from './otel-genai-duration.js'
import {
  GENAI_DURATION_BUCKET_BOUNDS, DURATION_SOURCE_KEY, DURATION_SOURCE_TRANSCRIPT,
  GENAI_PROVIDER_NAME, GENAI_TOKEN_BUCKET_BOUNDS, SPAN_KIND_CLIENT, SPAN_KIND_INTERNAL, SPAN_KIND_PRODUCER,
  TEMPORALITY_DELTA,
} from './otel-genai.js'

interface OtelAttribute {
  key: string
  value: { stringValue?: string; intValue?: string; boolValue?: boolean }
}

interface OtelSpanExport {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
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
  'schedule', 'schedule_type',
  'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
  // Set only on a model.call span whose duration was approximated from transcript timestamps.
  'marveen.duration.source',
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

function parseBlob(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as unknown
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toOtelAttribute(key: string, val: unknown): OtelAttribute {
  if (typeof val === 'boolean') return { key, value: { boolValue: val } }
  if (typeof val === 'number') return { key, value: { intValue: String(Math.round(val)) } }
  return { key, value: { stringValue: String(val) } }
}

// The GenAI semantic conventions (gen_ai.*) name three kinds of span the fleet produces. The DB keeps its
// own operation names and blob keys (other readers depend on them); the mapping happens here, on export.
//   chat           <- model.call   (one model response; CLIENT)
//   execute_tool   <- tool.<name>  (one tool call; INTERNAL)
//   invoke_agent   <- agent.turn   (one agent turn; INTERNAL)
// Anything else (inter-agent messages, schedule runs, spans written through POST /api/spans) keeps its name;
// an inter-agent message is a PRODUCER, the rest INTERNAL.
type SpanFamily = 'chat' | 'execute_tool' | 'invoke_agent' | 'message' | 'other'

function spanFamily(operation: string): SpanFamily {
  if (operation === 'model.call') return 'chat'
  if (operation.startsWith('tool.')) return 'execute_tool'
  if (operation === 'agent.turn') return 'invoke_agent'
  if (operation.includes('->')) return 'message'
  return 'other'
}

// Blob key -> exported key(s), per family. A key that is not listed keeps its own name.
const ATTRIBUTE_RENAMES: Partial<Record<SpanFamily, Record<string, string[]>>> = {
  chat: {
    // Claude Code only reports the model that answered; it never tells the requested one apart, so the
    // observed model fills both conventional keys.
    model: ['gen_ai.request.model', 'gen_ai.response.model'],
    input_tokens: ['gen_ai.usage.input_tokens'],
    output_tokens: ['gen_ai.usage.output_tokens'],
    cache_read_tokens: ['gen_ai.usage.cache_read.input_tokens'],
    cache_creation_tokens: ['gen_ai.usage.cache_creation.input_tokens'],
  },
  execute_tool: {
    tool_name: ['gen_ai.tool.name'],
    mcp_server: ['marveen.mcp.server'],
    mcp_tool: ['marveen.mcp.tool'],
  },
}

const SPAN_KINDS: Record<SpanFamily, number> = {
  chat: SPAN_KIND_CLIENT,
  execute_tool: SPAN_KIND_INTERNAL,
  invoke_agent: SPAN_KIND_INTERNAL,
  message: SPAN_KIND_PRODUCER,
  other: SPAN_KIND_INTERNAL,
}

const NAME_VALUE_MAX_CHARS = 64

// Short, single-line text for a span name built from a stored value.
function nameValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, NAME_VALUE_MAX_CHARS) : ''
}

function spanName(s: OtelSpan, family: SpanFamily, blob: Record<string, unknown>): string {
  if (family === 'chat') {
    const model = nameValue(blob['model'])
    return model ? `chat ${model}` : 'chat'
  }
  if (family === 'execute_tool') {
    const tool = nameValue(blob['tool_name']) || nameValue(s.operation.slice('tool.'.length))
    return tool ? `execute_tool ${tool}` : 'execute_tool'
  }
  if (family === 'invoke_agent') return `invoke_agent ${nameValue(s.agent_id)}`.trim()
  return s.operation
}

// Convention attributes that do not come from the blob.
function conventionAttributes(s: OtelSpan, family: SpanFamily): OtelAttribute[] {
  if (family === 'chat') {
    return [
      toOtelAttribute('gen_ai.operation.name', 'chat'),
      toOtelAttribute('gen_ai.provider.name', GENAI_PROVIDER_NAME),
    ]
  }
  if (family === 'execute_tool') return [toOtelAttribute('gen_ai.operation.name', 'execute_tool')]
  if (family === 'invoke_agent') {
    return [
      toOtelAttribute('gen_ai.operation.name', 'invoke_agent'),
      toOtelAttribute('gen_ai.provider.name', GENAI_PROVIDER_NAME),
      toOtelAttribute('gen_ai.agent.id', s.agent_id),
      toOtelAttribute('gen_ai.agent.name', s.agent_id),
    ]
  }
  return []
}

// The span's own attributes: the allowlisted blob keys (renamed to the convention where there is one).
// The blob is expected to be a flat Record<string, string | number | boolean>.
function blobAttributes(blob: Record<string, unknown>, family: SpanFamily, includeInputSummary: boolean): OtelAttribute[] {
  const renames = ATTRIBUTE_RENAMES[family] ?? {}
  const out: OtelAttribute[] = []
  for (const [key, rawVal] of Object.entries(blob)) {
    const isSummary = includeInputSummary && key === INPUT_SUMMARY_KEY
    if (!EXPORT_ATTRIBUTE_ALLOWLIST.has(key) && !isSummary) continue
    const val = key === INPUT_SUMMARY_KEY ? scrubInputSummary(String(rawVal)) : rawVal
    for (const exportedKey of renames[key] ?? [key]) out.push(toOtelAttribute(exportedKey, val))
  }
  return out
}

// error.type for a span that did not end well: the stored status is all that is known. 'timeout' is its own
// value; every other failure is '_OTHER', the convention's fallback for an error without a specific type.
function errorTypeOf(status: OtelSpan['status']): string | null {
  if (status === 'timeout') return 'timeout'
  if (status === 'error') return '_OTHER'
  return null
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
      const family = spanFamily(s.operation)
      const blob = parseBlob(s.attributes)
      const errorType = errorTypeOf(s.status)
      const out: OtelSpanExport = {
        traceId: toHexId(s.trace_id, 16),
        spanId: toHexId(s.span_id, 8),
        name: spanName(s, family, blob),
        kind: SPAN_KINDS[family],
        startTimeUnixNano: msToNano(s.start_ms),
        endTimeUnixNano: msToNano(endMs),
        status: errorType ? { code: statusCode(s.status), message: errorType } : { code: statusCode(s.status) },
        attributes: [
          { key: 'agent.id', value: { stringValue: s.agent_id } },
          { key: 'marveen.tenant.id', value: { stringValue: tenant } },
          { key: 'span.status', value: { stringValue: s.status } },
          ...conventionAttributes(s, family),
          ...blobAttributes(blob, family, includeInputSummary),
          ...(errorType ? [toOtelAttribute('error.type', errorType)] : []),
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
// gen_ai.client.token.usage follows the GenAI semantic conventions: a histogram of the tokens one model
// response used, input and output only (gen_ai.token.type). The conventions know no other token type, so
// cache reads, cache creations and thinking tokens go out as their own marveen.* sum. marveen.agent.id and
// marveen.tenant.id are our own dimensions (no convention exists for multi-tenant agent fleets).
//
// Both are DELTA metrics: each export covers the window since the last one. (An earlier version sent the
// window sums labelled temporality 2, which is CUMULATIVE in OTLP, so a backend read every window as a
// running total.) A Prometheus-style backend needs the collector's deltatocumulative processor in front.

interface OtelNumberDataPoint {
  attributes: OtelAttribute[]
  startTimeUnixNano: string
  timeUnixNano: string
  asInt: string
}

interface OtelHistogramDataPoint {
  attributes: OtelAttribute[]
  startTimeUnixNano: string
  timeUnixNano: string
  count: string
  sum: number
  bucketCounts: string[]
  explicitBounds: number[]
  min: number
  max: number
}

interface OtelMetric {
  name: string
  unit: string
  sum?: {
    dataPoints: OtelNumberDataPoint[]
    aggregationTemporality: number
    isMonotonic: boolean
  }
  histogram?: {
    dataPoints: OtelHistogramDataPoint[]
    aggregationTemporality: number
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

export const TOKEN_USAGE_METRIC = 'gen_ai.client.token.usage'
export const TOKEN_USAGE_OTHER_METRIC = 'marveen.gen_ai.client.token.usage.other'

// The token types the histogram cannot carry.
const OTHER_TOKEN_FIELDS: { field: keyof TokenUsageMetricRow; type: string }[] = [
  { field: 'cache_read_tokens', type: 'cache_read' },
  { field: 'cache_creation_tokens', type: 'cache_creation' },
  { field: 'thinking_tokens', type: 'thinking' },
]

function genAiAttributes(model: string | null, tokenType: string | null, agentId: string, tenantId: string): OtelAttribute[] {
  const observed = model ?? 'unknown'
  return [
    toOtelAttribute('gen_ai.operation.name', 'chat'),
    toOtelAttribute('gen_ai.provider.name', GENAI_PROVIDER_NAME),
    // The observed model fills both keys, see ATTRIBUTE_RENAMES.
    toOtelAttribute('gen_ai.request.model', observed),
    toOtelAttribute('gen_ai.response.model', observed),
    ...(tokenType ? [toOtelAttribute('gen_ai.token.type', tokenType)] : []),
    toOtelAttribute('marveen.agent.id', agentId),
    toOtelAttribute('marveen.tenant.id', tenantId),
  ]
}

// The histogram series of one agent: one data point per (model, tenant, token type), the per-bucket rows of
// the window folded into bucket counts.
function tokenHistogramDataPoints(
  agentId: string,
  rows: TokenHistogramRow[],
  startNano: string,
  endNano: string,
): OtelHistogramDataPoint[] {
  const bucketTotal = GENAI_TOKEN_BUCKET_BOUNDS.length + 1
  const series = new Map<string, OtelHistogramDataPoint & { countN: number }>()
  for (const row of rows) {
    if (row.bucket < 0 || row.bucket >= bucketTotal || !(row.n > 0)) continue
    const key = `${row.model ?? ''}\u0000${row.tenant_id}\u0000${row.token_type}`
    let point = series.get(key)
    if (!point) {
      point = {
        attributes: genAiAttributes(row.model, row.token_type, agentId, row.tenant_id),
        startTimeUnixNano: startNano,
        timeUnixNano: endNano,
        count: '0',
        countN: 0,
        sum: 0,
        bucketCounts: new Array<string>(bucketTotal).fill('0'),
        explicitBounds: [...GENAI_TOKEN_BUCKET_BOUNDS],
        min: row.min_value,
        max: row.max_value,
      }
      series.set(key, point)
    }
    point.bucketCounts[row.bucket] = String(Number(point.bucketCounts[row.bucket]) + row.n)
    point.countN += row.n
    point.sum += row.total
    point.min = Math.min(point.min, row.min_value)
    point.max = Math.max(point.max, row.max_value)
  }
  return [...series.values()].map(({ countN, ...point }) => ({ ...point, count: String(countN) }))
}

// One resourceMetrics block per agent (mirrors spansToOtelJson). `histogramRows` are the per-bucket
// input/output observations of the window (tokenUsageHistogramWindow), `sumRows` the per-model window sums
// (sumTokenUsageWindow) the other token types are taken from.
export function tokenUsageToOtelMetricsJson(
  histogramRows: TokenHistogramRow[],
  sumRows: TokenUsageMetricRow[],
  windowStartSec: number,
  windowEndSec: number,
  serviceNamespace = 'marveen',
  opts: OtelExportOptions = {},
): OtelMetricsExportPayload {
  const instanceId = opts.serviceInstanceId ?? serviceInstanceId()
  const startNano = msToNano(windowStartSec * 1000)
  const endNano = msToNano(windowEndSec * 1000)

  const agents = new Map<string, { hist: TokenHistogramRow[]; sums: TokenUsageMetricRow[] }>()
  const bucketFor = (agent: string) => {
    const entry = agents.get(agent) ?? { hist: [], sums: [] }
    agents.set(agent, entry)
    return entry
  }
  for (const row of histogramRows) bucketFor(row.agent).hist.push(row)
  for (const row of sumRows) bucketFor(row.agent).sums.push(row)

  const resourceMetrics: ResourceMetrics[] = []
  for (const [agentId, { hist, sums }] of agents) {
    const metrics: OtelMetric[] = []

    const histogramPoints = tokenHistogramDataPoints(agentId, hist, startNano, endNano)
    if (histogramPoints.length > 0) {
      metrics.push({
        name: TOKEN_USAGE_METRIC,
        unit: '{token}',
        histogram: { dataPoints: histogramPoints, aggregationTemporality: TEMPORALITY_DELTA },
      })
    }

    const otherPoints: OtelNumberDataPoint[] = []
    for (const row of sums) {
      for (const { field, type } of OTHER_TOKEN_FIELDS) {
        const value = row[field] as number
        if (!value) continue
        otherPoints.push({
          attributes: [
            ...genAiAttributes(row.model, null, agentId, row.tenant_id),
            toOtelAttribute('marveen.token.type', type),
          ],
          startTimeUnixNano: startNano,
          timeUnixNano: endNano,
          asInt: String(Math.round(value)),
        })
      }
    }
    if (otherPoints.length > 0) {
      metrics.push({
        name: TOKEN_USAGE_OTHER_METRIC,
        unit: '{token}',
        sum: { dataPoints: otherPoints, aggregationTemporality: TEMPORALITY_DELTA, isMonotonic: true },
      })
    }
    if (metrics.length === 0) continue

    resourceMetrics.push({
      resource: { attributes: resourceAttributes(agentId, serviceNamespace, instanceId) },
      scopeMetrics: [{ scope: { name: 'marveen', version: '1' }, metrics }],
    })
  }

  return { resourceMetrics }
}

// gen_ai.client.operation.duration (src/otel-genai-duration.ts): a DELTA histogram of how long model
// responses took, in seconds, one data point per (agent, model, tenant). Every data point carries
// marveen.duration.source=transcript: the figure is an approximation from transcript timestamps.
export const OPERATION_DURATION_METRIC = 'gen_ai.client.operation.duration'

export function durationToOtelMetricsJson(
  batch: PendingDurations,
  untilMs: number,
  serviceNamespace = 'marveen',
  opts: OtelExportOptions = {},
): OtelMetricsExportPayload {
  const instanceId = opts.serviceInstanceId ?? serviceInstanceId()
  const startNano = msToNano(batch.sinceMs)
  const endNano = msToNano(Math.max(untilMs, batch.sinceMs))
  const byAgent = new Map<string, OtelHistogramDataPoint[]>()
  for (const s of batch.series) {
    if (!(s.count > 0)) continue
    const points = byAgent.get(s.agentId) ?? []
    points.push({
      attributes: [
        ...genAiAttributes(s.model, null, s.agentId, s.tenantId),
        toOtelAttribute(DURATION_SOURCE_KEY, DURATION_SOURCE_TRANSCRIPT),
      ],
      startTimeUnixNano: startNano,
      timeUnixNano: endNano,
      count: String(s.count),
      sum: s.sum,
      bucketCounts: s.buckets.map(String),
      explicitBounds: [...GENAI_DURATION_BUCKET_BOUNDS],
      min: s.min,
      max: s.max,
    })
    byAgent.set(s.agentId, points)
  }
  const resourceMetrics: ResourceMetrics[] = []
  for (const [agentId, dataPoints] of byAgent) {
    resourceMetrics.push({
      resource: { attributes: resourceAttributes(agentId, serviceNamespace, instanceId) },
      scopeMetrics: [{
        scope: { name: 'marveen', version: '1' },
        metrics: [{
          name: OPERATION_DURATION_METRIC,
          unit: 's',
          histogram: { dataPoints, aggregationTemporality: TEMPORALITY_DELTA },
        }],
      }],
    })
  }
  return { resourceMetrics }
}

// ── Registry metrics (src/otel-metrics.ts) ───────────────────────────────────
// The process-level metrics (exporter health, scheduled runs, inter-agent messages, Telegram events), one
// resource for the dashboard process.

export function registryMetricsToOtelJson(
  metrics: unknown[],
  serviceNamespace = 'marveen',
  opts: OtelExportOptions = {},
): { resourceMetrics: unknown[] } {
  const instanceId = opts.serviceInstanceId ?? serviceInstanceId()
  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'marveen-dashboard' } },
          { key: 'service.namespace', value: { stringValue: serviceNamespace } },
          { key: 'service.instance.id', value: { stringValue: instanceId } },
        ],
      },
      scopeMetrics: [{ scope: { name: 'marveen', version: '1' }, metrics }],
    }],
  }
}

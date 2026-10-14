// OTel F1 (#800/#802): OTLP push exporter for traces (otel_spans) and
// metrics (token_usage -> gen_ai.client.token.usage). Config-driven via the
// dashboard settings registry (OTEL_EXPORT_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT
// / OTEL_EXPORTER_OTLP_HEADERS / OTEL_SERVICE_NAME), env-var fallback through
// getEffectiveSettingValue -- see src/settings-store.ts. Re-reads its config
// every tick, so toggling or re-pointing it never needs a restart.
//
// Fail-open by design (Rick's #800 plan): a collector that is down or
// unreachable must never affect the fleet. Every failure is a logger.warn,
// a skipped tick and a growing wait before the next attempt (per signal,
// 30 s doubling to 10 min) -- unexported spans/metrics simply wait for the
// retry. Nothing here ever throws out of the interval callback.
//
// What a failure means (src/otel-transport.ts): a 400-class "this payload is
// wrong" answer is permanent, so that batch is discarded and counted instead
// of blocking every batch behind it; any other non-2xx (a wrong header gives
// 401/403, a wrong path 404, plus 429 and 5xx) is retried. A 2xx may carry a
// partialSuccess: the rejected part is counted and logged, not retried.
// The failure and rejection counts go to the collector as two counters once
// it is reachable again, and out of getOtelExporterStatus() for the process.

import {
  getUnexportedOtelSpans, markOtelSpansExported,
  getOtelMetricsExportState, setOtelMetricsExportWatermark,
  sumTokenUsageWindow, tokenUsageHistogramWindow,
} from '../db.js'
import { spansToOtelJson, tokenUsageToOtelMetricsJson, registryMetricsToOtelJson } from '../otel-exporter.js'
import { collectRegistryMetrics } from '../otel-metrics.js'
import { countExportFailure, countExportRejected } from '../otel-signals.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { readEnvFile } from '../env.js'
import { readOtelExportOptions } from '../otel-export-options.js'
import {
  parseOtlpHeaders, checkEndpoint, isPermanentStatus, parsePartialSuccess,
  backoffDelayMs, parseRetryAfterMs,
} from '../otel-transport.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'
import { logger } from '../logger.js'

const PUSH_INTERVAL_MS = 30_000
const SPAN_BATCH_LIMIT = 500
const RESPONSE_BODY_MAX_CHARS = 4096

type Signal = 'traces' | 'metrics'

export interface SignalState {
  consecutiveFailures: number
  nextAttemptMs: number
  failures: number
  rejected: number
  lastError: string | null
  lastSuccessMs: number | null
}

const startedAtSec = Math.floor(Date.now() / 1000)
const state: Record<Signal, SignalState> = {
  traces: freshSignalState(),
  metrics: freshSignalState(),
}
// One warning per distinct configuration problem, not one per tick.
let lastConfigProblem = ''

function freshSignalState(): SignalState {
  return { consecutiveFailures: 0, nextAttemptMs: 0, failures: 0, rejected: 0, lastError: null, lastSuccessMs: null }
}

export interface OtelExporterStatus {
  traces: SignalState
  metrics: SignalState
}

// The exporter's own health, for diagnostics and tests.
export function getOtelExporterStatus(): OtelExporterStatus {
  return { traces: { ...state.traces }, metrics: { ...state.metrics } }
}

export function resetOtelExporterStatus(): void {
  state.traces = freshSignalState()
  state.metrics = freshSignalState()
  lastConfigProblem = ''
}

interface ExportConfig {
  endpoint: string
  headers: Record<string, string>
  serviceNamespace: string
}

// The headers carry a credential, so they are read from .env only (never from the settings table, which
// an admin session or the shared token can write) and they are bound to the endpoint: while headers are
// set, the endpoint is read from .env as well. Repointing the endpoint through the dashboard then cannot
// send the credential to another host; it takes a change to the .env file.
function readConfig(): {
  enabled: boolean
  endpoint: string
  headersRaw: string
  serviceNamespace: string
  endpointMissingForHeaders: boolean
} {
  const enabled = getEffectiveSettingValue('OTEL_EXPORT_ENABLED') === '1'
  const serviceNamespace = String(getEffectiveSettingValue('OTEL_SERVICE_NAME')).trim() || 'marveen'
  const env = readEnvFile(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'])
  const headersRaw = (env['OTEL_EXPORTER_OTLP_HEADERS'] ?? '').trim()
  if (headersRaw) {
    const endpoint = (env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '').trim()
    return { enabled, endpoint, headersRaw, serviceNamespace, endpointMissingForHeaders: !endpoint }
  }
  const endpoint = String(getEffectiveSettingValue('OTEL_EXPORTER_OTLP_ENDPOINT')).trim()
  return { enabled, endpoint, headersRaw: '', serviceNamespace, endpointMissingForHeaders: false }
}

// The validated configuration, or null (with one warning per distinct problem) when the endpoint or
// the headers cannot be used.
function resolveConfig(): ExportConfig | null {
  const { enabled, endpoint, headersRaw, serviceNamespace, endpointMissingForHeaders } = readConfig()
  if (!enabled) return null
  if (endpointMissingForHeaders) {
    const reason = 'OTEL_EXPORTER_OTLP_HEADERS is set in .env, so OTEL_EXPORTER_OTLP_ENDPOINT must be set in .env too (the credential is bound to the endpoint file); nothing is exported'
    if (reason !== lastConfigProblem) {
      lastConfigProblem = reason
      logger.warn(`otel-push-exporter: ${reason}`)
    }
    return null
  }
  if (!endpoint) return null
  const { headers, rejected } = parseOtlpHeaders(headersRaw)
  const check = checkEndpoint(endpoint, Object.keys(headers).length > 0)
  const problem = !check.ok
    ? check.reason
    : rejected.length > 0
      ? `OTEL_EXPORTER_OTLP_HEADERS: skipped unusable header(s): ${rejected.join(', ')}`
      : ''
  if (problem !== lastConfigProblem) {
    lastConfigProblem = problem
    if (problem) logger.warn({ rejected }, `otel-push-exporter: ${problem}`)
  }
  if (!check.ok) return null
  return { endpoint: check.base, headers, serviceNamespace }
}

type PostResult =
  | { kind: 'ok'; rejected: number; message: string }
  | { kind: 'permanent'; status: number }
  | { kind: 'retry'; reason: string; retryAfterMs?: number }

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<PostResult> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['otel-export']),
      redirect: 'error', // a redirect would carry the headers (credentials) to another host
    })
  } catch (err) {
    return { kind: 'retry', reason: err instanceof Error ? err.message : 'request failed' }
  }
  if (res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, RESPONSE_BODY_MAX_CHARS)
    const partial = parsePartialSuccess(text)
    return { kind: 'ok', rejected: partial?.rejected ?? 0, message: partial?.message ?? '' }
  }
  if (isPermanentStatus(res.status)) return { kind: 'permanent', status: res.status }
  return {
    kind: 'retry',
    reason: `collector answered ${res.status}`,
    retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), Date.now()),
  }
}

function recordSuccess(signal: Signal, rejected: number, message: string, url: string): void {
  const s = state[signal]
  s.consecutiveFailures = 0
  s.nextAttemptMs = 0
  s.lastError = null
  s.lastSuccessMs = Date.now()
  if (rejected > 0) {
    s.rejected += rejected
    countExportRejected(signal, rejected)
    logger.warn({ url, rejected, message }, 'otel-push-exporter: collector accepted the export but rejected part of it')
  }
}

function recordFailure(signal: Signal, result: Extract<PostResult, { kind: 'retry' }>, url: string): void {
  const s = state[signal]
  s.consecutiveFailures += 1
  s.failures += 1
  countExportFailure(signal)
  s.lastError = result.reason
  const delay = Math.max(backoffDelayMs(s.consecutiveFailures), result.retryAfterMs ?? 0)
  s.nextAttemptMs = Date.now() + delay
  logger.warn(
    { url, reason: result.reason, consecutiveFailures: s.consecutiveFailures, retryInMs: delay },
    'otel-push-exporter: export failed, will retry',
  )
}

// A batch the collector will never accept: counted as rejected, and the caller moves on past it.
function recordPermanent(signal: Signal, status: number, items: number, url: string): void {
  const s = state[signal]
  s.failures += 1
  s.rejected += items
  countExportFailure(signal)
  countExportRejected(signal, items)
  s.lastError = `collector rejected the payload (${status})`
  logger.warn({ url, status, items }, 'otel-push-exporter: collector rejected the payload for good, batch discarded')
}

function due(signal: Signal): boolean {
  return Date.now() >= state[signal].nextAttemptMs
}

async function exportTraces(cfg: ExportConfig): Promise<boolean> {
  if (!due('traces')) return false
  const spans = getUnexportedOtelSpans(SPAN_BATCH_LIMIT)
  if (spans.length === 0) return false

  const url = `${cfg.endpoint}/v1/traces`
  const payload = spansToOtelJson(spans, cfg.serviceNamespace, readOtelExportOptions())
  const result = await postJson(url, cfg.headers, payload)
  const done = () => markOtelSpansExported(spans.map((s) => ({ trace_id: s.trace_id, span_id: s.span_id })), Date.now())
  if (result.kind === 'ok') {
    recordSuccess('traces', result.rejected, result.message, url)
    done()
    return true
  }
  if (result.kind === 'permanent') {
    recordPermanent('traces', result.status, spans.length, url)
    done()
    return true // the collector did answer: its verdict goes out with the self-metrics
  }
  recordFailure('traces', result, url)
  return false
}

async function exportMetrics(cfg: ExportConfig): Promise<boolean> {
  if (!due('metrics')) return false
  const { last_export_ms } = getOtelMetricsExportState()
  const nowMs = Date.now()
  const sinceSec = Math.floor(last_export_ms / 1000)
  const untilSec = Math.floor(nowMs / 1000)
  if (untilSec <= sinceSec) return false

  const histogramRows = tokenUsageHistogramWindow(sinceSec, untilSec)
  const rows = sumTokenUsageWindow(sinceSec, untilSec)
  // Advance the watermark even with zero rows -- an empty window is still a
  // fully-covered window, and not advancing would just re-scan it forever.
  if (rows.length === 0 && histogramRows.length === 0) { setOtelMetricsExportWatermark(nowMs); return false }

  const url = `${cfg.endpoint}/v1/metrics`
  const payload = tokenUsageToOtelMetricsJson(histogramRows, rows, sinceSec, untilSec, cfg.serviceNamespace, readOtelExportOptions())
  const result = await postJson(url, cfg.headers, payload)
  if (result.kind === 'ok') {
    recordSuccess('metrics', result.rejected, result.message, url)
    setOtelMetricsExportWatermark(nowMs)
    return true
  }
  if (result.kind === 'permanent') {
    recordPermanent('metrics', result.status, rows.length, url)
    setOtelMetricsExportWatermark(nowMs)
    return true
  }
  recordFailure('metrics', result, url)
  return false
}

// The registry metrics (exporter health, scheduled runs, inter-agent messages, Telegram events) are sent
// whenever the collector just answered. Cumulative series are sent every time, so a backend that expires a
// silent series (Prometheus staleness) never sees them vanish. A failed send is not counted as another
// failure: the next tick tries once more.
async function exportRegistryMetrics(cfg: ExportConfig): Promise<void> {
  const metrics = collectRegistryMetrics()
  if (metrics.length === 0) return
  const payload = registryMetricsToOtelJson(metrics, cfg.serviceNamespace, readOtelExportOptions())
  await postJson(`${cfg.endpoint}/v1/metrics`, cfg.headers, payload)
}

// Exported for tests -- the interval callback itself is just plumbing around
// this; asserting behavior through fake timers would test setInterval, not
// the export logic.
export async function tick(): Promise<void> {
  const cfg = resolveConfig()
  if (!cfg) return
  try {
    await exportTraces(cfg)
  } catch (err) {
    logger.warn({ err }, 'otel-push-exporter: trace export failed')
  }
  try {
    await exportMetrics(cfg)
  } catch (err) {
    logger.warn({ err }, 'otel-push-exporter: metrics export failed')
  }
  // Not while the collector is failing (a second request into the same outage); right after it recovered, yes.
  if (state.traces.consecutiveFailures > 0 || state.metrics.consecutiveFailures > 0 || !due('metrics')) return
  try {
    await exportRegistryMetrics(cfg)
  } catch (err) {
    logger.warn({ err }, 'otel-push-exporter: registry metrics export failed')
  }
}

export function startOtelPushExporter(): NodeJS.Timeout {
  return setInterval(() => {
    tick().catch((err) => logger.warn({ err }, 'otel-push-exporter: tick failed'))
  }, PUSH_INTERVAL_MS)
}

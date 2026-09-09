// OTel F1 (#800/#802): OTLP push exporter for traces (otel_spans) and
// metrics (token_usage -> gen_ai.client.token.usage). Config-driven via the
// dashboard settings registry (OTEL_EXPORT_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT
// / OTEL_SERVICE_NAME), env-var fallback through getEffectiveSettingValue --
// see src/settings-store.ts. Re-reads its config every tick, so toggling or
// re-pointing it never needs a restart.
//
// Fail-open by design (Rick's #800 plan): a collector that is down or
// unreachable must never affect the fleet. Every failure is a logger.warn
// and a skipped tick -- unexported spans/metrics simply wait for the next
// tick's retry. Nothing here ever throws out of the interval callback.

import {
  getUnexportedOtelSpans, markOtelSpansExported,
  getOtelMetricsExportState, setOtelMetricsExportWatermark,
  sumTokenUsageWindow,
} from '../db.js'
import { spansToOtelJson, tokenUsageToOtelMetricsJson } from '../otel-exporter.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'
import { logger } from '../logger.js'

const PUSH_INTERVAL_MS = 30_000
const SPAN_BATCH_LIMIT = 500

function readConfig(): { enabled: boolean; endpoint: string; serviceNamespace: string } {
  const enabled = getEffectiveSettingValue('OTEL_EXPORT_ENABLED') === '1'
  const endpoint = String(getEffectiveSettingValue('OTEL_EXPORTER_OTLP_ENDPOINT')).trim().replace(/\/+$/, '')
  const serviceNamespace = String(getEffectiveSettingValue('OTEL_SERVICE_NAME')).trim() || 'marveen'
  return { enabled, endpoint, serviceNamespace }
}

async function postJson(url: string, body: unknown): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOOL_TIMEOUTS['otel-export']),
  })
  if (!res.ok) {
    logger.warn({ url, status: res.status }, 'otel-push-exporter: collector rejected export')
    return false
  }
  return true
}

async function exportTraces(endpoint: string, serviceNamespace: string): Promise<void> {
  const spans = getUnexportedOtelSpans(SPAN_BATCH_LIMIT)
  if (spans.length === 0) return

  const payload = spansToOtelJson(spans, serviceNamespace)
  const ok = await postJson(`${endpoint}/v1/traces`, payload)
  if (!ok) return
  markOtelSpansExported(spans.map((s) => ({ trace_id: s.trace_id, span_id: s.span_id })), Date.now())
}

async function exportMetrics(endpoint: string, serviceNamespace: string): Promise<void> {
  const { last_export_ms } = getOtelMetricsExportState()
  const nowMs = Date.now()
  const sinceSec = Math.floor(last_export_ms / 1000)
  const untilSec = Math.floor(nowMs / 1000)
  if (untilSec <= sinceSec) return

  const rows = sumTokenUsageWindow(sinceSec, untilSec)
  // Advance the watermark even with zero rows -- an empty window is still a
  // fully-covered window, and not advancing would just re-scan it forever.
  if (rows.length === 0) { setOtelMetricsExportWatermark(nowMs); return }

  const payload = tokenUsageToOtelMetricsJson(rows, sinceSec, untilSec, serviceNamespace)
  const ok = await postJson(`${endpoint}/v1/metrics`, payload)
  if (!ok) return
  setOtelMetricsExportWatermark(nowMs)
}

// Exported for tests -- the interval callback itself is just plumbing around
// this; asserting behavior through fake timers would test setInterval, not
// the export logic.
export async function tick(): Promise<void> {
  const { enabled, endpoint, serviceNamespace } = readConfig()
  if (!enabled || !endpoint) return
  try {
    await exportTraces(endpoint, serviceNamespace)
  } catch (err) {
    logger.warn({ err }, 'otel-push-exporter: trace export failed')
  }
  try {
    await exportMetrics(endpoint, serviceNamespace)
  } catch (err) {
    logger.warn({ err }, 'otel-push-exporter: metrics export failed')
  }
}

export function startOtelPushExporter(): NodeJS.Timeout {
  return setInterval(() => {
    tick().catch((err) => logger.warn({ err }, 'otel-push-exporter: tick failed'))
  }, PUSH_INTERVAL_MS)
}

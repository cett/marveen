// Tests for the OTel F1 push loop (#800/#802): src/web/otel-push-exporter.ts.
// Uses a real in-memory DB (so the unexported-span query / watermark logic
// runs against actual SQL) and mocks fetch + the settings registry so each
// test controls enabled/endpoint without touching the filesystem.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  initDatabase, getDb,
  upsertOtelSpan, closeOtelSpan, getUnexportedOtelSpans,
  setOtelMetricsExportWatermark, getOtelMetricsExportState,
} from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const settings: Record<string, string> = {
  OTEL_EXPORT_ENABLED: '0',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_EXPORT_INPUT_SUMMARY: '0',
  OTEL_SERVICE_NAME: 'marveen',
}
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn((key: string) => settings[key]),
}))

const { tick, getOtelExporterStatus, resetOtelExporterStatus } = await import('../web/otel-push-exporter.js')

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  settings.OTEL_EXPORT_ENABLED = '0'
  settings.OTEL_EXPORTER_OTLP_ENDPOINT = ''
  settings.OTEL_EXPORTER_OTLP_HEADERS = ''
  settings.OTEL_SERVICE_NAME = 'marveen'
  resetOtelExporterStatus()
  setOtelMetricsExportWatermark(0)
  getDb().exec("DELETE FROM otel_spans WHERE trace_id LIKE 'trace-tick-test-%'")
  getDb().exec("DELETE FROM token_usage WHERE agent LIKE 'agent-tick-test-%'")
  vi.restoreAllMocks()
})

function seedClosedSpan(traceId: string, spanId: string) {
  upsertOtelSpan({
    trace_id: traceId, span_id: spanId, parent_span_id: null,
    agent_id: 'agent-tick-test', operation: 'test.op', start_ms: 1000,
    attributes: null,
  })
  closeOtelSpan(traceId, spanId, 2000, 'ok')
}

describe('tick', () => {
  it('does nothing when OTEL_EXPORT_ENABLED is off, even with an endpoint set', async () => {
    settings.OTEL_EXPORT_ENABLED = '0'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.local:4318'
    const fetchSpy = vi.spyOn(global, 'fetch')
    seedClosedSpan('trace-tick-test-1', 'span-1')

    await tick()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does nothing when enabled but the endpoint is empty', async () => {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = ''
    const fetchSpy = vi.spyOn(global, 'fetch')
    seedClosedSpan('trace-tick-test-2', 'span-2')

    await tick()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts unexported spans to <endpoint>/v1/traces and marks them exported on success', async () => {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.local:4318'
    seedClosedSpan('trace-tick-test-3', 'span-3')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await tick()

    const tracesCall = fetchSpy.mock.calls.find(c => String(c[0]).endsWith('/v1/traces'))
    expect(tracesCall).toBeDefined()
    expect(tracesCall![0]).toBe('http://collector.local:4318/v1/traces')
    const body = JSON.parse(String((tracesCall![1] as RequestInit).body))
    expect(body.resourceSpans.length).toBeGreaterThan(0)

    const remaining = getUnexportedOtelSpans(1000).map(s => s.trace_id)
    expect(remaining).not.toContain('trace-tick-test-3')
  })

  it('leaves a span unmarked (retried next tick) when the collector rejects the trace POST', async () => {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.local:4318'
    seedClosedSpan('trace-tick-test-4', 'span-4')
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))

    await tick()

    const remaining = getUnexportedOtelSpans(1000).map(s => s.trace_id)
    expect(remaining).toContain('trace-tick-test-4')
  })

  it('never throws when fetch itself rejects (network error) -- fail-open', async () => {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.local:4318'
    seedClosedSpan('trace-tick-test-5', 'span-5')
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(tick()).resolves.toBeUndefined()

    const remaining = getUnexportedOtelSpans(1000).map(s => s.trace_id)
    expect(remaining).toContain('trace-tick-test-5')
  })

  it('advances the metrics watermark to "now" even when there is nothing to export', async () => {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.local:4318'
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const before = getOtelMetricsExportState().last_export_ms

    await tick()

    expect(getOtelMetricsExportState().last_export_ms).toBeGreaterThan(before)
  })

  it('posts token-usage metrics to <endpoint>/v1/metrics when usage exists in the window', async () => {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector.local:4318'
    getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tenant_id)
      VALUES ('agent-tick-test', 's1', ?, 50, 10, 0, 0, 0, 'claude-sonnet-5', 'default')
    `).run(Math.floor(Date.now() / 1000))
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await tick()

    const metricsCall = fetchSpy.mock.calls.find(c => String(c[0]).endsWith('/v1/metrics'))
    expect(metricsCall).toBeDefined()
    const body = JSON.parse(String((metricsCall![1] as RequestInit).body))
    expect(body.resourceMetrics.length).toBeGreaterThan(0)
  })
})

describe('transport behaviour', () => {
  const ENDPOINT = 'http://collector.local:4318'
  function enable(extra: Partial<typeof settings> = {}) {
    settings.OTEL_EXPORT_ENABLED = '1'
    settings.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT
    Object.assign(settings, extra)
  }
  const callsTo = (spy: ReturnType<typeof vi.spyOn>, suffix: string) =>
    spy.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith(suffix))

  it('sends the configured headers, keeps Content-Type JSON, and refuses to follow a redirect', async () => {
    enable({ OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20tok,X-Org=o1,Content-Type=text/plain' })
    seedClosedSpan('trace-tick-test-h1', 'span-h1')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await tick()

    const init = callsTo(fetchSpy, '/v1/traces')[0][1] as RequestInit
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'X-Org': 'o1', 'Content-Type': 'application/json' })
    expect(init.redirect).toBe('error')
  })

  it('does not export at all when headers would cross plain http to a public host', async () => {
    enable({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.com:4318', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20tok' })
    seedClosedSpan('trace-tick-test-h2', 'span-h2')
    const fetchSpy = vi.spyOn(global, 'fetch')

    await tick()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getUnexportedOtelSpans(1000).map(s => s.trace_id)).toContain('trace-tick-test-h2')
  })

  it('does not export to an endpoint that is not an http(s) URL', async () => {
    enable({ OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://collector:4317' })
    seedClosedSpan('trace-tick-test-h3', 'span-h3')
    const fetchSpy = vi.spyOn(global, 'fetch')
    await tick()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('counts a partialSuccess rejection, marks the batch exported and does not retry it', async () => {
    enable()
    seedClosedSpan('trace-tick-test-p1', 'span-p1')
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"partialSuccess":{"rejectedSpans":"1","errorMessage":"bad"}}', { status: 200 }))

    await tick()

    expect(getUnexportedOtelSpans(1000).map(s => s.trace_id)).not.toContain('trace-tick-test-p1')
    expect(getOtelExporterStatus().traces.rejected).toBe(1)
  })

  it('discards a batch the collector rejects for good (400) so it cannot block the ones behind it', async () => {
    enable()
    seedClosedSpan('trace-tick-test-d1', 'span-d1')
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('bad payload', { status: 400 }))

    await tick()

    expect(getUnexportedOtelSpans(1000).map(s => s.trace_id)).not.toContain('trace-tick-test-d1')
    const t = getOtelExporterStatus().traces
    expect(t.rejected).toBe(1)
    expect(t.failures).toBe(1)
    expect(t.consecutiveFailures).toBe(0) // permanent: no backoff, the next batch goes straight out
  })

  it('keeps the batch on 401 (a wrong header is fixable) and backs off: the next tick does not call the collector', async () => {
    enable()
    seedClosedSpan('trace-tick-test-b1', 'span-b1')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 401 }))

    await tick()
    expect(callsTo(fetchSpy, '/v1/traces')).toHaveLength(1)
    expect(getUnexportedOtelSpans(1000).map(s => s.trace_id)).toContain('trace-tick-test-b1')
    const t = getOtelExporterStatus().traces
    expect(t.consecutiveFailures).toBe(1)
    expect(t.lastError).toContain('401')
    expect(t.nextAttemptMs).toBeGreaterThan(Date.now())

    await tick() // inside the backoff window
    expect(callsTo(fetchSpy, '/v1/traces')).toHaveLength(1)
  })

  it('retries after the backoff has passed, and a success clears the failure streak', async () => {
    enable()
    seedClosedSpan('trace-tick-test-b2', 'span-b2')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('x', { status: 503 }))
    await tick()
    expect(getOtelExporterStatus().traces.consecutiveFailures).toBe(1)

    vi.useFakeTimers({ now: Date.now() + 15 * 60_000, toFake: ['Date'] })
    try {
      fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
      await tick()
    } finally {
      vi.useRealTimers()
    }
    expect(callsTo(fetchSpy, '/v1/traces')).toHaveLength(2)
    expect(getOtelExporterStatus().traces.consecutiveFailures).toBe(0)
    expect(getUnexportedOtelSpans(1000).map(s => s.trace_id)).not.toContain('trace-tick-test-b2')
  })

  it('honors Retry-After when it is longer than the backoff', async () => {
    enable()
    seedClosedSpan('trace-tick-test-b3', 'span-b3')
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('slow down', { status: 429, headers: { 'Retry-After': '1800' } }))
    await tick()
    expect(getOtelExporterStatus().traces.nextAttemptMs - Date.now()).toBeGreaterThan(25 * 60_000)
  })

  it('reports its own failures and rejections to the collector as counters once it answers again', async () => {
    enable()
    seedClosedSpan('trace-tick-test-s1', 'span-s1')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('x', { status: 500 }))
    await tick()
    seedClosedSpan('trace-tick-test-s2', 'span-s2')

    vi.useFakeTimers({ now: Date.now() + 15 * 60_000, toFake: ['Date'] })
    try {
      fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
      await tick()
    } finally {
      vi.useRealTimers()
    }

    // (token-usage rows of earlier tests may also ride on /v1/metrics: pick the self-metrics post)
    const selfCalls = () => callsTo(fetchSpy, '/v1/metrics')
      .filter((c: unknown[]) => String((c[1] as RequestInit).body).includes('marveen.otel.export.failures'))
    const metricCalls = selfCalls()
    expect(metricCalls).toHaveLength(1)
    const body = JSON.parse(String((metricCalls[0][1] as RequestInit).body))
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics
    expect(metrics.map((m: any) => m.name)).toEqual(['marveen.otel.export.failures', 'marveen.otel.export.rejected'])
    const failures = metrics[0].sum
    expect(failures.aggregationTemporality).toBe(2) // cumulative
    expect(failures.isMonotonic).toBe(true)
    const traces = failures.dataPoints.find((d: any) => d.attributes[0].value.stringValue === 'traces')
    expect(traces.asInt).toBe('1')

    // unchanged counters are not sent again
    vi.useFakeTimers({ now: Date.now() + 30 * 60_000, toFake: ['Date'] })
    try {
      seedClosedSpan('trace-tick-test-s3', 'span-s3')
      await tick()
    } finally {
      vi.useRealTimers()
    }
    expect(selfCalls()).toHaveLength(1)
  })
})

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
  OTEL_SERVICE_NAME: 'marveen',
}
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn((key: string) => settings[key]),
}))

const { tick } = await import('../web/otel-push-exporter.js')

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  settings.OTEL_EXPORT_ENABLED = '0'
  settings.OTEL_EXPORTER_OTLP_ENDPOINT = ''
  settings.OTEL_SERVICE_NAME = 'marveen'
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

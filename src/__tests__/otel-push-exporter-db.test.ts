// DB-layer tests for the OTel F1 push exporter (#800/#802): the
// unexported-span query + export watermark, and the token_usage window
// aggregation feeding the gen_ai.client.token.usage metric.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import {
  initDatabase, getDb,
  upsertOtelSpan, closeOtelSpan,
  getUnexportedOtelSpans, markOtelSpansExported,
  getOtelMetricsExportState, setOtelMetricsExportWatermark,
  sumTokenUsageWindow,
} from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterEach(() => {
  const db = getDb()
  db.exec("DELETE FROM otel_spans WHERE trace_id LIKE 'trace-push-test-%'")
  db.exec("DELETE FROM token_usage WHERE agent LIKE 'agent-push-test-%'")
})

function seedSpan(traceId: string, spanId: string, closed = true) {
  upsertOtelSpan({
    trace_id: traceId, span_id: spanId, parent_span_id: null,
    agent_id: 'agent-push-test-a', operation: 'test.op', start_ms: 1000,
    attributes: null,
  })
  if (closed) closeOtelSpan(traceId, spanId, 2000, 'ok')
}

describe('getUnexportedOtelSpans / markOtelSpansExported', () => {
  it('returns only closed spans with exported_at IS NULL', () => {
    seedSpan('trace-push-test-1', 'span-1', true)
    seedSpan('trace-push-test-2', 'span-2', false) // still open (running)
    const rows = getUnexportedOtelSpans(100)
    const traceIds = rows.map(r => r.trace_id)
    expect(traceIds).toContain('trace-push-test-1')
    expect(traceIds).not.toContain('trace-push-test-2')
  })

  it('excludes a span once markOtelSpansExported has run for it', () => {
    seedSpan('trace-push-test-3', 'span-3', true)
    const before = getUnexportedOtelSpans(1000).map(r => r.trace_id)
    expect(before).toContain('trace-push-test-3')

    markOtelSpansExported([{ trace_id: 'trace-push-test-3', span_id: 'span-3' }], Date.now())

    const after = getUnexportedOtelSpans(1000).map(r => r.trace_id)
    expect(after).not.toContain('trace-push-test-3')
  })

  it('is a no-op for an empty batch (does not throw)', () => {
    expect(() => markOtelSpansExported([], Date.now())).not.toThrow()
  })

  it('respects the limit argument', () => {
    for (let i = 0; i < 5; i++) seedSpan('trace-push-test-limit', `span-limit-${i}`, true)
    const rows = getUnexportedOtelSpans(2)
    expect(rows.length).toBeLessThanOrEqual(2)
  })
})

describe('otel metrics export watermark', () => {
  it('starts at 0 for a fresh database', () => {
    // Reset explicitly since other tests in the suite may have advanced it.
    setOtelMetricsExportWatermark(0)
    expect(getOtelMetricsExportState().last_export_ms).toBe(0)
  })

  it('setOtelMetricsExportWatermark persists and getOtelMetricsExportState reflects it', () => {
    setOtelMetricsExportWatermark(123456)
    expect(getOtelMetricsExportState().last_export_ms).toBe(123456)
    setOtelMetricsExportWatermark(654321)
    expect(getOtelMetricsExportState().last_export_ms).toBe(654321)
  })
})

describe('sumTokenUsageWindow', () => {
  function insertUsage(agent: string, tsSec: number, input: number, output: number, model = 'claude-sonnet-5', tenant = 'default') {
    getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tenant_id)
      VALUES (?, 's1', ?, ?, ?, 0, 0, 0, ?, ?)
    `).run(agent, tsSec, input, output, model, tenant)
  }

  it('sums tokens strictly within (sinceSec, untilSec]', () => {
    insertUsage('agent-push-test-b', 1000, 10, 5)
    insertUsage('agent-push-test-b', 1500, 20, 8)
    insertUsage('agent-push-test-b', 2000, 999, 999) // outside window (> until)
    insertUsage('agent-push-test-b', 500, 999, 999)  // outside window (<= since)

    const rows = sumTokenUsageWindow(900, 1600)
    const row = rows.find(r => r.agent === 'agent-push-test-b')
    expect(row?.input_tokens).toBe(30)
    expect(row?.output_tokens).toBe(13)
  })

  it('excludes a row exactly AT sinceSec (lower bound is exclusive, avoids double-count across ticks)', () => {
    // A row landing exactly on the previous tick's watermark must belong to
    // that earlier window only -- otherwise consecutive ticks would both
    // claim it and double-export the same tokens.
    insertUsage('agent-push-test-boundary', 1000, 42, 0)
    const rows = sumTokenUsageWindow(1000, 2000)
    expect(rows.find(r => r.agent === 'agent-push-test-boundary')).toBeUndefined()
  })

  it('includes a row exactly AT untilSec (upper bound is inclusive)', () => {
    insertUsage('agent-push-test-boundary2', 2000, 7, 0)
    const rows = sumTokenUsageWindow(1000, 2000)
    expect(rows.find(r => r.agent === 'agent-push-test-boundary2')?.input_tokens).toBe(7)
  })

  it('groups by agent, model, and tenant separately', () => {
    insertUsage('agent-push-test-c', 1000, 10, 0, 'claude-sonnet-5', 'default')
    insertUsage('agent-push-test-c', 1000, 5, 0, 'claude-opus-5', 'default')
    insertUsage('agent-push-test-c', 1000, 3, 0, 'claude-sonnet-5', 'acme')

    const rows = sumTokenUsageWindow(0, 2000).filter(r => r.agent === 'agent-push-test-c')
    expect(rows).toHaveLength(3)
  })

  it('returns an empty array when nothing falls in the window', () => {
    insertUsage('agent-push-test-d', 5000, 10, 0)
    const rows = sumTokenUsageWindow(0, 100)
    expect(rows.find(r => r.agent === 'agent-push-test-d')).toBeUndefined()
  })
})

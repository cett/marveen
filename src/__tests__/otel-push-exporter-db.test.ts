// DB-layer tests for the OTel F1 push exporter (#800/#802): the
// unexported-span query + export watermark, and the token_usage window
// aggregation feeding the gen_ai.client.token.usage metric.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import {
  initDatabase, getDb,
  upsertOtelSpan, closeOtelSpan,
  getUnexportedOtelSpans, markOtelSpansExported, OTEL_RUNNING_SPAN_IDLE_MS,
  getOtelMetricsExportState, setOtelMetricsExportWatermark,
  sumTokenUsageWindow, tokenUsageHistogramWindow,
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

  it('holds back a running span whose end_ms still moves (agent.turn), exporting it only after it closed or went idle', () => {
    const now = 10_000_000
    // agent.turn shape: running, end_ms rolled forward by the hook on every tool call
    upsertOtelSpan({
      trace_id: 'trace-push-test-turn', span_id: 'turn-1', parent_span_id: null,
      agent_id: 'agent-push-test-a', operation: 'agent.turn', start_ms: now - 60_000, end_ms: now - 1000,
      status: 'running', attributes: null,
    })
    expect(getUnexportedOtelSpans(100, now).map(r => r.span_id)).not.toContain('turn-1')

    // the next tool call moves end_ms: still held back, so no truncated duration is ever shipped
    upsertOtelSpan({
      trace_id: 'trace-push-test-turn', span_id: 'turn-1', parent_span_id: null,
      agent_id: 'agent-push-test-a', operation: 'agent.turn', start_ms: now - 60_000, end_ms: now,
      status: 'running', attributes: null,
    })
    expect(getUnexportedOtelSpans(100, now + 1000).map(r => r.span_id)).not.toContain('turn-1')

    // the idle window passed with no further tool call: the last turn of a session goes out as it stands
    expect(getUnexportedOtelSpans(100, now + OTEL_RUNNING_SPAN_IDLE_MS).map(r => r.span_id)).toContain('turn-1')

    // or the turn is closed (status ok) by the next turn boundary: exported at once
    closeOtelSpan('trace-push-test-turn', 'turn-1', now, 'ok')
    expect(getUnexportedOtelSpans(100, now + 1000).map(r => r.span_id)).toContain('turn-1')
  })

  it('re-exports a span whose final state arrives after it was exported idle (upsert and close both clear exported_at)', () => {
    const now = 10_000_000
    const seedRunning = () => upsertOtelSpan({
      trace_id: 'trace-push-test-late', span_id: 'late-1', parent_span_id: null,
      agent_id: 'agent-push-test-a', operation: 'agent.turn', start_ms: now - 3_600_000, end_ms: now - 2_000_000,
      status: 'running', attributes: null,
    })
    const pending = (at: number) => getUnexportedOtelSpans(100, at).map(r => r.span_id)

    // exported as idle-running ...
    seedRunning()
    expect(pending(now)).toContain('late-1')
    markOtelSpansExported([{ trace_id: 'trace-push-test-late', span_id: 'late-1' }], now)
    expect(pending(now)).not.toContain('late-1')

    // ... the same write again changes nothing, so nothing is re-sent
    seedRunning()
    expect(pending(now)).not.toContain('late-1')

    // ... the turn went on: upsert moves end_ms, then it is closed for real
    upsertOtelSpan({
      trace_id: 'trace-push-test-late', span_id: 'late-1', parent_span_id: null,
      agent_id: 'agent-push-test-a', operation: 'agent.turn', start_ms: now - 3_600_000, end_ms: now - 1000,
      status: 'running', attributes: null,
    })
    closeOtelSpan('trace-push-test-late', 'late-1', now, 'ok')
    expect(pending(now)).toContain('late-1')
    expect(getUnexportedOtelSpans(100, now).find(r => r.span_id === 'late-1')).toMatchObject({ end_ms: now, status: 'ok' })

    // exported again in its final state: closing it once more with the same values does not queue it again
    markOtelSpansExported([{ trace_id: 'trace-push-test-late', span_id: 'late-1' }], now)
    closeOtelSpan('trace-push-test-late', 'late-1', now, 'ok')
    expect(pending(now)).not.toContain('late-1')
  })

  it('a close without an earlier export is exported once, and the re-export rule does not touch other spans', () => {
    seedSpan('trace-push-test-plain', 'plain-1', true)
    seedSpan('trace-push-test-other', 'other-1', true)
    markOtelSpansExported([{ trace_id: 'trace-push-test-other', span_id: 'other-1' }], Date.now())
    closeOtelSpan('trace-push-test-plain', 'plain-1', 2000, 'ok') // unchanged values
    const ids = getUnexportedOtelSpans(100).map(r => r.span_id)
    expect(ids).toContain('plain-1')
    expect(ids).not.toContain('other-1')
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

describe('tokenUsageHistogramWindow', () => {
  function insertUsage(agent: string, tsSec: number, input: number, output: number, model = 'claude-sonnet-5', tenant = 'default') {
    getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tenant_id)
      VALUES (?, 's1', ?, ?, ?, 0, 0, 0, ?, ?)
    `).run(agent, tsSec, input, output, model, tenant)
  }
  const mine = (agent: string, since = 0, until = 2000) => tokenUsageHistogramWindow(since, until).filter(r => r.agent === agent)

  it('puts a value in the first bucket whose bound is >= the value, and past the last bound in the open-ended one', () => {
    // bounds: 1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
    const cases: [number, number][] = [
      [1, 0], [2, 1], [4, 1], [5, 2], [16, 2], [17, 3], [64, 3], [65, 4],
      [67_108_864, 13], [67_108_865, 14], [900_000_000, 14],
    ]
    for (const [value] of cases) insertUsage('agent-push-test-h1', 1000, value, 0)
    const rows = mine('agent-push-test-h1')
    for (const [value, bucket] of cases) {
      const row = rows.find(r => r.bucket === bucket && r.min_value <= value && r.max_value >= value)
      expect(row, `value ${value} should be in bucket ${bucket}`).toBeDefined()
    }
    // every observation was counted exactly once
    expect(rows.reduce((acc, r) => acc + r.n, 0)).toBe(cases.length)
  })

  it('counts, sums and bounds the observations of one bucket', () => {
    insertUsage('agent-push-test-h2', 1000, 20, 0)
    insertUsage('agent-push-test-h2', 1100, 60, 0)
    const [row] = mine('agent-push-test-h2')
    expect(row).toMatchObject({ token_type: 'input', bucket: 3, n: 2, total: 80, min_value: 20, max_value: 60 })
  })

  it('keeps the input and the output side apart and skips a zero value (no observation)', () => {
    insertUsage('agent-push-test-h3', 1000, 100, 0)
    insertUsage('agent-push-test-h3', 1100, 0, 7)
    insertUsage('agent-push-test-h3', 1200, 0, 0)
    const rows = mine('agent-push-test-h3')
    expect(rows.map(r => `${r.token_type}:${r.n}:${r.total}`).sort()).toEqual(['input:1:100', 'output:1:7'])
  })

  it('uses the same window as the sums: lower bound exclusive, upper bound inclusive', () => {
    insertUsage('agent-push-test-h4', 1000, 10, 0) // at since: excluded
    insertUsage('agent-push-test-h4', 2000, 10, 0) // at until: included
    insertUsage('agent-push-test-h4', 2001, 10, 0) // after until: excluded
    const rows = mine('agent-push-test-h4', 1000, 2000)
    expect(rows.reduce((acc, r) => acc + r.n, 0)).toBe(1)
  })

  it('groups by agent, model and tenant', () => {
    // token_usage is unique on (agent, session, timestamp, input, output): vary the counts
    insertUsage('agent-push-test-h5', 1000, 10, 0, 'claude-sonnet-5', 'default')
    insertUsage('agent-push-test-h5', 1000, 11, 0, 'claude-opus-5', 'default')
    insertUsage('agent-push-test-h5', 1000, 12, 0, 'claude-sonnet-5', 'tenant-b')
    expect(mine('agent-push-test-h5')).toHaveLength(3)
  })

  it('adds up to the same tokens as sumTokenUsageWindow for input and output', () => {
    insertUsage('agent-push-test-h6', 1000, 7, 3)
    insertUsage('agent-push-test-h6', 1100, 5000, 900)
    insertUsage('agent-push-test-h6', 1200, 123456, 0)
    const hist = mine('agent-push-test-h6')
    const sum = sumTokenUsageWindow(0, 2000).find(r => r.agent === 'agent-push-test-h6')!
    const total = (type: string) => hist.filter(r => r.token_type === type).reduce((acc, r) => acc + r.total, 0)
    expect(total('input')).toBe(sum.input_tokens)
    expect(total('output')).toBe(sum.output_tokens)
  })

  it('returns nothing when the window is empty', () => {
    insertUsage('agent-push-test-h7', 5000, 10, 10)
    expect(mine('agent-push-test-h7', 0, 100)).toEqual([])
  })
})

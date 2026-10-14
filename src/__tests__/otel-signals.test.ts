import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, appendTaskRun, upsertOtelSpan, getOtelTrace } from '../db.js'
import { collectRegistryMetrics, resetMetricValues } from '../otel-metrics.js'
import { recordMessageDelivered, countExportFailure, countExportRejected } from '../otel-signals.js'
import { recordMessageFailure } from '../web/message-router.js'

beforeAll(() => initDatabase(':memory:'))
beforeEach(() => {
  resetMetricValues()
  getDb().exec('DELETE FROM agent_messages')
  getDb().exec('DELETE FROM incoming_events')
})

const metric = (name: string) => collectRegistryMetrics().find((m) => m.name === name)
const points = (name: string) => {
  const m = metric(name)
  return ((m?.sum ?? m?.gauge ?? m?.histogram)?.dataPoints ?? []) as any[]
}
const attrMap = (p: any) => Object.fromEntries(p.attributes.map((a: any) => [a.key, a.value.stringValue]))

describe('scheduled runs', () => {
  it('appendTaskRun counts each occurrence by schedule and status', () => {
    appendTaskRun('nightly', 'agent-a', 'fired')
    appendTaskRun('nightly', 'agent-a', 'fired')
    appendTaskRun('nightly', 'agent-a', 'error')
    const byStatus = Object.fromEntries(points('marveen.schedule.runs').map((p) => [attrMap(p).status, p.asInt]))
    expect(byStatus).toEqual({ fired: '2', error: '1' })
    expect(attrMap(points('marveen.schedule.runs')[0]).schedule).toBe('nightly')
  })
})

describe('inter-agent messages', () => {
  it('reads queue depth and oldest pending age from the table, and counts neither content nor agents', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const ins = getDb().prepare("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('a', 'b', 'secret text', ?, ?)")
    ins.run('pending', nowSec - 120)
    ins.run('pending', nowSec - 30)
    ins.run('done', nowSec - 500)
    expect(points('marveen.agent_messages.pending')[0].asDouble).toBe(2)
    expect(points('marveen.agent_messages.oldest_pending_age')[0].asDouble).toBeGreaterThanOrEqual(120)
    expect(JSON.stringify(collectRegistryMetrics())).not.toContain('secret text')
  })

  it('an empty queue reports a depth of 0 and no age', () => {
    expect(points('marveen.agent_messages.pending')[0].asDouble).toBe(0)
    expect(metric('marveen.agent_messages.oldest_pending_age')).toBeUndefined()
  })

  it('records delivery latency from created_at', () => {
    recordMessageDelivered(Math.floor(Date.now() / 1000) - 7)
    const dp = points('marveen.agent_messages.delivery.duration')[0]
    expect(dp.count).toBe('1')
    expect(dp.sum).toBeGreaterThanOrEqual(6)
    expect(points('marveen.agent_messages.delivered')[0].asInt).toBe('1')
  })

  it('a failed message is counted by reason and its span is closed as error (abandoned/inject-failed spans never stay open)', () => {
    upsertOtelSpan({
      trace_id: 'trace-sig-1', span_id: 'span-sig-1', parent_span_id: null, agent_id: 'a',
      operation: 'a->b', start_ms: 1000, attributes: null,
    })
    recordMessageFailure({ trace_id: 'trace-sig-1', span_id: 'span-sig-1' }, 'abandoned')
    const span = getOtelTrace('trace-sig-1')[0]
    expect(span.status).toBe('error')
    expect(span.end_ms).not.toBeNull()
    expect(attrMap(points('marveen.agent_messages.failed')[0]).reason).toBe('abandoned')
  })

  it('a failed message without span ids is still counted', () => {
    recordMessageFailure({ trace_id: null, span_id: null }, 'error')
    expect(points('marveen.agent_messages.failed')).toHaveLength(1)
  })
})

describe('Telegram channel events', () => {
  it('exposes counts per status and the oldest pending age, never content or user names', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const ins = getDb().prepare(
      "INSERT INTO incoming_events (source, update_id, chat_id, user_id, username, message_id, kind, content, meta, status, created_at) VALUES ('telegram', ?, 1, 2, 'some_user', 3, 'text', 'hello private text', '{}', ?, ?)")
    ins.run(1, 'pending', nowSec - 90)
    ins.run(2, 'delivered', nowSec - 10)
    ins.run(3, 'delivered', nowSec - 5)
    const byStatus = Object.fromEntries(points('marveen.channel.events').map((p) => [attrMap(p).status, p.asDouble]))
    expect(byStatus).toEqual({ pending: 1, delivered: 2 })
    expect(points('marveen.channel.handoff.oldest_pending_age')[0].asDouble).toBeGreaterThanOrEqual(90)
    const all = JSON.stringify(collectRegistryMetrics())
    expect(all).not.toContain('hello private text')
    expect(all).not.toContain('some_user')
  })
})

describe('exporter health counters', () => {
  it('label the signal with the marveen.otel.signal key, not a bare "signal"', () => {
    countExportFailure('traces')
    countExportFailure('metrics')
    countExportFailure('metrics')
    countExportRejected('traces', 4)
    const failures = points('marveen.otel.export.failures')
    expect(failures.map((p) => p.attributes.map((a: any) => a.key))).toEqual(failures.map(() => ['marveen.otel.signal']))
    expect(Object.fromEntries(failures.map((p) => [attrMap(p)['marveen.otel.signal'], p.asInt]))).toEqual({ traces: '1', metrics: '2' })
    const rejected = points('marveen.otel.export.rejected')
    expect(rejected).toHaveLength(1)
    expect(attrMap(rejected[0])).toEqual({ 'marveen.otel.signal': 'traces' })
    expect(rejected[0].asInt).toBe('4')
  })

  it('drops an attribute key the metric does not declare (a bare "signal" is not one)', () => {
    countExportFailure('traces')
    for (const p of points('marveen.otel.export.failures')) expect(Object.keys(attrMap(p))).not.toContain('signal')
  })
})

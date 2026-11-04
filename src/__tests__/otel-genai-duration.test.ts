// gen_ai.client.operation.duration (src/otel-genai-duration.ts + the exporter wiring): which spans carry a
// trustworthy duration, how they are binned, and what happens when the send fails.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initDatabase, getDb, upsertOtelSpan, closeOtelSpan, type OtelSpan } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const cfg: Record<string, string> = {
  OTEL_EXPORT_ENABLED: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.local:4318',
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_EXPORT_INPUT_SUMMARY: '0',
  OTEL_SERVICE_NAME: 'marveen',
}
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn((key: string) => cfg[key]),
}))

const envFile = vi.hoisted(() => ({}) as Record<string, string>)
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>()
  return {
    ...actual,
    readEnvFile: (keys?: string[]) =>
      keys && keys.length > 0 && keys.every((k) => k.startsWith('OTEL_'))
        ? Object.fromEntries(Object.entries(envFile).filter(([k]) => keys.includes(k)))
        : actual.readEnvFile(keys),
  }
})

const dur = await import('../otel-genai-duration.js')
const { durationToOtelMetricsJson, EXPORT_ATTRIBUTE_ALLOWLIST, spansToOtelJson } = await import('../otel-exporter.js')
const { GENAI_DURATION_BUCKET_BOUNDS, DURATION_MAX_SECONDS } = await import('../otel-genai.js')
const { tick, resetOtelExporterStatus } = await import('../web/otel-push-exporter.js')

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  dur.resetPendingDurations()
  resetOtelExporterStatus()
  getDb().exec("DELETE FROM otel_spans WHERE trace_id LIKE 'trace-dur-%'")
  getDb().exec("DELETE FROM token_usage WHERE agent LIKE 'agent-dur-%'")
  vi.restoreAllMocks()
})

function span(over: Partial<OtelSpan> & { blob?: Record<string, unknown> | null } = {}): OtelSpan {
  const { blob, ...rest } = over
  const attrs = blob === null ? null : JSON.stringify({ model: 'model-a', 'marveen.duration.source': 'transcript', ...(blob ?? {}) })
  return {
    trace_id: 'trace-dur-1', span_id: 'msg_1', parent_span_id: null, agent_id: 'agent-dur-a', operation: 'model.call',
    start_ms: 10_000, end_ms: 12_500, status: 'ok', attributes: attrs, tenant_id: 'tenant-a', ...rest,
  }
}

describe('durationSecondsOf', () => {
  it('is end - start in seconds for a marked, closed, ok model.call span', () => {
    expect(dur.durationSecondsOf(span())).toBe(2.5)
  })
  it('is null without the marker: start == end spans carry no measurement', () => {
    expect(dur.durationSecondsOf(span({ blob: { 'marveen.duration.source': 'guess' } }))).toBeNull()
    expect(dur.durationSecondsOf(span({ attributes: JSON.stringify({ model: 'model-a' }) }))).toBeNull()
    expect(dur.durationSecondsOf(span({ attributes: null }))).toBeNull()
    expect(dur.durationSecondsOf(span({ attributes: '{not json' }))).toBeNull()
  })
  it('is null when the span has no positive length, is not closed ok, or is another operation', () => {
    expect(dur.durationSecondsOf(span({ start_ms: 5, end_ms: 5 }))).toBeNull()
    expect(dur.durationSecondsOf(span({ start_ms: 9, end_ms: 5 }))).toBeNull()
    expect(dur.durationSecondsOf(span({ end_ms: null }))).toBeNull()
    expect(dur.durationSecondsOf(span({ status: 'error' }))).toBeNull()
    expect(dur.durationSecondsOf(span({ status: 'running' }))).toBeNull()
    expect(dur.durationSecondsOf(span({ operation: 'agent.turn' }))).toBeNull()
    expect(dur.durationSecondsOf(span({ operation: 'tool.Bash' }))).toBeNull()
  })
  it('keeps the cap itself and refuses anything over it', () => {
    expect(dur.durationSecondsOf(span({ start_ms: 0, end_ms: DURATION_MAX_SECONDS * 1000 }))).toBe(DURATION_MAX_SECONDS)
    expect(dur.durationSecondsOf(span({ start_ms: 0, end_ms: DURATION_MAX_SECONDS * 1000 + 1 }))).toBeNull()
  })
})

describe('recordDurations / takePendingDurations', () => {
  it('bins into the convention buckets: a value on a bound goes into that bound, above the last into overflow', () => {
    const at = (seconds: number, id: string) => span({ span_id: id, start_ms: 0, end_ms: seconds * 1000 })
    dur.recordDurations([at(0.01, 'a'), at(0.011, 'b'), at(81.92, 'c'), at(100, 'd')])
    const batch = dur.takePendingDurations()!
    expect(batch.series).toHaveLength(1)
    const s = batch.series[0]
    expect(s.count).toBe(4)
    expect(s.buckets[0]).toBe(1) // <= 0.01
    expect(s.buckets[1]).toBe(1) // <= 0.02
    expect(s.buckets[GENAI_DURATION_BUCKET_BOUNDS.length - 1]).toBe(1) // <= 81.92
    expect(s.buckets[GENAI_DURATION_BUCKET_BOUNDS.length]).toBe(1) // overflow
    expect(s.buckets.reduce((a, b) => a + b, 0)).toBe(4)
    expect(s.min).toBe(0.01)
    expect(s.max).toBe(100)
    expect(s.sum).toBeCloseTo(0.01 + 0.011 + 81.92 + 100)
  })

  it('keeps series apart per agent, tenant and model, and calls a missing tenant unresolved', () => {
    dur.recordDurations([
      span({ span_id: 'a' }), span({ span_id: 'b', agent_id: 'agent-dur-b' }),
      span({ span_id: 'c', tenant_id: null }), span({ span_id: 'd', blob: { model: 'model-b' } }),
    ])
    const keys = dur.takePendingDurations()!.series.map((s) => `${s.agentId}/${s.tenantId}/${s.model}`).sort()
    expect(keys).toEqual([
      'agent-dur-a/tenant-a/model-a', 'agent-dur-a/tenant-a/model-b', 'agent-dur-a/unresolved/model-a', 'agent-dur-b/tenant-a/model-a',
    ])
  })

  it('records nothing for spans without a measured duration, and take is then null', () => {
    expect(dur.recordDurations([span({ blob: { 'marveen.duration.source': 'x' } }), span({ start_ms: 1, end_ms: 1 })])).toBe(0)
    expect(dur.takePendingDurations()).toBeNull()
  })

  it('hands a batch over once, and restore merges it back with what came in meanwhile', () => {
    dur.recordDurations([span({ span_id: 'a' })], 1000)
    const first = dur.takePendingDurations()!
    expect(dur.takePendingDurations()).toBeNull()
    dur.recordDurations([span({ span_id: 'b', start_ms: 0, end_ms: 1000 })], 5000)
    dur.restorePendingDurations(first)
    const merged = dur.takePendingDurations()!
    expect(merged.sinceMs).toBe(1000)
    expect(merged.series).toHaveLength(1)
    expect(merged.series[0].count).toBe(2)
    expect(merged.series[0].sum).toBeCloseTo(3.5)
    expect(merged.series[0].min).toBe(1)
    expect(merged.series[0].max).toBe(2.5)
  })

  it('never throws on a span it cannot read', () => {
    expect(() => dur.recordDurations([null as unknown as OtelSpan, span({ attributes: '[1]' })])).not.toThrow()
  })
})

describe('durationToOtelMetricsJson', () => {
  it('is a DELTA histogram in seconds with the conventional bounds, the agent resource and the approximation marker', () => {
    dur.recordDurations([span(), span({ span_id: 'b', start_ms: 0, end_ms: 4000 })], 1_000_000)
    const payload = durationToOtelMetricsJson(dur.takePendingDurations()!, 2_000_000, 'ns-a', { serviceInstanceId: 'inst-a' }) as any
    const rm = payload.resourceMetrics
    expect(rm).toHaveLength(1)
    const res = Object.fromEntries(rm[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue]))
    expect(res).toMatchObject({ 'service.name': 'marveen-agent-agent-dur-a', 'service.namespace': 'ns-a', 'service.instance.id': 'inst-a' })
    const metric = rm[0].scopeMetrics[0].metrics[0]
    expect(metric.name).toBe('gen_ai.client.operation.duration')
    expect(metric.unit).toBe('s')
    expect(metric.histogram.aggregationTemporality).toBe(1)
    const p = metric.histogram.dataPoints[0]
    expect(p.explicitBounds).toEqual([...GENAI_DURATION_BUCKET_BOUNDS])
    expect(p.count).toBe('2')
    expect(p.sum).toBeCloseTo(6.5)
    expect(p.bucketCounts).toHaveLength(GENAI_DURATION_BUCKET_BOUNDS.length + 1)
    expect(p.startTimeUnixNano).toBe('1000000000000')
    expect(p.timeUnixNano).toBe('2000000000000')
    const attrs = Object.fromEntries(p.attributes.map((a: any) => [a.key, a.value.stringValue]))
    expect(attrs).toMatchObject({
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': 'model-a',
      'gen_ai.response.model': 'model-a', 'marveen.agent.id': 'agent-dur-a', 'marveen.tenant.id': 'tenant-a',
      'marveen.duration.source': 'transcript',
    })
  })
})

describe('the span export', () => {
  it('passes the marker through as an attribute (it is on the allowlist) and does not invent one', () => {
    expect(EXPORT_ATTRIBUTE_ALLOWLIST.has('marveen.duration.source')).toBe(true)
    const json = JSON.stringify(spansToOtelJson([span()], 'ns-a', { serviceInstanceId: 'inst-a' }))
    expect(json).toContain('marveen.duration.source')
    const plain = JSON.stringify(spansToOtelJson([span({ blob: { 'marveen.duration.source': undefined } })], 'ns-a', { serviceInstanceId: 'inst-a' }))
    expect(plain).not.toContain('marveen.duration.source')
  })
})

describe('through tick', () => {
  async function seedModelCallSpan(id: string, measured = true) {
    await upsertOtelSpan({
      trace_id: 'trace-dur-t', span_id: id, parent_span_id: null, agent_id: 'agent-dur-t', operation: 'model.call',
      start_ms: 100_000, attributes: JSON.stringify({ model: 'model-a', ...(measured ? { 'marveen.duration.source': 'transcript' } : {}) }),
    })
    await closeOtelSpan('trace-dur-t', id, measured ? 103_000 : 100_000, 'ok')
  }
  const callsTo = (spy: ReturnType<typeof vi.spyOn>, suffix: string) =>
    spy.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith(suffix))
  const durationCalls = (spy: ReturnType<typeof vi.spyOn>) =>
    callsTo(spy, '/v1/metrics').filter((c: unknown[]) => String((c[1] as { body: string }).body).includes('gen_ai.client.operation.duration'))

  it('sends the durations of the spans it just exported to /v1/metrics, once', async () => {
    await seedModelCallSpan('msg_t1')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(1)
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(1)
  })

  it('sends nothing for a span without a measured duration', async () => {
    await seedModelCallSpan('msg_t2', false)
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(0)
  })

  it('does not count the durations of spans whose trace export failed, and counts them once they went out', async () => {
    await seedModelCallSpan('msg_t3')
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 503 }))
    await tick()
    expect(dur.takePendingDurations()).toBeNull()
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000) // past the backoff
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(1)
  })

  it('keeps the observations when the metrics send fails and sends them on the next try', async () => {
    await seedModelCallSpan('msg_t4')
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/v1/traces') ? new Response('{}', { status: 200 }) : new Response('no', { status: 503 }))
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(1)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000)
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(2)
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(2)
  })

  it('drops a batch the collector refuses for good instead of retrying it for ever', async () => {
    await seedModelCallSpan('msg_t5')
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/v1/traces') ? new Response('{}', { status: 200 }) : new Response('bad', { status: 400 }))
    await tick()
    expect(durationCalls(fetchSpy)).toHaveLength(1)
    expect(dur.takePendingDurations()).toBeNull()
  })
})

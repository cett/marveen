import { describe, it, expect } from 'vitest'
import { spansToOtelJson, tokenUsageToOtelMetricsJson } from '../otel-exporter.js'
import type { OtelSpan, TokenUsageMetricRow } from '../db.js'

function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  return {
    trace_id: 'trace-001',
    span_id: 'span-001',
    parent_span_id: null,
    agent_id: 'agent-a',
    operation: 'test.op',
    start_ms: 1000,
    end_ms: 2000,
    status: 'ok',
    attributes: null,
    ...overrides,
  }
}

describe('spansToOtelJson', () => {
  it('returns resourceSpans array', () => {
    const result = spansToOtelJson([span()])
    expect(result).toHaveProperty('resourceSpans')
    expect(Array.isArray(result.resourceSpans)).toBe(true)
  })

  it('groups spans by agent_id into separate resourceSpans blocks', () => {
    const spans = [
      span({ agent_id: 'agent-a', span_id: 'span-a1' }),
      span({ agent_id: 'agent-b', span_id: 'span-b1' }),
      span({ agent_id: 'agent-a', span_id: 'span-a2' }),
    ]
    const result = spansToOtelJson(spans)
    expect(result.resourceSpans).toHaveLength(2)
    const agentABlock = result.resourceSpans.find(r =>
      r.resource.attributes.some(a => a.value.stringValue === 'marveen-agent-agent-a')
    )
    expect(agentABlock?.scopeSpans[0].spans).toHaveLength(2)
  })

  it('sets service.name to marveen-agent-<agent_id>', () => {
    const result = spansToOtelJson([span({ agent_id: 'agent-a' })])
    const attrs = result.resourceSpans[0].resource.attributes
    const serviceName = attrs.find(a => a.key === 'service.name')
    expect(serviceName?.value.stringValue).toBe('marveen-agent-agent-a')
  })

  it('converts start_ms and end_ms to nanoseconds strings', () => {
    const result = spansToOtelJson([span({ start_ms: 1000, end_ms: 2000 })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.startTimeUnixNano).toBe('1000000000')
    expect(s.endTimeUnixNano).toBe('2000000000')
  })

  it('falls back end_ms to start_ms for running spans', () => {
    const result = spansToOtelJson([span({ start_ms: 1500, end_ms: null, status: 'running' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.startTimeUnixNano).toBe('1500000000')
    expect(s.endTimeUnixNano).toBe('1500000000')
  })

  it('sets status code 1 (OK) for ok spans', () => {
    const result = spansToOtelJson([span({ status: 'ok' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(1)
  })

  it('sets status code 2 (ERROR) for error spans', () => {
    const result = spansToOtelJson([span({ status: 'error' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2)
  })

  it('sets status code 2 (ERROR) for timeout spans', () => {
    const result = spansToOtelJson([span({ status: 'timeout' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2)
  })

  it('sets status code 0 (UNSET) for running spans', () => {
    const result = spansToOtelJson([span({ status: 'running' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(0)
  })

  it('omits parentSpanId when parent_span_id is null', () => {
    const result = spansToOtelJson([span({ parent_span_id: null })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s).not.toHaveProperty('parentSpanId')
  })

  it('includes parentSpanId when parent_span_id is set (normalised)', () => {
    const result = spansToOtelJson([span({ parent_span_id: 'parent-001' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.parentSpanId).toBe('parent001') // normaliseId strips hyphens
  })

  it('parses string attributes from JSON blob', () => {
    const result = spansToOtelJson([span({ attributes: JSON.stringify({ env: 'prod', count: 3 }) })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    const envAttr = s.attributes.find(a => a.key === 'env')
    expect(envAttr?.value.stringValue).toBe('prod')
    const countAttr = s.attributes.find(a => a.key === 'count')
    expect(countAttr?.value.intValue).toBe('3')
  })

  it('skips malformed attributes JSON without throwing', () => {
    const result = spansToOtelJson([span({ attributes: 'not-json{' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    // Should still have the built-in agent.id attribute
    expect(s.attributes.find(a => a.key === 'agent.id')).toBeDefined()
  })

  it('always includes agent.id and span.status built-in attributes', () => {
    const result = spansToOtelJson([span({ agent_id: 'agent-a', status: 'ok' })])
    const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find(a => a.key === 'agent.id')?.value.stringValue).toBe('agent-a')
    expect(attrs.find(a => a.key === 'span.status')?.value.stringValue).toBe('ok')
  })

  it('normalises hyphenated ids to lowercase hex', () => {
    const result = spansToOtelJson([span({ trace_id: 'TRACE-ABC', span_id: 'SPAN-DEF' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.traceId).toBe('traceabc')
    expect(s.spanId).toBe('spandef')
  })

  it('returns empty resourceSpans for empty input', () => {
    const result = spansToOtelJson([])
    expect(result.resourceSpans).toHaveLength(0)
  })

  it('sets scope name to marveen', () => {
    const result = spansToOtelJson([span()])
    expect(result.resourceSpans[0].scopeSpans[0].scope.name).toBe('marveen')
  })

  it('defaults service.namespace to marveen', () => {
    const result = spansToOtelJson([span()])
    const attrs = result.resourceSpans[0].resource.attributes
    expect(attrs.find(a => a.key === 'service.namespace')?.value.stringValue).toBe('marveen')
  })

  it('uses the given serviceNamespace override, leaving per-agent service.name unaffected', () => {
    const result = spansToOtelJson([span({ agent_id: 'agent-a' })], 'marveen-eu')
    const attrs = result.resourceSpans[0].resource.attributes
    expect(attrs.find(a => a.key === 'service.namespace')?.value.stringValue).toBe('marveen-eu')
    expect(attrs.find(a => a.key === 'service.name')?.value.stringValue).toBe('marveen-agent-agent-a')
  })
})

function tokenRow(overrides: Partial<TokenUsageMetricRow> = {}): TokenUsageMetricRow {
  return {
    agent: 'agent-a',
    model: 'claude-sonnet-5',
    tenant_id: 'default',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    thinking_tokens: 0,
    ...overrides,
  }
}

describe('tokenUsageToOtelMetricsJson', () => {
  it('returns empty resourceMetrics for empty input', () => {
    const result = tokenUsageToOtelMetricsJson([], 1000, 2000)
    expect(result.resourceMetrics).toHaveLength(0)
  })

  it('groups rows by agent into separate resourceMetrics blocks', () => {
    const rows = [
      tokenRow({ agent: 'agent-a', input_tokens: 10 }),
      tokenRow({ agent: 'agent-b', input_tokens: 20 }),
    ]
    const result = tokenUsageToOtelMetricsJson(rows, 1000, 2000)
    expect(result.resourceMetrics).toHaveLength(2)
  })

  it('emits one data point per nonzero token-type field', () => {
    const rows = [tokenRow({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 })]
    const result = tokenUsageToOtelMetricsJson(rows, 1000, 2000)
    const points = result.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints
    expect(points).toHaveLength(2)
    const types = points.map(p => p.attributes.find(a => a.key === 'gen_ai.token.type')?.value.stringValue)
    expect(types.sort()).toEqual(['input', 'output'])
  })

  it('skips zero-value token types entirely', () => {
    const rows = [tokenRow({ input_tokens: 0, output_tokens: 0 })]
    const result = tokenUsageToOtelMetricsJson(rows, 1000, 2000)
    expect(result.resourceMetrics).toHaveLength(0)
  })

  it('sets the metric name to gen_ai.client.token.usage', () => {
    const result = tokenUsageToOtelMetricsJson([tokenRow({ input_tokens: 1 })], 1000, 2000)
    expect(result.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe('gen_ai.client.token.usage')
  })

  it('carries model, agent, and tenant as data-point attributes', () => {
    const result = tokenUsageToOtelMetricsJson(
      [tokenRow({ agent: 'agent-a', model: 'claude-sonnet-5', tenant_id: 'acme', input_tokens: 1 })],
      1000, 2000,
    )
    const attrs = result.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes
    expect(attrs.find(a => a.key === 'gen_ai.request.model')?.value.stringValue).toBe('claude-sonnet-5')
    expect(attrs.find(a => a.key === 'marveen.agent.id')?.value.stringValue).toBe('agent-a')
    expect(attrs.find(a => a.key === 'marveen.tenant.id')?.value.stringValue).toBe('acme')
  })

  it('falls back model to "unknown" when null', () => {
    const result = tokenUsageToOtelMetricsJson([tokenRow({ model: null, input_tokens: 1 })], 1000, 2000)
    const attrs = result.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes
    expect(attrs.find(a => a.key === 'gen_ai.request.model')?.value.stringValue).toBe('unknown')
  })

  it('converts the window bounds (seconds) to nanosecond start/end timestamps', () => {
    const result = tokenUsageToOtelMetricsJson([tokenRow({ input_tokens: 1 })], 1000, 1030)
    const p = result.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
    expect(p.startTimeUnixNano).toBe('1000000000000')
    expect(p.timeUnixNano).toBe('1030000000000')
  })

  it('marks the sum as DELTA (2) and monotonic', () => {
    const result = tokenUsageToOtelMetricsJson([tokenRow({ input_tokens: 1 })], 1000, 2000)
    const sum = result.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
    expect(sum.aggregationTemporality).toBe(2)
    expect(sum.isMonotonic).toBe(true)
  })
})

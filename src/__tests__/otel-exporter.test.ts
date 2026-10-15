import { describe, it, expect } from 'vitest'
import { spansToOtelJson, tokenUsageToOtelMetricsJson, scrubInputSummary } from '../otel-exporter.js'
import type { OtelSpan, TokenUsageMetricRow, TokenHistogramRow } from '../db.js'

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

  it('includes parentSpanId when parent_span_id is set, hashed to a valid 16-hex spanId', () => {
    const result = spansToOtelJson([span({ parent_span_id: 'parent-001' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.parentSpanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('hashes a parent_span_id to the SAME value a span with that literal span_id would get (parent-child correlation survives hashing)', () => {
    const child = spansToOtelJson([span({ span_id: 'child-1', parent_span_id: 'parent-001' })])
    const parent = spansToOtelJson([span({ span_id: 'parent-001' })])
    const childSpan = child.resourceSpans[0].scopeSpans[0].spans[0]
    const parentSpan = parent.resourceSpans[0].scopeSpans[0].spans[0]
    expect(childSpan.parentSpanId).toBe(parentSpan.spanId)
  })

  it('parses allowlisted string and number attributes from the JSON blob', () => {
    const result = spansToOtelJson([span({ attributes: JSON.stringify({ model: 'model-x', input_tokens: 3 }) })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.attributes.find(a => a.key === 'model')?.value.stringValue).toBe('model-x')
    expect(s.attributes.find(a => a.key === 'input_tokens')?.value.intValue).toBe('3')
  })

  it('drops every attribute key that is not on the allowlist (content never leaves through a free-form span)', () => {
    const blob = JSON.stringify({
      tool_name: 'Bash', msg_id: 7, body: 'secret text', chat_id: '123', note: 'x', env: 'prod',
    })
    const keys = spansToOtelJson([span({ attributes: blob })]).resourceSpans[0].scopeSpans[0].spans[0]
      .attributes.map(a => a.key)
    expect(keys).toContain('tool_name')
    expect(keys).toContain('msg_id')
    for (const dropped of ['body', 'chat_id', 'note', 'env']) expect(keys).not.toContain(dropped)
  })

  it('does not export input_summary by default', () => {
    const blob = JSON.stringify({ tool_name: 'Bash', input_summary: 'curl https://u:pw@host/x' })
    const keys = spansToOtelJson([span({ attributes: blob })]).resourceSpans[0].scopeSpans[0].spans[0]
      .attributes.map(a => a.key)
    expect(keys).not.toContain('input_summary')
    expect(JSON.stringify(spansToOtelJson([span({ attributes: blob })]))).not.toContain('pw@')
  })

  it('exports a scrubbed, shortened input_summary only when asked to', () => {
    const blob = JSON.stringify({
      input_summary: 'curl https://user:pw@host/x ' + ['', 'Users', 'someone', 'proj', 'file.txt '].join('/') + 'y'.repeat(300),
    })
    const out = spansToOtelJson([span({ attributes: blob })], 'marveen', { includeInputSummary: true })
    const attr = out.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(a => a.key === 'input_summary')
    const value = attr?.value.stringValue ?? ''
    expect(value.length).toBeLessThanOrEqual(120)
    expect(value).toContain('https://***@host/x')
    expect(value).not.toContain('pw@')
    expect(value).not.toContain('someone')
  })

  it.each([
    ['curl -u admin:hunter2 https://host/x', 'hunter2'],
    ['curl --user admin:hunter2 https://host/x', 'hunter2'],
    ['curl --user=admin:hunter2 https://host/x', 'hunter2'],
    ['git clone https://deploy:hunter2@host/repo.git', 'hunter2'],
    ['psql admin:hunter2@dbhost/app', 'hunter2'],
    ['curl -H "Authorization: Bearer abcdef123456" https://host', 'abcdef123456'],
    ['curl -H "Authorization: Basic YWRtaW46aHVudGVy" https://host', 'YWRtaW46aHVudGVy'],
    ['export API_KEY=hunter2 && run', 'hunter2'],
    ['run --password hunter2', 'hunter2'],
    ['run token=hunter2', 'hunter2'],
  ])('input_summary scrub removes the credential in: %s', (input, secret) => {
    const blob = JSON.stringify({ input_summary: input })
    const out = spansToOtelJson([span({ attributes: blob })], 'marveen', { includeInputSummary: true })
    const value = out.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(a => a.key === 'input_summary')?.value.stringValue ?? ''
    expect(value).not.toContain(secret)
    expect(value.length).toBeGreaterThan(0)
  })

  it('input_summary scrub leaves an ordinary command readable', () => {
    expect(scrubInputSummary('git status --short && npm run build')).toBe('git status --short && npm run build')
    expect(scrubInputSummary('grep -rn "password policy" docs')).toContain('docs')
  })

  it('stamps marveen.tenant.id on the span and the resource, and splits one agent by tenant', () => {
    const out = spansToOtelJson([
      span({ span_id: 's1', tenant_id: 'tenant-x' }),
      span({ span_id: 's2', tenant_id: 'tenant-y' }),
      span({ span_id: 's3', tenant_id: null }),
    ])
    expect(out.resourceSpans).toHaveLength(3)
    const tenants = out.resourceSpans.map(r => ({
      resource: r.resource.attributes.find(a => a.key === 'marveen.tenant.id')?.value.stringValue,
      span: r.scopeSpans[0].spans[0].attributes.find(a => a.key === 'marveen.tenant.id')?.value.stringValue,
    }))
    expect(tenants).toEqual([
      { resource: 'tenant-x', span: 'tenant-x' },
      { resource: 'tenant-y', span: 'tenant-y' },
      { resource: 'unresolved', span: 'unresolved' },
    ])
  })

  it('sets service.instance.id on every resource, a stable value that names neither host nor path', () => {
    const a = spansToOtelJson([span()]).resourceSpans[0].resource.attributes.find(x => x.key === 'service.instance.id')
    const b = spansToOtelJson([span()]).resourceSpans[0].resource.attributes.find(x => x.key === 'service.instance.id')
    expect(a?.value.stringValue).toMatch(/^[0-9a-f]{12}$/)
    expect(a?.value.stringValue).toBe(b?.value.stringValue)
    const given = spansToOtelJson([span()], 'marveen', { serviceInstanceId: 'inst-1' })
    expect(given.resourceSpans[0].resource.attributes.find(x => x.key === 'service.instance.id')?.value.stringValue).toBe('inst-1')
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

  it('hashes non-hex ids (Claude-native ids, UUIDs) into OTLP-valid hex trace/span ids', () => {
    const result = spansToOtelJson([span({ trace_id: 'sess_abc123-not-hex', span_id: 'msg_01Xyz-not-hex-either' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/) // 16 bytes
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/) // 8 bytes
  })

  it('hashes the same id to the same hex value every time (stable correlation across export calls)', () => {
    const a = spansToOtelJson([span({ trace_id: 'sess-fixed', span_id: 'span-fixed' })])
    const b = spansToOtelJson([span({ trace_id: 'sess-fixed', span_id: 'span-fixed' })])
    const sa = a.resourceSpans[0].scopeSpans[0].spans[0]
    const sb = b.resourceSpans[0].scopeSpans[0].spans[0]
    expect(sa.traceId).toBe(sb.traceId)
    expect(sa.spanId).toBe(sb.spanId)
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

function histRow(overrides: Partial<TokenHistogramRow> = {}): TokenHistogramRow {
  return {
    agent: 'agent-a',
    model: 'claude-sonnet-5',
    tenant_id: 'default',
    token_type: 'input',
    bucket: 3,
    n: 1,
    total: 40,
    min_value: 40,
    max_value: 40,
    ...overrides,
  }
}

type Json = Record<string, any>
const attr = (point: Json, key: string) => point.attributes.find((a: Json) => a.key === key)?.value.stringValue
const metricOf = (out: Json, name: string, block = 0): Json | undefined =>
  out.resourceMetrics[block]?.scopeMetrics[0].metrics.find((m: Json) => m.name === name)

describe('tokenUsageToOtelMetricsJson resource', () => {
  it('carries service.instance.id', () => {
    const out = tokenUsageToOtelMetricsJson([histRow()], [tokenRow({ input_tokens: 40 })], 0, 60, 'marveen', { serviceInstanceId: 'inst-1' })
    expect(out.resourceMetrics[0].resource.attributes.find(a => a.key === 'service.instance.id')?.value.stringValue).toBe('inst-1')
  })
})

describe('tokenUsageToOtelMetricsJson: gen_ai.client.token.usage histogram', () => {
  it('returns no resourceMetrics for empty input', () => {
    expect(tokenUsageToOtelMetricsJson([], [], 1000, 2000).resourceMetrics).toHaveLength(0)
  })

  it('groups the rows of different agents into separate resourceMetrics blocks', () => {
    const out = tokenUsageToOtelMetricsJson(
      [histRow({ agent: 'agent-a' }), histRow({ agent: 'agent-b' })],
      [tokenRow({ agent: 'agent-a', input_tokens: 40 }), tokenRow({ agent: 'agent-b', input_tokens: 40 })],
      1000, 2000,
    )
    expect(out.resourceMetrics).toHaveLength(2)
  })

  it('is a DELTA histogram (temporality 1; 2 is CUMULATIVE) and not a sum', () => {
    const out = tokenUsageToOtelMetricsJson([histRow()], [], 1000, 2000)
    const metric = metricOf(out, 'gen_ai.client.token.usage')
    expect(metric?.histogram.aggregationTemporality).toBe(1)
    expect(metric?.sum).toBeUndefined()
    expect(metric?.unit).toBe('{token}')
  })

  it('folds the per-bucket rows of one series into count, sum, min, max and bucket counts', () => {
    const out = tokenUsageToOtelMetricsJson([
      histRow({ bucket: 0, n: 2, total: 2, min_value: 1, max_value: 1 }),
      histRow({ bucket: 3, n: 1, total: 40, min_value: 40, max_value: 40 }),
      histRow({ bucket: 14, n: 1, total: 70_000_000, min_value: 70_000_000, max_value: 70_000_000 }),
    ], [], 1000, 2000)
    const point = metricOf(out, 'gen_ai.client.token.usage')!.histogram.dataPoints[0]
    expect(point.count).toBe('4')
    expect(point.sum).toBe(70_000_042)
    expect(point.min).toBe(1)
    expect(point.max).toBe(70_000_000)
    expect(point.explicitBounds).toHaveLength(14)
    expect(point.bucketCounts).toHaveLength(15) // one more than the bounds: the open-ended last bucket
    expect(point.bucketCounts[0]).toBe('2')
    expect(point.bucketCounts[3]).toBe('1')
    expect(point.bucketCounts[14]).toBe('1')
    expect(point.bucketCounts.reduce((a: number, c: string) => a + Number(c), 0)).toBe(4) // = count
  })

  it('keeps input and output, different models and different tenants as separate series', () => {
    const out = tokenUsageToOtelMetricsJson([
      histRow({ token_type: 'input' }),
      histRow({ token_type: 'output' }),
      histRow({ model: 'claude-haiku-5' }),
      histRow({ tenant_id: 'tenant-b' }),
    ], [], 1000, 2000)
    expect(metricOf(out, 'gen_ai.client.token.usage')!.histogram.dataPoints).toHaveLength(4)
  })

  it('labels a series with the convention attributes, model, agent and tenant', () => {
    const out = tokenUsageToOtelMetricsJson([histRow({ tenant_id: 'tenant-b', token_type: 'output' })], [], 1000, 2000)
    const point = metricOf(out, 'gen_ai.client.token.usage')!.histogram.dataPoints[0]
    expect(attr(point, 'gen_ai.operation.name')).toBe('chat')
    expect(attr(point, 'gen_ai.provider.name')).toBe('anthropic')
    expect(attr(point, 'gen_ai.token.type')).toBe('output')
    expect(attr(point, 'gen_ai.request.model')).toBe('claude-sonnet-5')
    expect(attr(point, 'gen_ai.response.model')).toBe('claude-sonnet-5')
    expect(attr(point, 'marveen.agent.id')).toBe('agent-a')
    expect(attr(point, 'marveen.tenant.id')).toBe('tenant-b')
  })

  it('falls back the model to "unknown" when null', () => {
    const out = tokenUsageToOtelMetricsJson([histRow({ model: null })], [], 1000, 2000)
    expect(attr(metricOf(out, 'gen_ai.client.token.usage')!.histogram.dataPoints[0], 'gen_ai.request.model')).toBe('unknown')
  })

  it('converts the window bounds (seconds) to nanosecond start/end timestamps', () => {
    const out = tokenUsageToOtelMetricsJson([histRow()], [], 1000, 1030)
    const point = metricOf(out, 'gen_ai.client.token.usage')!.histogram.dataPoints[0]
    expect(point.startTimeUnixNano).toBe('1000000000000')
    expect(point.timeUnixNano).toBe('1030000000000')
  })

  it('never carries cache or thinking tokens, the conventions know only input and output', () => {
    const out = tokenUsageToOtelMetricsJson(
      [histRow()], [tokenRow({ input_tokens: 40, cache_read_tokens: 500, thinking_tokens: 9 })], 1000, 2000,
    )
    const types = metricOf(out, 'gen_ai.client.token.usage')!.histogram.dataPoints.map((p: Json) => attr(p, 'gen_ai.token.type'))
    expect(types).toEqual(['input'])
  })

  it('ignores a row with an out-of-range bucket or no observations instead of corrupting the series', () => {
    const out = tokenUsageToOtelMetricsJson(
      [histRow({ bucket: 15 }), histRow({ bucket: -1 }), histRow({ n: 0 })], [], 1000, 2000,
    )
    expect(out.resourceMetrics).toHaveLength(0)
  })
})

describe('tokenUsageToOtelMetricsJson: marveen.gen_ai.client.token.usage.other', () => {
  it('carries cache_read, cache_creation and thinking as a DELTA monotonic sum, nonzero values only', () => {
    const out = tokenUsageToOtelMetricsJson(
      [], [tokenRow({ input_tokens: 10, cache_read_tokens: 500, cache_creation_tokens: 0, thinking_tokens: 9 })], 1000, 2000,
    )
    const metric = metricOf(out, 'marveen.gen_ai.client.token.usage.other')!
    expect(metric.sum.aggregationTemporality).toBe(1)
    expect(metric.sum.isMonotonic).toBe(true)
    const byType = Object.fromEntries(metric.sum.dataPoints.map((p: Json) => [attr(p, 'marveen.token.type'), p.asInt]))
    expect(byType).toEqual({ cache_read: '500', thinking: '9' })
  })

  it('does not repeat input or output in it', () => {
    const out = tokenUsageToOtelMetricsJson([], [tokenRow({ input_tokens: 10, output_tokens: 5 })], 1000, 2000)
    expect(out.resourceMetrics).toHaveLength(0)
  })

  it('skips a window of zero token types entirely', () => {
    expect(tokenUsageToOtelMetricsJson([], [tokenRow()], 1000, 2000).resourceMetrics).toHaveLength(0)
  })
})

describe('spansToOtelJson: GenAI semantic conventions', () => {
  const exportOne = (s: OtelSpan, opts = {}) => spansToOtelJson([s], 'marveen', { serviceInstanceId: 'inst-1', ...opts }).resourceSpans[0].scopeSpans[0].spans[0] as Json
  const keys = (s: Json) => s.attributes.map((a: Json) => a.key)
  const val = (s: Json, key: string) => {
    const v = s.attributes.find((a: Json) => a.key === key)?.value
    return v?.stringValue ?? v?.intValue
  }

  const modelCall = (blob: object = {}, overrides: Partial<OtelSpan> = {}) => span({
    operation: 'model.call',
    attributes: JSON.stringify({
      model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 20, cache_read_tokens: 5000, cache_creation_tokens: 300, ...blob,
    }),
    ...overrides,
  })

  it('maps model.call to "chat <model>", CLIENT, with the gen_ai usage attributes and none of the old keys', () => {
    const s = exportOne(modelCall())
    expect(s.name).toBe('chat claude-sonnet-5')
    expect(s.kind).toBe(3)
    expect(val(s, 'gen_ai.operation.name')).toBe('chat')
    expect(val(s, 'gen_ai.provider.name')).toBe('anthropic')
    expect(val(s, 'gen_ai.request.model')).toBe('claude-sonnet-5')
    expect(val(s, 'gen_ai.response.model')).toBe('claude-sonnet-5')
    expect(val(s, 'gen_ai.usage.input_tokens')).toBe('100')
    expect(val(s, 'gen_ai.usage.output_tokens')).toBe('20')
    expect(val(s, 'gen_ai.usage.cache_read.input_tokens')).toBe('5000')
    expect(val(s, 'gen_ai.usage.cache_creation.input_tokens')).toBe('300')
    for (const old of ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      expect(keys(s)).not.toContain(old)
    }
  })

  it('names a model.call without a model just "chat"', () => {
    expect(exportOne(modelCall({ model: undefined })).name).toBe('chat')
    expect(exportOne(span({ operation: 'model.call', attributes: null })).name).toBe('chat')
  })

  it('keeps a model name that is long or multi-line out of the span name as one short line', () => {
    const s = exportOne(modelCall({ model: `m${'x'.repeat(100)}\nTELEGRAM_BOT_TOKEN=abc` }))
    expect(s.name).not.toMatch(/[\n\r]/)
    expect(s.name.length).toBeLessThanOrEqual('chat '.length + 64)
  })

  it('maps tool.<name> to "execute_tool <name>", INTERNAL, with gen_ai.tool.name and the MCP keys under marveen.*', () => {
    const s = exportOne(span({
      operation: 'tool.mcp__fleet__send',
      attributes: JSON.stringify({ tool_name: 'mcp__fleet__send', mcp_server: 'fleet', mcp_tool: 'send' }),
    }))
    expect(s.name).toBe('execute_tool mcp__fleet__send')
    expect(s.kind).toBe(1)
    expect(val(s, 'gen_ai.operation.name')).toBe('execute_tool')
    expect(val(s, 'gen_ai.tool.name')).toBe('mcp__fleet__send')
    expect(val(s, 'marveen.mcp.server')).toBe('fleet')
    expect(val(s, 'marveen.mcp.tool')).toBe('send')
    for (const old of ['tool_name', 'mcp_server', 'mcp_tool']) expect(keys(s)).not.toContain(old)
  })

  it('takes the tool name from the operation when the blob has none', () => {
    const s = exportOne(span({ operation: 'tool.Bash', attributes: null }))
    expect(s.name).toBe('execute_tool Bash')
    expect(val(s, 'gen_ai.operation.name')).toBe('execute_tool')
  })

  it('maps agent.turn to "invoke_agent <agent>", INTERNAL, with the agent id and name', () => {
    const s = exportOne(span({ operation: 'agent.turn', agent_id: 'agent-a', attributes: null }))
    expect(s.name).toBe('invoke_agent agent-a')
    expect(s.kind).toBe(1)
    expect(val(s, 'gen_ai.operation.name')).toBe('invoke_agent')
    expect(val(s, 'gen_ai.provider.name')).toBe('anthropic')
    expect(val(s, 'gen_ai.agent.id')).toBe('agent-a')
    expect(val(s, 'gen_ai.agent.name')).toBe('agent-a')
  })

  it('exports an inter-agent message as a PRODUCER with its name and msg_id/from/to untouched', () => {
    const s = exportOne(span({ operation: 'agent-a->agent-b', attributes: JSON.stringify({ msg_id: 7, from: 'agent-a', to: 'agent-b' }) }))
    expect(s.name).toBe('agent-a->agent-b')
    expect(s.kind).toBe(4)
    expect(val(s, 'msg_id')).toBe('7')
    expect(val(s, 'from')).toBe('agent-a')
    expect(val(s, 'to')).toBe('agent-b')
    expect(keys(s).filter((k: string) => k.startsWith('gen_ai.'))).toEqual([])
  })

  it('leaves any other span with its name, INTERNAL and no gen_ai attributes', () => {
    const s = exportOne(span({ operation: 'schedule.run', attributes: JSON.stringify({ schedule: 'nightly', schedule_type: 'command' }) }))
    expect(s.name).toBe('schedule.run')
    expect(s.kind).toBe(1)
    expect(val(s, 'schedule')).toBe('nightly')
    expect(keys(s).filter((k: string) => k.startsWith('gen_ai.'))).toEqual([])
  })

  it('still drops a blob key that is not allowlisted on a renamed span', () => {
    const s = exportOne(modelCall({ prompt: 'secret text', gen_ai: 'x' }))
    expect(keys(s)).not.toContain('prompt')
    expect(keys(s)).not.toContain('gen_ai')
    expect(JSON.stringify(s)).not.toContain('secret text')
  })

  it('does not let a blob key shadow a convention attribute', () => {
    const s = exportOne(modelCall({ 'gen_ai.operation.name': 'embeddings', 'gen_ai.provider.name': 'other' }))
    expect(s.attributes.filter((a: Json) => a.key === 'gen_ai.operation.name')).toHaveLength(1)
    expect(val(s, 'gen_ai.operation.name')).toBe('chat')
    expect(val(s, 'gen_ai.provider.name')).toBe('anthropic')
  })

  it('survives a blob that is not an object', () => {
    for (const raw of ['[1,2]', '"text"', 'null', '{broken']) {
      const s = exportOne(span({ operation: 'model.call', attributes: raw }))
      expect(s.name).toBe('chat')
    }
  })

  it('marks an error span with status ERROR, a status message and error.type _OTHER', () => {
    const s = exportOne(span({ status: 'error' }))
    expect(s.status).toEqual({ code: 2, message: '_OTHER' })
    expect(val(s, 'error.type')).toBe('_OTHER')
  })

  it('marks a timed-out span with error.type timeout', () => {
    const s = exportOne(span({ status: 'timeout' }))
    expect(s.status).toEqual({ code: 2, message: 'timeout' })
    expect(val(s, 'error.type')).toBe('timeout')
  })

  it('gives an ok or running span no error.type and no status message', () => {
    for (const [status, code] of [['ok', 1], ['running', 0]] as const) {
      const s = exportOne(span({ status }))
      expect(s.status).toEqual({ code })
      expect(keys(s)).not.toContain('error.type')
    }
  })
})

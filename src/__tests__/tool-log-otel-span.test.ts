// OTel F2 (#800/#803): POST /api/tool-log also writes a closed tool.call
// span to otel_spans, so PostToolUse hook data becomes exportable via the
// OTel F1 push exporter without a second hook round-trip. Real in-memory DB
// (not a db.js mock) so the route's actual upsertOtelSpan call is exercised.

import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getDb } from '../db.js'
import { tryHandleToolLog } from '../web/routes/tool-log.js'
import type { RouteContext } from '../web/routes/types.js'

beforeAll(() => {
  initDatabase(':memory:')
})

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

function getSpan(traceId: string, spanId: string) {
  return getDb().prepare('SELECT * FROM otel_spans WHERE trace_id = ? AND span_id = ?').get(traceId, spanId) as any
}

describe('POST /api/tool-log -- OTel span side effect', () => {
  it('writes a closed span keyed by session_id (trace) + tool_use_id (span)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-1',
      tool_name: 'Bash',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-1',
      duration_ms: 250,
    })
    const handled = await tryHandleToolLog(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)

    const span = getSpan('session-otel-1', 'tooluse-otel-1')
    expect(span).toBeDefined()
    expect(span.agent_id).toBe('agent-a')
    expect(span.operation).toBe('tool.Bash')
    expect(span.status).toBe('ok')
    expect(span.end_ms).not.toBeNull()
  })

  it('sets status=error when success is false', async () => {
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-2',
      tool_name: 'Bash',
      success: false,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-2',
    }).ctx)

    const span = getSpan('session-otel-2', 'tooluse-otel-2')
    expect(span.status).toBe('error')
  })

  it('derives start_ms from end_ms - duration_ms', async () => {
    const before = Date.now()
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-3',
      tool_name: 'Bash',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-3',
      duration_ms: 5000,
    }).ctx)
    const after = Date.now()

    const span = getSpan('session-otel-3', 'tooluse-otel-3')
    expect(span.end_ms - span.start_ms).toBe(5000)
    expect(span.end_ms).toBeGreaterThanOrEqual(before)
    expect(span.end_ms).toBeLessThanOrEqual(after)
  })

  it('records mcp_server attribute for an mcp__<server>__<tool> call', async () => {
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-4',
      tool_name: 'mcp__github__get_pull_request',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-4',
    }).ctx)

    const span = getSpan('session-otel-4', 'tooluse-otel-4')
    const attrs = JSON.parse(span.attributes)
    expect(attrs.tool_name).toBe('mcp__github__get_pull_request')
    expect(attrs.mcp_server).toBe('github')
    expect(attrs.mcp_tool).toBe('get_pull_request')
  })

  it('splits on the first __ so an underscored server name keeps its full name', async () => {
    // #800 F4: e.g. mcp__plugin_telegram_telegram__reply -- the server
    // segment itself contains underscores; only the tool segment after the
    // first "__" boundary should end up as mcp_tool.
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-4b',
      tool_name: 'mcp__plugin_telegram_telegram__reply',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-4b',
    }).ctx)

    const span = getSpan('session-otel-4b', 'tooluse-otel-4b')
    const attrs = JSON.parse(span.attributes)
    expect(attrs.mcp_server).toBe('plugin_telegram_telegram')
    expect(attrs.mcp_tool).toBe('reply')
  })

  it('records input_summary in attributes when provided', async () => {
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-4c',
      tool_name: 'Bash',
      input_summary: 'ls -la /tmp',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-4c',
    }).ctx)

    const span = getSpan('session-otel-4c', 'tooluse-otel-4c')
    const attrs = JSON.parse(span.attributes)
    expect(attrs.input_summary).toBe('ls -la /tmp')
  })

  it('omits input_summary from attributes when not provided', async () => {
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-4d',
      tool_name: 'Bash',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-4d',
    }).ctx)

    const span = getSpan('session-otel-4d', 'tooluse-otel-4d')
    const attrs = JSON.parse(span.attributes)
    expect(attrs.input_summary).toBeUndefined()
  })

  it('omits mcp_server and mcp_tool attributes for a non-MCP tool', async () => {
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-5',
      tool_name: 'Read',
      success: true,
      agent_id: 'agent-a',
      trace_id: 'tooluse-otel-5',
    }).ctx)

    const span = getSpan('session-otel-5', 'tooluse-otel-5')
    const attrs = JSON.parse(span.attributes)
    expect(attrs.mcp_server).toBeUndefined()
    expect(attrs.mcp_tool).toBeUndefined()
  })

  it('does not write a span when trace_id (tool_use_id) is missing', async () => {
    await tryHandleToolLog(makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-6',
      tool_name: 'Bash',
      success: true,
      agent_id: 'agent-a',
    }).ctx)

    const rows = getDb().prepare('SELECT * FROM otel_spans WHERE trace_id = ?').all('session-otel-6')
    expect(rows).toHaveLength(0)
  })

  it('does not write a span when agent_id is missing, but still returns 200 (tool_call_log retired)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/tool-log', {
      session_id: 'session-otel-7',
      tool_name: 'Bash',
      success: true,
      trace_id: 'tooluse-otel-7',
    })
    await tryHandleToolLog(ctx)
    expect(out.status).toBe(200)

    const rows = getDb().prepare('SELECT * FROM otel_spans WHERE trace_id = ?').all('session-otel-7')
    expect(rows).toHaveLength(0)
  })

  it('still returns 400 and writes nothing when session_id/tool_name are missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/tool-log', { session_id: 'session-otel-8' })
    await tryHandleToolLog(ctx)
    expect(out.status).toBe(400)
    const rows = getDb().prepare('SELECT * FROM otel_spans WHERE trace_id = ?').all('session-otel-8')
    expect(rows).toHaveLength(0)
  })
})

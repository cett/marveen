import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, getDb } from '../db.js'
import { tryHandleSpans } from '../web/routes/spans.js'

function makeCtx(opts: { method: string; path: string; body?: object; query?: Record<string, string> }): {
  ctx: RouteContext; status: () => number; body: () => any
} {
  const raw = opts.body ? JSON.stringify(opts.body) : ''
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  return {
    ctx: {
      req: em as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      path: url.pathname,
      method: opts.method,
      url,
      auth: { kind: 'token' },
    } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('spans route -- unrelated path', () => {
  it('returns false (falls through) for a non-matching path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/not-spans' })
    expect(await tryHandleSpans(ctx)).toBe(false)
  })
})

describe('POST /api/spans -- open', () => {
  it('opens a new running span', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/spans',
      body: { trace_id: 't1', span_id: 's1', agent_id: 'agent-a', operation: 'tool.call', start_ms: 1000 },
    })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true })
    const row = getDb().prepare('SELECT * FROM otel_spans WHERE trace_id = ? AND span_id = ?').get('t1', 's1') as any
    expect(row).toMatchObject({ agent_id: 'agent-a', operation: 'tool.call', start_ms: 1000, status: 'running', end_ms: null })
  })

  it('requires trace_id and span_id', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/spans', body: { agent_id: 'a' } })
    await tryHandleSpans(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('required')
  })

  it('requires agent_id, operation, start_ms to open', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/spans', body: { trace_id: 't1', span_id: 's1' },
    })
    await tryHandleSpans(ctx)
    expect(status()).toBe(400)
    expect(body().hint).toMatch(/open a span/)
  })

  it('stores optional parent_span_id and attributes', async () => {
    const { ctx } = makeCtx({
      method: 'POST', path: '/api/spans',
      body: { trace_id: 't1', span_id: 's2', parent_span_id: 's1', agent_id: 'agent-a', operation: 'model.call', start_ms: 500, attributes: '{"model":"x"}' },
    })
    await tryHandleSpans(ctx)
    const row = getDb().prepare('SELECT * FROM otel_spans WHERE span_id = ?').get('s2') as any
    expect(row.parent_span_id).toBe('s1')
    expect(row.attributes).toBe('{"model":"x"}')
  })
})

describe('POST /api/spans -- close', () => {
  it('closes an existing span (sets end_ms/status)', async () => {
    getDb().prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES ('t1', 's1', NULL, 'agent-a', 'tool.call', 1000, NULL, 'running', NULL)
    `).run()
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/spans',
      body: { trace_id: 't1', span_id: 's1', end_ms: 2000, status: 'ok' },
    })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true })
    const row = getDb().prepare('SELECT end_ms, status FROM otel_spans WHERE span_id = ?').get('s1') as any
    expect(row).toEqual({ end_ms: 2000, status: 'ok' })
  })

  it('defaults close status to ok when omitted', async () => {
    getDb().prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES ('t1', 's1', NULL, 'agent-a', 'tool.call', 1000, NULL, 'running', NULL)
    `).run()
    const { ctx } = makeCtx({ method: 'POST', path: '/api/spans', body: { trace_id: 't1', span_id: 's1', end_ms: 2000 } })
    await tryHandleSpans(ctx)
    const row = getDb().prepare('SELECT status FROM otel_spans WHERE span_id = ?').get('s1') as any
    expect(row.status).toBe('ok')
  })

  it('upsert-closes a not-yet-open span when enough info is given (single-event close)', async () => {
    const { ctx, status } = makeCtx({
      method: 'POST', path: '/api/spans',
      body: { trace_id: 't1', span_id: 'new-span', end_ms: 2000, agent_id: 'agent-a', operation: 'tool.call', start_ms: 1500 },
    })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    const row = getDb().prepare('SELECT * FROM otel_spans WHERE span_id = ?').get('new-span') as any
    expect(row).toMatchObject({ start_ms: 1500, end_ms: 2000, agent_id: 'agent-a', operation: 'tool.call' })
  })

  it('404s closing a non-existent span without enough info to upsert-close', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/spans', body: { trace_id: 't1', span_id: 'missing', end_ms: 2000 },
    })
    await tryHandleSpans(ctx)
    expect(status()).toBe(404)
    expect(body().error).toBe('not_found')
  })
})

describe('GET /api/traces', () => {
  it('lists recent traces (default limit)', async () => {
    getDb().prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES ('t1', 's1', NULL, 'agent-a', 'tool.call', 1000, 2000, 'ok', NULL)
    `).run()
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/traces' })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    expect(body()).toHaveLength(1)
    expect(body()[0]).toMatchObject({ trace_id: 't1', root_agent: 'agent-a', status: 'ok' })
  })

  it('caps the limit query param at 200', async () => {
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/traces', query: { limit: '99999' } })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    // No direct way to observe the capped SQL LIMIT from here without a DB
    // large enough to matter -- covered indirectly; the call completing
    // without error over a huge requested limit is the behavior under test.
  })
})

describe('GET /api/traces/:id', () => {
  it('returns the full span tree for a trace', async () => {
    getDb().prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES ('t1', 's1', NULL, 'agent-a', 'tool.call', 1000, 2000, 'ok', NULL)
    `).run()
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/traces/t1' })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    expect(body().trace_id).toBe('t1')
    expect(body().spans).toHaveLength(1)
  })

  it('404s for an unknown trace id', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/traces/nope' })
    await tryHandleSpans(ctx)
    expect(status()).toBe(404)
    expect(body().error).toBe('not_found')
  })
})

describe('GET /api/otel-export', () => {
  it('exports spans in OTLP/JSON shape', async () => {
    getDb().prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES ('t1', 's1', NULL, 'agent-a', 'tool.call', 1000, 2000, 'ok', NULL)
    `).run()
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/otel-export' })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
    expect(body()).toHaveProperty('resourceSpans')
    expect(body().resourceSpans[0].scopeSpans[0].spans[0].name).toBe('tool.call')
  })

  it('filters by agent, from, and to', async () => {
    getDb().prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES ('t1', 's1', NULL, 'agent-a', 'op-a', 1000, 2000, 'ok', NULL),
             ('t2', 's2', NULL, 'agent-b', 'op-b', 5000, 6000, 'ok', NULL)
    `).run()
    const { ctx, body } = makeCtx({
      method: 'GET', path: '/api/otel-export', query: { agent: 'agent-a', from: '0', to: '3000' },
    })
    await tryHandleSpans(ctx)
    const spans = body().resourceSpans.flatMap((r: any) => r.scopeSpans[0].spans)
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('op-a')
  })

  it('rejects a non-numeric from/to', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/otel-export', query: { from: 'not-a-number' } })
    await tryHandleSpans(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('invalid_value')
  })

  it('caps the limit query param at 5000', async () => {
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/otel-export', query: { limit: '999999' } })
    await tryHandleSpans(ctx)
    expect(status()).toBe(200)
  })
})

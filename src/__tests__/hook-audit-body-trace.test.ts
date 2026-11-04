// POST /api/hook-audit: the trace a hook script names for its row (K3 of the audit/OTel correlation plan).
//
// A hook writes the RAW Claude session id as trace_id (D1: the same string otel_spans.trace_id holds for that session),
// and the writer keeps the D2 rule: a `w3c-` value in an audit column is the server's own statement ("the trace of a
// traceparent that came with credentials"), so a value from a body that says it is dropped, never stored and never
// rewritten. What replaces it is the server's own trace (the request), or NULL outside any traced context.
//
// Privacy: neutral fixtures only (agent-a, sess-a).

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { dbx, insertHookAuditLog } from '../db.js'
import { callerTraceId, runAs, withTrace } from '../db/context.js'
import { tryHandleHookAudit } from '../web/routes/hook-audit.js'
import type { RouteContext } from '../web/routes/types.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const SERVER_TRACE = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
const SESSION = '0f3c1a52-7d2e-4b8a-9c11-5e6d7f8a9b0c'

interface TraceRow { trace_id: string | null; span_id: string | null; session_id: string | null }

async function lastRow(): Promise<TraceRow> {
  const row = await dbx.get<TraceRow>('SELECT trace_id, span_id, session_id FROM hook_audit_log ORDER BY id DESC LIMIT 1')
  if (!row) throw new Error('no hook_audit_log row was written')
  return row
}

/** One audit write as the route makes it, inside a request that carries the server's own trace. */
function writeInRequest(trace_id: unknown): Promise<void> {
  return runAs.system('job-a', () => withTrace(SERVER_TRACE, () => insertHookAuditLog({
    agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'deny', session_id: SESSION, trace_id: trace_id as string | null,
  })))
}

describe('callerTraceId', () => {
  it('keeps a session id, a UUID and a hex id', () => {
    expect(callerTraceId(SESSION)).toBe(SESSION)
    expect(callerTraceId('a'.repeat(32))).toBe('a'.repeat(32))
    expect(callerTraceId('sess-a_1.2:3')).toBe('sess-a_1.2:3')
  })

  it.each([
    ['w3c- prefix', 'w3c-' + 'a'.repeat(32)],
    ['W3C- prefix (any case)', 'W3C-' + 'a'.repeat(32)],
    ['mixed case prefix', 'w3C-abc'],
    ['bare prefix', 'w3c-'],
    ['empty', ''],
    ['oversized', 'x'.repeat(129)],
    ['a space', 'sess a'],
    ['a newline', 'sess\na'],
    ['a quote', "sess'a"],
    ['a NUL byte', 'sess\u0000a'],
    ['a non-ASCII letter', 'sess-é'],
  ])('drops %s', (_name, value) => {
    expect(callerTraceId(value)).toBeNull()
  })

  it.each([[undefined], [null], [42], [{}], [[]], [true]])('drops the non-string %j', (value) => {
    expect(callerTraceId(value)).toBeNull()
  })

  it('accepts exactly the length limit and refuses one more', () => {
    expect(callerTraceId('x'.repeat(128))).toBe('x'.repeat(128))
    expect(callerTraceId('x'.repeat(129))).toBeNull()
  })

  it('does not drop a value that merely contains w3c- later on', () => {
    expect(callerTraceId('sess-w3c-a')).toBe('sess-w3c-a')
  })
})

describe('insertHookAuditLog trace_id', () => {
  it('stores the session id the hook names, with no span, even inside a traced request', async () => {
    await writeInRequest(SESSION)
    expect(await lastRow()).toEqual({ trace_id: SESSION, span_id: null, session_id: SESSION })
  })

  it('stores the session id outside any traced context too', async () => {
    await insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'deny', trace_id: SESSION })
    expect(await lastRow()).toEqual({ trace_id: SESSION, span_id: null, session_id: null })
  })

  it('a w3c- value from the caller is NOT stored: the row carries the request trace instead', async () => {
    await writeInRequest('w3c-' + 'c'.repeat(32))
    expect(await lastRow()).toEqual({ trace_id: SERVER_TRACE.traceId, span_id: SERVER_TRACE.spanId, session_id: SESSION })
  })

  it('a w3c- value outside any traced context leaves the columns NULL', async () => {
    await insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'deny', trace_id: 'W3C-' + 'c'.repeat(32) })
    const row = await lastRow()
    expect(row.trace_id).toBeNull()
    expect(row.span_id).toBeNull()
  })

  it.each([[42], [{}], [''], ['x'.repeat(129)], ['sess a'], ['sess\na']])('an unusable value %j falls back to the request trace', async (value) => {
    await writeInRequest(value)
    expect(await lastRow()).toMatchObject({ trace_id: SERVER_TRACE.traceId, span_id: SERVER_TRACE.spanId })
  })

  it('without a trace_id the row keeps the request trace (K2 behaviour unchanged)', async () => {
    await runAs.system('job-a', () => withTrace(SERVER_TRACE, () => insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'allow' })))
    expect(await lastRow()).toMatchObject({ trace_id: SERVER_TRACE.traceId, span_id: SERVER_TRACE.spanId })
  })

  it('a session id is never turned into the stored trace on its own: no trace_id sent means no session trace', async () => {
    // Rick 14786: there is no session_id fallback. A caller that sends only session_id gets NULL outside a traced request.
    await insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'deny', session_id: SESSION })
    expect(await lastRow()).toEqual({ trace_id: null, span_id: null, session_id: SESSION })
  })
})

// ---- the route -------------------------------------------------------------------------------------------------

function postCtx(body: object): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', buf)
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL('http://localhost:3420/api/hook-audit')
  return { ctx: { req, res, path: url.pathname, method: 'POST', url, role: 'admin', tenantId: null } as unknown as RouteContext, out }
}

describe('POST /api/hook-audit trace_id', () => {
  const base = { agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'deny', session_id: SESSION }

  it('stores the session id a hook names as trace_id', async () => {
    const { ctx, out } = postCtx({ ...base, trace_id: SESSION })
    expect(await tryHandleHookAudit(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(await lastRow()).toMatchObject({ trace_id: SESSION, span_id: null })
  })

  it('drops a w3c- trace_id from the body: the request is still answered ok, the column is not the caller\'s', async () => {
    const { ctx, out } = postCtx({ ...base, trace_id: 'w3c-' + 'd'.repeat(32) })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(200)
    const row = await lastRow()
    expect(row.trace_id).toBeNull()
    expect(row.trace_id ?? '').not.toMatch(/^w3c-/i)
  })

  it('drops a w3c- trace_id inside a traced request: the request trace is stored', async () => {
    const { ctx } = postCtx({ ...base, trace_id: 'w3c-' + 'd'.repeat(32) })
    await runAs.system('job-a', () => withTrace(SERVER_TRACE, () => tryHandleHookAudit(ctx)))
    expect(await lastRow()).toMatchObject({ trace_id: SERVER_TRACE.traceId, span_id: SERVER_TRACE.spanId })
  })

  it('a body without trace_id gets no session trace (no session_id fallback)', async () => {
    const { ctx } = postCtx(base)
    await tryHandleHookAudit(ctx)
    expect(await lastRow()).toMatchObject({ trace_id: null, span_id: null, session_id: SESSION })
  })
})

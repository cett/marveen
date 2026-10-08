// Route-level tests for /api/agent-state/:agent/:key. Real in-memory SQLite,
// no mocks: the handler only depends on db.ts and the generic http helpers.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getAgentState } from '../db.js'
import { tryHandleAgentState } from '../web/routes/agent-state.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function makeCtx(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
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
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext,
    out,
  }
}

describe('/api/agent-state/:agent/:key', () => {
  it('returns 404 for a key that was never written', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agent-state/agent-a/blackboard_hygiene_nudges')
    expect(await tryHandleAgentState(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('round-trips a JSON object value', async () => {
    const put = makeCtx('PUT', '/api/agent-state/agent-a/blackboard_hygiene_nudges', { value: { 'agent-b': 1 } })
    await tryHandleAgentState(put.ctx)
    expect(put.out.body).toEqual({ ok: true })

    const get = makeCtx('GET', '/api/agent-state/agent-a/blackboard_hygiene_nudges')
    await tryHandleAgentState(get.ctx)
    expect(get.out.status).toBe(200)
    expect(get.out.body).toMatchObject({ agent_id: 'agent-a', state_key: 'blackboard_hygiene_nudges', value: { 'agent-b': 1 } })
  })

  it('stores a bare number the way the old SQL recipe did, and overwrites on the second write', async () => {
    await tryHandleAgentState(makeCtx('PUT', '/api/agent-state/agent-a/kanban_audit_last_audit_at', { value: 1800000000 }).ctx)
    await tryHandleAgentState(makeCtx('PUT', '/api/agent-state/agent-a/kanban_audit_last_audit_at', { value: 1800000600 }).ctx)
    // Same text a plain SQL "state_value = '1800000600'" would have left, so the
    // shell pre-check's CAST(state_value AS INTEGER) semantics are unchanged.
    expect(getAgentState('agent-a', 'kanban_audit_last_audit_at')?.state_value).toBe('1800000600')
    const get = makeCtx('GET', '/api/agent-state/agent-a/kanban_audit_last_audit_at')
    await tryHandleAgentState(get.ctx)
    expect((get.out.body as { value: number }).value).toBe(1800000600)
  })

  it('rejects a key outside the closed set', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/agent-state/agent-a/anything_else', { value: 1 })
    await tryHandleAgentState(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'state_key' })
    expect(getAgentState('agent-a', 'anything_else' as never)).toBeUndefined()
  })

  it('rejects an agent id that is not a plain name', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agent-state/..%2Fetc/blackboard_hygiene_nudges')
    await tryHandleAgentState(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ field: 'agent_id' })
  })

  it('rejects a missing or null value and malformed JSON', async () => {
    const empty = makeCtx('PUT', '/api/agent-state/agent-a/gate_run_state', {})
    await tryHandleAgentState(empty.ctx)
    expect(empty.out.status).toBe(400)
    const nul = makeCtx('PUT', '/api/agent-state/agent-a/gate_run_state', { value: null })
    await tryHandleAgentState(nul.ctx)
    expect(nul.out.status).toBe(400)
    const bad = makeCtx('PUT', '/api/agent-state/agent-a/gate_run_state', '{nope')
    await tryHandleAgentState(bad.ctx)
    expect(bad.out.status).toBe(400)
    expect(getAgentState('agent-a', 'gate_run_state')).toBeUndefined()
  })

  it('does not handle other paths or methods', async () => {
    expect(await tryHandleAgentState(makeCtx('GET', '/api/agent-state').ctx)).toBe(false)
    expect(await tryHandleAgentState(makeCtx('DELETE', '/api/agent-state/agent-a/gate_run_state').ctx)).toBe(false)
  })
})

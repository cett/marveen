// Route-level tests for /api/hook-audit -- POST (hook scripts write a
// verdict), GET (dashboard query), POST /prune. No mocking needed: the
// handler's only dependencies are db.ts (real in-memory SQLite) and the
// generic http-helpers, so this exercises the real storage layer end to end.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, listHookAuditLog } from '../db.js'
import { tryHandleHookAudit } from '../web/routes/hook-audit.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function makeCtx(
  method: string,
  path: string,
  body?: object,
  query?: Record<string, string>,
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
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
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const url = new URL(`http://localhost:3420${path}${qs}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext,
    out,
  }
}

describe('POST /api/hook-audit', () => {
  it('records a deny verdict and returns ok', async () => {
    const { ctx, out } = makeCtx('POST', '/api/hook-audit', {
      agent_id: 'agent-a',
      hook_type: 'PostToolUse',
      verdict: 'deny',
      tool_name: 'mcp__example__fetch',
      content_hash: 'abc123',
      reason: 'injection_pattern_ignore_instructions',
      session_id: 'sess-1',
    })
    const handled = await tryHandleHookAudit(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })

    const rows = listHookAuditLog()
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('injection_pattern_ignore_instructions')
  })

  it('rejects a missing hook_type with 400', async () => {
    const { ctx, out } = makeCtx('POST', '/api/hook-audit', { verdict: 'deny' })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('invalid_value')
  })

  it('rejects an invalid hook_type with 400', async () => {
    const { ctx, out } = makeCtx('POST', '/api/hook-audit', { hook_type: 'NotAHook', verdict: 'deny' })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects a missing verdict with 400', async () => {
    const { ctx, out } = makeCtx('POST', '/api/hook-audit', { hook_type: 'PostToolUse' })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects an invalid verdict with 400', async () => {
    const { ctx, out } = makeCtx('POST', '/api/hook-audit', { hook_type: 'PostToolUse', verdict: 'maybe' })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(400)
  })
})

describe('GET /api/hook-audit', () => {
  async function seed() {
    await tryHandleHookAudit(makeCtx('POST', '/api/hook-audit', {
      hook_type: 'PostToolUse', verdict: 'deny', agent_id: 'agent-a', reason: 'r1',
    }).ctx)
    await tryHandleHookAudit(makeCtx('POST', '/api/hook-audit', {
      hook_type: 'PostToolUse', verdict: 'deny', agent_id: 'agent-b', reason: 'r2',
    }).ctx)
  }

  it('returns all entries within the window', async () => {
    await seed()
    const { ctx, out } = makeCtx('GET', '/api/hook-audit')
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { total: number }).total).toBe(2)
  })

  it('filters by verdict', async () => {
    await seed()
    const { ctx, out } = makeCtx('GET', '/api/hook-audit', undefined, { verdict: 'deny' })
    await tryHandleHookAudit(ctx)
    expect((out.body as { total: number }).total).toBe(2)
  })

  it('rejects an invalid verdict filter with 400', async () => {
    const { ctx, out } = makeCtx('GET', '/api/hook-audit', undefined, { verdict: 'bogus' })
    await tryHandleHookAudit(ctx)
    expect(out.status).toBe(400)
  })

  it('filters by agent', async () => {
    await seed()
    const { ctx, out } = makeCtx('GET', '/api/hook-audit', undefined, { agent: 'agent-a' })
    await tryHandleHookAudit(ctx)
    const entries = (out.body as { entries: Array<{ agent_id: string }> }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0].agent_id).toBe('agent-a')
  })
})

describe('POST /api/hook-audit/prune', () => {
  it('accepts an empty body and returns ok', async () => {
    const { ctx, out } = makeCtx('POST', '/api/hook-audit/prune', {})
    const handled = await tryHandleHookAudit(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
  })

  it('prunes entries older than older_than_secs', async () => {
    await tryHandleHookAudit(makeCtx('POST', '/api/hook-audit', {
      hook_type: 'PostToolUse', verdict: 'deny', reason: 'will-be-pruned',
    }).ctx)

    // Negative older_than_secs pushes the cutoff into the future, so the
    // just-inserted row is guaranteed to be older than it regardless of
    // second-boundary timing -- avoids a same-second race with `ts >= cutoff`.
    await tryHandleHookAudit(makeCtx('POST', '/api/hook-audit/prune', { older_than_secs: -10 }).ctx)

    const rows = listHookAuditLog()
    expect(rows).toHaveLength(0)
  })
})

describe('unrelated paths', () => {
  it('returns false and does not handle', async () => {
    const { ctx } = makeCtx('GET', '/api/something-else')
    const handled = await tryHandleHookAudit(ctx)
    expect(handled).toBe(false)
  })
})

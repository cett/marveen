// Tenant-IDOR guard tests for src/web/routes/ideas.ts (migration 0049 adds
// idea_box.tenant_id). Separate from
// ideas-routes.test.ts, whose makeCtx defaults to role: 'admin' throughout
// and predates tenant scoping -- this file exercises the non-admin path.
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase } from '../db.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function makeCtx(
  method: string,
  path: string,
  body: object | undefined,
  authCtx: { role?: RouteContext['role']; tenantId?: string | null },
): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: authCtx.role, tenantId: authCtx.tenantId } as RouteContext, out }
}

async function createIdea(tenantId: string, title: string): Promise<string> {
  const { ctx, out } = makeCtx('POST', '/api/ideas', { title }, { role: 'agent', tenantId })
  await tryHandleIdeas(ctx)
  return out.body.id
}

describe('tryHandleIdeas: tenant-IDOR guard', () => {
  it('POST stamps the caller\'s own tenant_id on the created idea', async () => {
    const id = await createIdea('tenant-a', 'idea from tenant a')
    const { ctx, out } = makeCtx('GET', '/api/ideas', undefined, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(ctx)
    expect(out.body.find((i: any) => i.id === id)).toBeTruthy()
  })

  it('GET /api/ideas excludes another tenant\'s ideas for a non-admin caller', async () => {
    await createIdea('tenant-a', 'idea A')
    await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('GET', '/api/ideas', undefined, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(ctx)
    expect(out.body).toHaveLength(1)
    expect(out.body[0].title).toBe('idea A')
  })

  it('GET /api/ideas with no ?tenant= returns every tenant for admin', async () => {
    await createIdea('tenant-a', 'idea A')
    await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('GET', '/api/ideas', undefined, { role: 'admin' })
    await tryHandleIdeas(ctx)
    expect(out.body).toHaveLength(2)
  })

  it('GET /api/ideas?tenant= narrows admin to one tenant', async () => {
    await createIdea('tenant-a', 'idea A')
    await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('GET', '/api/ideas?tenant=tenant-b', undefined, { role: 'admin' })
    await tryHandleIdeas(ctx)
    expect(out.body).toHaveLength(1)
    expect(out.body[0].title).toBe('idea B')
  })

  it('PUT on another tenant\'s idea 404s (not 403) for a non-admin caller', async () => {
    const id = await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('PUT', `/api/ideas/${id}`, { title: 'hijacked' }, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('DELETE on another tenant\'s idea 404s for a non-admin caller', async () => {
    const id = await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('DELETE', `/api/ideas/${id}`, undefined, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('idea comments GET/POST 404 on another tenant\'s idea for a non-admin caller', async () => {
    const id = await createIdea('tenant-b', 'idea B')
    const { ctx: getCtx, out: getOut } = makeCtx('GET', `/api/ideas/${id}/comments`, undefined, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(getCtx)
    expect(getOut.status).toBe(404)

    const { ctx: postCtx, out: postOut } = makeCtx('POST', `/api/ideas/${id}/comments`, { content: 'nope' }, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(postCtx)
    expect(postOut.status).toBe(404)
  })

  it('admin bypasses the tenant guard on PUT/DELETE regardless of ?tenant=', async () => {
    const id = await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('PUT', `/api/ideas/${id}`, { title: 'admin edit' }, { role: 'admin' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
  })
})

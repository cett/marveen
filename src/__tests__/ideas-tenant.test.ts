// Tenant-IDOR guard tests for src/web/routes/ideas.ts (migration 0049 adds
// idea_box.tenant_id). Separate from
// ideas-routes.test.ts, whose makeCtx defaults to role: 'admin' throughout
// and predates tenant scoping -- this file exercises the non-admin path.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import * as dbMod from '../db.js'
import { initDatabase } from '../db.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'

vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn(() => Promise.resolve({ subtasks: [] })) }))

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
    expect(out.body.ideas.find((i: any) => i.id === id)).toBeTruthy()
  })

  it('GET /api/ideas excludes another tenant\'s ideas for a non-admin caller', async () => {
    await createIdea('tenant-a', 'idea A')
    await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('GET', '/api/ideas', undefined, { role: 'agent', tenantId: 'tenant-a' })
    await tryHandleIdeas(ctx)
    expect(out.body.ideas).toHaveLength(1)
    expect(out.body.ideas[0].title).toBe('idea A')
  })

  it('GET /api/ideas with no ?tenant= returns every tenant for admin', async () => {
    await createIdea('tenant-a', 'idea A')
    await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('GET', '/api/ideas', undefined, { role: 'admin' })
    await tryHandleIdeas(ctx)
    expect(out.body.ideas).toHaveLength(2)
  })

  it('GET /api/ideas?tenant= narrows admin to one tenant', async () => {
    await createIdea('tenant-a', 'idea A')
    await createIdea('tenant-b', 'idea B')
    const { ctx, out } = makeCtx('GET', '/api/ideas?tenant=tenant-b', undefined, { role: 'admin' })
    await tryHandleIdeas(ctx)
    expect(out.body.ideas).toHaveLength(1)
    expect(out.body.ideas[0].title).toBe('idea B')
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

// The ownership check of each route reads the idea first (`await getIdeaById`). A check that lost its `await` reads a
// Promise: it is never "missing", and its tenant_id is undefined. These tests pin both directions: the owner is let in
// (the broken check would 404 its own tenant) and a missing idea is a 404 for the admin as well (the broken check
// lets the admin through to a 200 with an empty list).
describe('tryHandleIdeas: ownership check reads the idea (await-dependent guard)', () => {
  const ownRoutes: Array<[string, string, (id: string) => string, object | undefined]> = [
    ['DELETE', 'DELETE idea', (id) => `/api/ideas/${id}`, undefined],
    ['GET', 'GET comments', (id) => `/api/ideas/${id}/comments`, undefined],
    ['POST', 'POST comment', (id) => `/api/ideas/${id}/comments`, { content: 'a comment' }],
    ['GET', 'GET status-log', (id) => `/api/ideas/${id}/status-log`, undefined],
  ]

  for (const [method, label, pathOf, body] of ownRoutes) {
    it(`${label}: the owning tenant is let in`, async () => {
      const id = await createIdea('tenant-a', 'own idea')
      const { ctx, out } = makeCtx(method, pathOf(id), body, { role: 'agent', tenantId: 'tenant-a' })
      await tryHandleIdeas(ctx)
      expect(out.status).toBe(200)
    })

    it(`${label}: another tenant gets 404`, async () => {
      const id = await createIdea('tenant-b', 'foreign idea')
      const { ctx, out } = makeCtx(method, pathOf(id), body, { role: 'agent', tenantId: 'tenant-a' })
      await tryHandleIdeas(ctx)
      expect(out.status).toBe(404)
    })

    it(`${label}: an unknown id is 404 for the admin too`, async () => {
      const { ctx, out } = makeCtx(method, pathOf('does-not-exist'), body, { role: 'admin' })
      await tryHandleIdeas(ctx)
      expect(out.status).toBe(404)
    })
  }
})

// The other five idea routes read the idea the same way (PUT, promote, breakdown, promote-breakdown, revert); the same
// three cases per route, so the CHANGELOG claim "on every route" holds.
describe('tryHandleIdeas: ownership check of PUT, promote, breakdown, promote-breakdown and revert', () => {
  const routes: Array<[string, string, (id: string) => string, object | undefined]> = [
    ['PUT', 'PUT idea', (id) => `/api/ideas/${id}`, { title: 'renamed' }],
    ['POST', 'POST promote', (id) => `/api/ideas/${id}/promote`, { phase: 'detail' }],
    ['POST', 'POST breakdown', (id) => `/api/ideas/${id}/breakdown`, {}],
    ['POST', 'POST promote-breakdown', (id) => `/api/ideas/${id}/promote-breakdown`, { subtasks: [{ title: 's' }] }],
    ['POST', 'POST revert', (id) => `/api/ideas/${id}/revert`, {}],
  ]
  for (const [method, label, pathOf, body] of routes) {
    it(`${label}: the owning tenant is not turned away with a 404`, async () => {
      const id = await createIdea('tenant-a', 'own idea')
      const { ctx, out } = makeCtx(method, pathOf(id), body, { role: 'agent', tenantId: 'tenant-a' })
      await tryHandleIdeas(ctx)
      expect(out.status).not.toBe(404)
    })
    it(`${label}: another tenant gets 404`, async () => {
      const id = await createIdea('tenant-b', 'foreign idea')
      const { ctx, out } = makeCtx(method, pathOf(id), body, { role: 'agent', tenantId: 'tenant-a' })
      await tryHandleIdeas(ctx)
      expect(out.status).toBe(404)
    })
    it(`${label}: an unknown id is 404 for the admin too`, async () => {
      const { ctx, out } = makeCtx(method, pathOf('does-not-exist'), body, { role: 'admin' })
      await tryHandleIdeas(ctx)
      expect(out.status).toBe(404)
    })
  }
})

// Every caller of updateIdeaWithStatusLog awaits it. A call that lost its `await` answers `ok: true` while the write is
// still running (or has failed), so a rejected write must reach the handler's caller, and when the handler resolves
// the idea row and exactly one status-log row are already written. The PUT case also fails if the PUT stops logging.
describe('updateIdeaWithStatusLog is awaited by every caller', () => {
  type Route = [string, string, (id: string) => string, object | undefined, string]
  const routes: Route[] = [
    ['PUT', 'PUT status change', (id) => `/api/ideas/${id}`, { status: 'reviewed' }, 'new'],
    ['POST', 'promote', (id) => `/api/ideas/${id}/promote`, { phase: 'detail' }, 'new'],
    ['POST', 'promote-breakdown', (id) => `/api/ideas/${id}/promote-breakdown`, { subtasks: [{ title: 's' }] }, 'new'],
    ['POST', 'revert', (id) => `/api/ideas/${id}/revert`, {}, 'kanban'],
  ]
  for (const [method, label, pathOf, body, startStatus] of routes) {
    it(`${label}: a rejected idea+log write is not answered ok`, async () => {
      const id = await createIdea('tenant-a', 'idea')
      if (startStatus !== 'new') await dbMod.updateIdea(id, { status: startStatus as 'kanban' })
      vi.mocked(dbMod.updateIdeaWithStatusLog).mockRejectedValueOnce(new Error('db down'))
      const { ctx, out } = makeCtx(method, pathOf(id), body, { role: 'agent', tenantId: 'tenant-a' })

      await expect(tryHandleIdeas(ctx)).rejects.toThrow('db down')

      expect(JSON.stringify(out)).not.toContain('"ok":true')
    })

    it(`${label}: the idea row and exactly one status-log row are written when the handler resolves`, async () => {
      const id = await createIdea('tenant-a', 'idea')
      if (startStatus !== 'new') await dbMod.updateIdea(id, { status: startStatus as 'kanban' })
      const before = (await dbMod.getIdeaStatusLog(id)).length
      const { ctx, out } = makeCtx(method, pathOf(id), body, { role: 'agent', tenantId: 'tenant-a' })

      await tryHandleIdeas(ctx)

      expect(out.status).toBe(200)
      expect((await dbMod.getIdeaStatusLog(id)).length).toBe(before + 1)
      expect((await dbMod.getIdeaById(id))?.status).toBe(label === 'revert' ? 'reviewed' : label === 'PUT status change' ? 'reviewed' : 'kanban')
    })
  }
})

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, updateIdeaWithStatusLog: vi.fn(actual.updateIdeaWithStatusLog) }
})

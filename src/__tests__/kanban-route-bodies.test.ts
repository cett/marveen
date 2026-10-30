// The kanban routes that answer with the result of one converted db call (`json(res, await f())`): the body carries
// the rows themselves. A call that lost its `await` would serialize the Promise as `{}`, which no type check, lint
// rule or status assertion catches (W3-3 per-await sweep: these six survived every existing test). Real in-memory
// database, the real route, admin token (same harness as kanban-dispatch-guard-clear.test.ts).

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import {
  initDatabase, createKanbanCard, createLabel, addLabelToCard, addKanbanComment, moveKanbanCard,
} from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const authReq = { headers: { authorization: 'Bearer the-file-token' } } as unknown as http.IncomingMessage
  const auth = await resolveAuth(authReq, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: any } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not JSON */ }
    },
  } as unknown as http.ServerResponse
  const url = new URL(`http://localhost:3420${path}`)
  const decision = checkPermission(auth, method, url.pathname)
  if (!decision.allowed) { out.status = decision.status; return out }
  const ctx = {
    req, res, path: url.pathname, method, url, role: resolveRole(auth), tenantId: resolveTenantId(auth),
  } as unknown as RouteContext
  await tryHandleKanban(ctx)
  return out
}

beforeEach(async () => {
  initDatabase(':memory:')
  await createKanbanCard({ id: 'parent', title: 'Parent' })
  await createKanbanCard({ id: 'child', title: 'Child', parent_id: 'parent' })
})

describe('the body of a read route is the rows, not a serialized Promise', () => {
  it('GET /api/kanban/:id/labels', async () => {
    const label = await createLabel({ id: 'l1', name: 'Urgent', color: '#f00' })
    await addLabelToCard('parent', label.id)
    const res = await call('GET', '/api/kanban/parent/labels')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ id: 'l1', name: 'Urgent' })
  })

  it('GET /api/kanban/:id/comments', async () => {
    await addKanbanComment('parent', 'bot', 'first note')
    const res = await call('GET', '/api/kanban/parent/comments')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toMatchObject({ card_id: 'parent', author: 'bot', content: 'first note' })
  })

  it('GET /api/kanban/:id/events', async () => {
    await moveKanbanCard('parent', 'in_progress', 0, 'owner')
    const res = await call('GET', '/api/kanban/parent/events')
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    expect(res.body[0]).toMatchObject({ card_id: 'parent', to_status: 'in_progress', actor: 'owner' })
  })

  it('GET /api/kanban/:id/children', async () => {
    const res = await call('GET', '/api/kanban/parent/children')
    expect(res.status).toBe(200)
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(['child'])
  })

  it('GET /api/kanban/:id/subtree', async () => {
    const res = await call('GET', '/api/kanban/parent/subtree')
    expect(res.status).toBe(200)
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(['parent', 'child'])
  })
})

describe('the body of a comment write is the stored comment', () => {
  it('POST /api/kanban/:id/comments', async () => {
    const res = await call('POST', '/api/kanban/parent/comments', { author: 'bot', content: 'a new note' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ card_id: 'parent', author: 'bot', content: 'a new note' })
    expect(typeof res.body.id).toBe('number')
  })
})

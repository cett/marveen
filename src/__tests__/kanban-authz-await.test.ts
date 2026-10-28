// Await-dependent gates of the kanban routes (tenant line and existence): each request below is refused by one gate only.
// Real in-memory database, the gate chain of web.ts in miniature (harness as in kanban-parent-tenant.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import {
  initDatabase, getDb, createTenant, insertApiToken, createKanbanCard, createLabel,
} from '../db.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext, RouteHandler } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['alpha', 'beta'],
  isKnownAgent: (n: string) => ['alpha', 'beta', 'main-agent'].includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)
const HANDLERS: RouteHandler[] = [tryHandleKanban, tryHandleMemories, tryHandleMessages]

// The gate of web.ts in miniature, from an already resolved principal.
async function callAs(auth: AuthResult, method: string, path: string, body?: unknown) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
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
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId: resolveTenantId(auth), tokenAgentId,
    agentId: role === 'fleet_agent' && tokenAgentId ? tokenAgentId : undefined,
    auth: auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName }
      : auth.kind === 'session' ? { kind: 'session', user: auth.user } : undefined,
  } as unknown as RouteContext
  for (const h of HANDLERS) if (await h(ctx)) return out
  out.status = 404
  return out
}

async function tokenAuth(raw: string): Promise<AuthResult> {
  const req = { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
  return resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
}
const session = (role: 'admin' | 'agent' | 'read_only' | 'viewer', tenantId: string | null): AuthResult => ({ kind: 'session', user: `u-${role}`, role, tenantId })


// W3-3 QA fix: the tenant and existence gates of the kanban routes decide on an awaited lookup. A gate whose
// `await` is lost reads a Promise (always truthy), so `!lookup` is false and the request goes on. Each test below
// is a request that ONLY that gate refuses, and checks that the row stays as it was.
const cardRow = (id: string) => getDb().prepare('SELECT parent_id, tenant_id, title FROM kanban_cards WHERE id = ?').get(id) as { parent_id: string | null; tenant_id: string; title: string } | undefined

beforeEach(async () => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  await insertApiToken({ tokenHash: sha('tok-alpha'), name: 'fleet:alpha', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'alpha' })
  await createKanbanCard({ id: 'own-card', title: 'Own card', tenant_id: 'default' })
  await createKanbanCard({ id: 'own-parent', title: 'Own parent', tenant_id: 'default' })
  await createKanbanCard({ id: 'foreign-parent', title: 'Foreign parent', tenant_id: 'acme' })
  await createKanbanCard({ id: 'foreign-child', title: 'Foreign child', tenant_id: 'acme', parent_id: 'foreign-parent' })
})

describe('the existence and tenant gates of the kanban routes hold on their awaited lookup', () => {
  // The general card-id gate of the router covers a non-admin caller before these handlers run, so the 404 gate of
  // the handler itself is reached by an admin only.
  it('POST /api/kanban/:id/labels answers 404 for a card that does not exist (admin)', async () => {
    // A label that exists, so that the missing label cannot be what answers 404.
    await createLabel({ id: 'lbl-1', name: 'l', color: '#112233', tenant_id: 'default' })
    const r = await callAs(session('admin', null), 'POST', '/api/kanban/no-such-card/labels', { labelId: 'lbl-1' })
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: 'not_found', hint: 'Kártya nem található' })
  })

  it('GET /api/kanban/:id/subtree answers 404 for a card that does not exist (admin)', async () => {
    const r = await callAs(session('admin', null), 'GET', '/api/kanban/no-such-card/subtree')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: 'not_found' })
  })

  it('PUT /api/kanban/:id refuses a parent_id of another tenant (404 field parent_id) and changes nothing', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), 'PUT', '/api/kanban/own-card', { parent_id: 'foreign-parent', title: 'hijacked' })
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: 'not_found', field: 'parent_id' })
    expect(cardRow('own-card')).toMatchObject({ parent_id: null, title: 'Own card' })
  })

  it('PUT /api/kanban/:id refuses a parent_id that does not exist', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), 'PUT', '/api/kanban/own-card', { parent_id: 'no-such-parent' })
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ field: 'parent_id' })
    expect(cardRow('own-card')?.parent_id).toBeNull()
  })

  it('PATCH /api/kanban/:id/parent cannot detach a card of another tenant (parent_id null) and leaves it under its parent', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), 'PATCH', '/api/kanban/foreign-child/parent', { parent_id: null })
    expect(r.status).toBe(404)
    expect(cardRow('foreign-child')?.parent_id).toBe('foreign-parent')
  })

  it('PATCH /api/kanban/:id/parent cannot attach a card of another tenant under a parent of the caller', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), 'PATCH', '/api/kanban/foreign-child/parent', { parent_id: 'own-parent' })
    expect(r.status).toBe(404)
    expect(cardRow('foreign-child')?.parent_id).toBe('foreign-parent')
  })

  it('POST /api/kanban/:id/breakdown/accept refuses a card of another tenant and creates nothing under it', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n
    const r = await callAs(await tokenAuth('tok-alpha'), 'POST', '/api/kanban/foreign-parent/breakdown/accept', { subtasks: [{ title: 's', description: 'd', assignee: null, priority: 'normal' }] })
    expect(r.status).toBe(404)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n).toBe(before)
  })
})

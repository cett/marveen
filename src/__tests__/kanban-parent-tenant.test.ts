// The kanban routes that take a card id (and a parent id) must hold the tenant line for a non-admin caller:
// PATCH /api/kanban/:id/parent (the card and the new parent) and POST /api/kanban/:id/breakdown/accept (the
// card the subtasks hang under). A foreign id answers 404 and the row stays as it was. Real in-memory
// database, the gate chain of web.ts in miniature.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import {
  initDatabase, getDb, createTenant, insertApiToken, createKanbanCard, saveAgentMemory, createAgentMessage,
  getAgentMessage, getKanbanCard,
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

let cardDefault = ''
let cardAcme = ''

beforeEach(async () => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  for (const [raw, agent] of [['tok-alpha', 'alpha'], ['tok-beta', 'beta']] as const) {
    await insertApiToken({ tokenHash: sha(raw), name: `fleet:${agent}`, role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: agent })
  }
  cardDefault = 'card-default'
  cardAcme = 'card-acme'
  await createKanbanCard({ id: cardDefault, title: 'Default card', assignee: 'beta', tenant_id: 'default' })
  await createKanbanCard({ id: cardAcme, title: 'Acme card', tenant_id: 'acme' })
})


const tree = (id: string) => getDb().prepare('SELECT parent_id, tenant_id FROM kanban_cards WHERE id = ?').get(id) as { parent_id: string | null; tenant_id: string } | undefined
const childrenOf = (id: string) => getDb().prepare('SELECT id, tenant_id FROM kanban_cards WHERE parent_id = ?').all(id) as Array<{ id: string; tenant_id: string }>
const SUBTASKS = { subtasks: [{ title: 'sub 1', description: 'd', assignee: null, priority: 'normal' }] }

describe('PATCH /api/kanban/:id/parent holds the tenant line', () => {
  beforeEach(async () => {
    await createKanbanCard({ id: 'parent-default', title: 'Parent', tenant_id: 'default' })
    await createKanbanCard({ id: 'parent-acme', title: 'Parent', tenant_id: 'acme' })
  })

  it('a fleet token and a tenant user move their own tenant\'s card under their own tenant\'s parent (200)', async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PATCH', `/api/kanban/${cardDefault}/parent`, { parent_id: 'parent-default' })).status).toBe(200)
    expect(tree(cardDefault)?.parent_id).toBe('parent-default')
    expect((await callAs(session('agent', 'acme'), 'PATCH', `/api/kanban/${cardAcme}/parent`, { parent_id: 'parent-acme' })).status).toBe(200)
    expect(tree(cardAcme)?.parent_id).toBe('parent-acme')
  })

  it("another tenant's card is a 404 and stays where it was", async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PATCH', `/api/kanban/${cardAcme}/parent`, { parent_id: 'parent-default' })).status).toBe(404)
    expect((await callAs(session('agent', 'acme'), 'PATCH', `/api/kanban/${cardDefault}/parent`, { parent_id: 'parent-acme' })).status).toBe(404)
    expect(tree(cardAcme)?.parent_id ?? null).toBeNull()
    expect(tree(cardDefault)?.parent_id ?? null).toBeNull()
  })

  it("an own card cannot be moved under ANOTHER tenant's parent (404)", async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PATCH', `/api/kanban/${cardDefault}/parent`, { parent_id: 'parent-acme' })).status).toBe(404)
    expect((await callAs(session('agent', 'acme'), 'PATCH', `/api/kanban/${cardAcme}/parent`, { parent_id: 'parent-default' })).status).toBe(404)
    expect(tree(cardDefault)?.parent_id ?? null).toBeNull()
    expect(tree(cardAcme)?.parent_id ?? null).toBeNull()
  })

  it('detaching (parent_id null) is not a reference, and an admin keeps the cross-tenant reach', async () => {
    await callAs(await tokenAuth('tok-alpha'), 'PATCH', `/api/kanban/${cardDefault}/parent`, { parent_id: 'parent-default' })
    expect((await callAs(await tokenAuth('tok-alpha'), 'PATCH', `/api/kanban/${cardDefault}/parent`, { parent_id: null })).status).toBe(200)
    expect(tree(cardDefault)?.parent_id ?? null).toBeNull()
    expect((await callAs(await tokenAuth('the-file-token'), 'PATCH', `/api/kanban/${cardAcme}/parent`, { parent_id: 'parent-default' })).status).toBe(200)
    expect(tree(cardAcme)?.parent_id).toBe('parent-default')
  })

  it('viewer and read_only are refused (403)', async () => {
    for (const role of ['viewer', 'read_only'] as const) {
      expect((await callAs(session(role, 'acme'), 'PATCH', `/api/kanban/${cardAcme}/parent`, { parent_id: null })).status).toBe(403)
    }
  })
})

describe('POST /api/kanban/:id/breakdown/accept holds the tenant line', () => {
  it('creates the subtasks under an own card, in that card\'s tenant (200)', async () => {
    const accepted = await callAs(session('agent', 'acme'), 'POST', `/api/kanban/${cardAcme}/breakdown/accept`, SUBTASKS)
    expect(accepted.status).toBe(200)
    const kids = childrenOf(cardAcme)
    expect(kids).toHaveLength(1)
    // the body carries the created ids themselves (a createKanbanSubtasks that lost its await would serialize `{}`)
    expect(accepted.body).toEqual({ ok: true, created: kids.map((k) => k.id) })
    expect(kids[0].tenant_id).toBe('acme')
    expect((await callAs(await tokenAuth('tok-alpha'), 'POST', `/api/kanban/${cardDefault}/breakdown/accept`, SUBTASKS)).status).toBe(200)
    expect(childrenOf(cardDefault)[0].tenant_id).toBe('default')
  })

  it("another tenant's card is a 404 and no subtask or comment is created", async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'POST', `/api/kanban/${cardAcme}/breakdown/accept`, SUBTASKS)).status).toBe(404)
    expect((await callAs(session('agent', 'acme'), 'POST', `/api/kanban/${cardDefault}/breakdown/accept`, SUBTASKS)).status).toBe(404)
    expect(childrenOf(cardAcme)).toHaveLength(0)
    expect(childrenOf(cardDefault)).toHaveLength(0)
    const comments = getDb().prepare('SELECT COUNT(*) AS n FROM kanban_comments WHERE card_id IN (?, ?)').get(cardAcme, cardDefault) as { n: number }
    expect(comments.n).toBe(0)
  })

  it('an admin keeps the cross-tenant reach', async () => {
    expect((await callAs(await tokenAuth('the-file-token'), 'POST', `/api/kanban/${cardAcme}/breakdown/accept`, SUBTASKS)).status).toBe(200)
    expect(childrenOf(cardAcme)[0].tenant_id).toBe('acme')
  })
})

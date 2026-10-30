// PUT on kanban cards/labels, memories and messages had no row in the endpoint table, so it resolved to
// admin:all: a fleet_agent token and a tenant user (role agent) got a 403 on a plain edit. This is the
// endpoint table the other way round: for every role, the PUT is reachable or refused as intended, the
// routes keep their tenant scoping (a foreign row is a 404), and a fleet token closes only the messages
// addressed to its own agent. Real in-memory database, the gate chain of web.ts in miniature.

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
  await createTenant('acme', 'Acme')
  for (const [raw, agent] of [['tok-alpha', 'alpha'], ['tok-beta', 'beta']] as const) {
    await insertApiToken({ tokenHash: sha(raw), name: `fleet:${agent}`, role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: agent })
  }
  cardDefault = 'card-default'
  cardAcme = 'card-acme'
  await createKanbanCard({ id: cardDefault, title: 'Default card', assignee: 'beta', tenant_id: 'default' })
  await createKanbanCard({ id: cardAcme, title: 'Acme card', tenant_id: 'acme' })
})

describe('the endpoint table maps every PUT it should', () => {
  it.each([
    ['PUT', '/api/kanban/x', 'kanban:write'],
    ['PUT', '/api/v1/kanban/x', 'kanban:write'],
    ['PUT', '/api/kanban/labels/x', 'kanban:write'],
    ['PUT', '/api/memories/7', 'memories:write'],
    ['PUT', '/api/v1/memories/7', 'memories:write'],
    ['PUT', '/api/messages/42', 'messages:write'],
    ['PUT', '/api/v1/messages/42', 'messages:write'],
  ])('%s %s needs %s', (method, path, permission) => {
    expect(resolveRequiredPermission(method, path)).toBe(permission)
  })

  it('leaves the neighbours alone: other verbs and other PUTs keep their rows', () => {
    expect(resolveRequiredPermission('PUT', '/api/agents/x/model')).not.toBe('kanban:write')
    expect(resolveRequiredPermission('PUT', '/api/skills/sql/x')).toBe('skills:write')
    expect(resolveRequiredPermission('GET', '/api/kanban/x')).toBe('kanban:read')
    expect(resolveRequiredPermission('DELETE', '/api/memories/7')).toBe('memories:write')
  })
})

describe('PUT /api/kanban/:id by role', () => {
  it('a fleet_agent token edits a card of its tenant (200) and the card changes', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/${cardDefault}`, { description: 'edited' })
    expect(r.status).toBe(200)
    expect((await getKanbanCard(cardDefault))?.description).toBe('edited')
  })

  it('a tenant user (role agent) edits a card of its own tenant (200)', async () => {
    expect((await callAs(session('agent', 'acme'), 'PUT', `/api/kanban/${cardAcme}`, { title: 'renamed' })).status).toBe(200)
    expect((await getKanbanCard(cardAcme))?.title).toBe('renamed')
  })

  it('the shared admin token and an admin session still edit any card', async () => {
    expect((await callAs(await tokenAuth('the-file-token'), 'PUT', `/api/kanban/${cardAcme}`, { title: 'by admin' })).status).toBe(200)
    expect((await callAs(session('admin', null), 'PUT', `/api/kanban/${cardDefault}`, { title: 'by admin session' })).status).toBe(200)
  })

  it('viewer and read_only are refused (403) and nothing changes', async () => {
    for (const role of ['viewer', 'read_only'] as const) {
      const r = await callAs(session(role, 'acme'), 'PUT', `/api/kanban/${cardAcme}`, { title: 'nope' })
      expect(r.status).toBe(403)
    }
    expect((await getKanbanCard(cardAcme))?.title).toBe('Acme card')
  })

  it("another tenant's card is a 404 for a fleet token and a tenant user, and stays untouched", async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/${cardAcme}`, { title: 'cross' })).status).toBe(404)
    expect((await callAs(session('agent', 'acme'), 'PUT', `/api/kanban/${cardDefault}`, { title: 'cross' })).status).toBe(404)
    expect((await getKanbanCard(cardAcme))?.title).toBe('Acme card')
    expect((await getKanbanCard(cardDefault))?.title).toBe('Default card')
  })

  it("a non-admin cannot move a card under ANOTHER tenant's parent (404), but can under its own tenant's", async () => {
    await createKanbanCard({ id: 'parent-default', title: 'Parent', tenant_id: 'default' })
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/${cardDefault}`, { parent_id: cardAcme })).status).toBe(404)
    expect((await getKanbanCard(cardDefault))?.parent_id ?? null).toBeNull()
    expect((await callAs(session('agent', 'acme'), 'PUT', `/api/kanban/${cardAcme}`, { parent_id: 'parent-default' })).status).toBe(404)
    expect((await getKanbanCard(cardAcme))?.parent_id ?? null).toBeNull()

    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/${cardDefault}`, { parent_id: 'parent-default' })).status).toBe(200)
    expect((await getKanbanCard(cardDefault))?.parent_id).toBe('parent-default')
    // admin keeps the cross-tenant reach, and null (detach) is not a reference
    expect((await callAs(await tokenAuth('the-file-token'), 'PUT', `/api/kanban/${cardDefault}`, { parent_id: cardAcme })).status).toBe(200)
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/${cardDefault}`, { parent_id: null })).status).toBe(200)
  })

  it('a label edit is reachable the same way', async () => {
    const made = await callAs(await tokenAuth('tok-alpha'), 'POST', '/api/kanban/labels', { name: 'bug' })
    expect(made.status).toBe(200)
    const id = made.body['id'] as string
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/labels/${id}`, { name: 'defect' })).status).toBe(200)
    expect((await callAs(session('viewer', 'default'), 'PUT', `/api/kanban/labels/${id}`, { name: 'x' })).status).toBe(403)
  })
})

describe('the audit row of a card edit names the caller', () => {
  const rows = () =>
    getDb().prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'kanban' AND action = 'update' AND entity_id = ? ORDER BY id").all(cardDefault) as Array<{ agent_id: string; detail: string }>

  it('a fleet token: the agent of the token, not the assignee of the card (beta)', async () => {
    await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/kanban/${cardDefault}`, { description: 'x' })
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].agent_id).toBe('alpha')
    expect(JSON.parse(r[0].detail)).toMatchObject({ actor_source: 'token' })
  })

  it('a signed-in user: the username, one row (not one for the user and one for the assignee)', async () => {
    await callAs(session('admin', null), 'PUT', `/api/kanban/${cardDefault}`, { description: 'x' })
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].agent_id).toBe('u-admin')
    expect(JSON.parse(r[0].detail)).toMatchObject({ actor_source: 'session' })
  })

  it('the shared token with no identity: falls back to the assignee, as before', async () => {
    await callAs(await tokenAuth('the-file-token'), 'PUT', `/api/kanban/${cardDefault}`, { description: 'x' })
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0].agent_id).toBe('beta')
    expect(JSON.parse(r[0].detail).actor_source).toBeUndefined()
  })
})

describe('PUT /api/memories/:id by role', () => {
  let memDefault = 0
  let memAcme = 0
  beforeEach(async () => {
    memDefault = (await saveAgentMemory('alpha', 'default memory', 'warm', undefined, false, 'default')).id
    memAcme = (await saveAgentMemory('x', 'acme memory', 'warm', undefined, false, 'acme')).id
  })

  it('a fleet token and a tenant user edit a memory of their tenant (200)', async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/memories/${memDefault}`, { content: 'edited by alpha' })).status).toBe(200)
    expect((await callAs(session('agent', 'acme'), 'PUT', `/api/memories/${memAcme}`, { content: 'edited by user' })).status).toBe(200)
    const row = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(memAcme) as { content: string }
    expect(row.content).toBe('edited by user')
  })

  it('viewer and read_only are refused (403)', async () => {
    for (const role of ['viewer', 'read_only'] as const) {
      expect((await callAs(session(role, 'acme'), 'PUT', `/api/memories/${memAcme}`, { content: 'nope' })).status).toBe(403)
    }
  })

  it("another tenant's memory is a 404 and stays untouched", async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/memories/${memAcme}`, { content: 'cross' })).status).toBe(404)
    expect((await callAs(session('agent', 'acme'), 'PUT', `/api/memories/${memDefault}`, { content: 'cross' })).status).toBe(404)
    const row = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(memAcme) as { content: string }
    expect(row.content).toBe('acme memory')
  })
})

describe('PUT /api/messages/:id by role', () => {
  let toAlpha = 0
  let toBeta = 0
  let inAcme = 0
  beforeEach(async () => {
    toAlpha = (await createAgentMessage('main-agent', 'alpha', 'task for alpha')).id
    toBeta = (await createAgentMessage('main-agent', 'beta', 'task for beta')).id
    inAcme = (await createAgentMessage('main-agent', 'alpha', 'acme task', null, null, 'acme', null, true)).id
  })

  it('a fleet token closes a message addressed to its own agent (200)', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/messages/${toAlpha}`, { status: 'done', result: 'ok' })
    expect(r.status).toBe(200)
    expect((await getAgentMessage(toAlpha))?.status).toBe('done')
  })

  it("a fleet token cannot close, fail or refuse a colleague's message (403) and the message stays open", async () => {
    for (const status of ['done', 'failed', 'refused']) {
      const r = await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/messages/${toBeta}`, { status, result: 'not mine' })
      expect(r.status, status).toBe(403)
    }
    expect((await getAgentMessage(toBeta))?.status).not.toBe('done')
    expect((await getAgentMessage(toBeta))?.status).not.toBe('failed')
  })

  it('the refusal is audited with the reason', async () => {
    await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/messages/${toBeta}`, { status: 'done' })
    const row = getDb().prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'message' ORDER BY id DESC LIMIT 1").get() as { agent_id: string; detail: string }
    expect(row.agent_id).toBe('alpha')
    expect(JSON.parse(row.detail)).toMatchObject({ reason: 'not_recipient_denied', message_to: 'beta' })
  })

  it("another tenant's message is a 404 even for its recipient's name, and stays open", async () => {
    expect((await callAs(await tokenAuth('tok-alpha'), 'PUT', `/api/messages/${inAcme}`, { status: 'done' })).status).toBe(404)
    expect((await getAgentMessage(inAcme))?.status).not.toBe('done')
  })

  it('the shared admin token and an admin session still close any message', async () => {
    expect((await callAs(await tokenAuth('the-file-token'), 'PUT', `/api/messages/${toBeta}`, { status: 'done' })).status).toBe(200)
    expect((await callAs(session('admin', null), 'PUT', `/api/messages/${toAlpha}`, { status: 'failed' })).status).toBe(200)
  })

  it('viewer and read_only are refused (403)', async () => {
    for (const role of ['viewer', 'read_only'] as const) {
      expect((await callAs(session(role, 'default'), 'PUT', `/api/messages/${toAlpha}`, { status: 'done' })).status).toBe(403)
    }
  })
})

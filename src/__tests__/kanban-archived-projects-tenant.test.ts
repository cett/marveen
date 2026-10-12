// GET /api/kanban/archived and GET /api/kanban-projects list across cards, so they must hold the tenant
// line for a non-admin caller: a fleet token or a tenant user sees only its own tenant's archived cards
// and project names; an admin sees every tenant, or one with ?tenant=. Real in-memory database, the gate
// chain of web.ts in miniature.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import { initDatabase, createTenant, insertApiToken, createKanbanCard, archiveKanbanCard, createLabel, addLabelToCard } from '../db.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['alpha'],
  isKnownAgent: (n: string) => ['alpha', 'main-agent'].includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)

async function callAs(auth: AuthResult, method: string, path: string) {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', Buffer.alloc(0)); req.emit('end') })
  const out: { status: number; body: unknown } = { status: 200, body: {} }
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
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId: resolveTenantId(auth), tokenAgentId,
    agentId: role === 'fleet_agent' && tokenAgentId ? tokenAgentId : undefined,
    auth: auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName }
      : auth.kind === 'session' ? { kind: 'session', user: auth.user } : undefined,
  } as unknown as RouteContext
  if (await tryHandleKanban(ctx)) return out
  out.status = 404
  return out
}

function tokenAuth(raw: string): AuthResult {
  const req = { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
  return resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
}
const session = (role: 'admin' | 'agent' | 'read_only' | 'viewer', tenantId: string | null): AuthResult => ({ kind: 'session', user: `u-${role}`, role, tenantId })

const alpha = () => tokenAuth('tok-alpha') // fleet_agent, tenant default
const acmeUser = () => session('agent', 'acme')
const admin = () => tokenAuth('the-file-token')

const archivedIds = (body: unknown) => ((body as { cards: Array<{ id: string }> }).cards).map((c) => c.id).sort()

beforeEach(() => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  insertApiToken({ tokenHash: sha('tok-alpha'), name: 'fleet:alpha', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'alpha' })
  createKanbanCard({ id: 'def-arch', title: 'Default archived', project: 'proj-default', tenant_id: 'default' })
  createKanbanCard({ id: 'acme-arch', title: 'Acme archived', project: 'proj-acme', tenant_id: 'acme' })
  createKanbanCard({ id: 'def-live', title: 'Default live', project: 'proj-default-live', tenant_id: 'default' })
  createKanbanCard({ id: 'acme-live', title: 'Acme live', project: 'proj-acme-live', tenant_id: 'acme' })
  archiveKanbanCard('def-arch')
  archiveKanbanCard('acme-arch')
  createLabel({ id: 'lbl-shared-name-acme', name: 'urgent', color: '#3b82f6', tenant_id: 'acme' })
  createLabel({ id: 'lbl-shared-name-def', name: 'urgent', color: '#3b82f6', tenant_id: 'default' })
  addLabelToCard('acme-arch', 'lbl-shared-name-acme')
  addLabelToCard('def-arch', 'lbl-shared-name-def')
})

describe('GET /api/kanban/archived', () => {
  it('a fleet token sees only its own tenant\'s archived cards', async () => {
    const r = await callAs(alpha(), 'GET', '/api/kanban/archived')
    expect(r.status).toBe(200)
    expect(archivedIds(r.body)).toEqual(['def-arch'])
  })

  it('a tenant user sees only its own tenant\'s archived cards', async () => {
    expect(archivedIds((await callAs(acmeUser(), 'GET', '/api/kanban/archived')).body)).toEqual(['acme-arch'])
  })

  it('the project and label filters stay inside the tenant (a foreign project name yields nothing)', async () => {
    expect(archivedIds((await callAs(alpha(), 'GET', '/api/kanban/archived?project=proj-acme')).body)).toEqual([])
    expect(archivedIds((await callAs(alpha(), 'GET', '/api/kanban/archived?label=urgent')).body)).toEqual(['def-arch'])
  })

  it('an admin sees every tenant, or one with ?tenant=', async () => {
    expect(archivedIds((await callAs(admin(), 'GET', '/api/kanban/archived')).body)).toEqual(['acme-arch', 'def-arch'])
    expect(archivedIds((await callAs(admin(), 'GET', '/api/kanban/archived?tenant=acme')).body)).toEqual(['acme-arch'])
  })

  it('a non-admin cannot widen its view with ?tenant=', async () => {
    expect(archivedIds((await callAs(alpha(), 'GET', '/api/kanban/archived?tenant=acme')).body)).toEqual(['def-arch'])
  })
})

describe('GET /api/kanban-projects', () => {
  it('a fleet token and a tenant user see only their own tenant\'s project names', async () => {
    expect((await callAs(alpha(), 'GET', '/api/kanban-projects')).body).toEqual(['proj-default-live'])
    expect((await callAs(acmeUser(), 'GET', '/api/kanban-projects')).body).toEqual(['proj-acme-live'])
  })

  it('an admin sees the project names of every tenant', async () => {
    expect((await callAs(admin(), 'GET', '/api/kanban-projects')).body).toEqual(['proj-acme-live', 'proj-default-live'])
  })
})

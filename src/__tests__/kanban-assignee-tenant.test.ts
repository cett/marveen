// The assignee of a kanban card is a name the caller writes (the claimant of POST /:id/claim, the `assignee` of
// PUT /:id and of POST /). A tenant-bound, non-admin caller must not put the name of ANOTHER tenant's agent there; the
// rule is a DENY rule (an agent name is refused unless it serves the caller's tenant), free text passes. A refused
// request answers 404 and writes nothing. Real in-memory database, the gate chain of web.ts in miniature (harness as in
// kanban-id-routes-tenant.test.ts). Neutral fixtures only: tenant 'acme' stands for the second tenant.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import {
  initDatabase, getDb, createTenant, insertApiToken, createKanbanCard, setTenantAgentAvailability, getKanbanCard,
} from '../db.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const lookup = vi.hoisted(() => ({ fail: false }))
vi.mock('../db/agents.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/agents.js')>()
  return {
    ...real,
    getServedTenantIds: (...a: Parameters<typeof real.getServedTenantIds>) =>
      lookup.fail ? Promise.reject(new Error('lookup down')) : real.getServedTenantIds(...a),
  }
})
// alpha, beta: fleet-internal agents no tenant lists (they serve the default tenant by convention); carmen: enabled for
// both tenants; main-a / main-b: the main agents of the two tenants.
const KNOWN = ['alpha', 'beta', 'carmen', 'main-a', 'main-b', 'main-agent']
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => KNOWN,
  isKnownAgent: (n: string) => KNOWN.includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent', BOT_NAME: 'Botty' }))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)

// The gate of web.ts in miniature. `declared` makes the caller anonymous with an X-Agent-Id (a self-declared claimant).
async function callAs(auth: AuthResult, method: string, path: string, body?: unknown, declared?: string) {
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
    agentId: declared ?? (role === 'fleet_agent' && tokenAgentId ? tokenAgentId : undefined),
    auth: declared ? undefined
      : auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName }
      : auth.kind === 'session' ? { kind: 'session', user: auth.user } : undefined,
  } as unknown as RouteContext
  if (await tryHandleKanban(ctx)) return out
  out.status = 404
  return out
}

async function tokenAuth(raw: string): Promise<AuthResult> {
  const req = { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
  return resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
}
const session = (tenantId: string, user = 'u-agent'): AuthResult => ({ kind: 'session', user, role: 'agent', tenantId })

type Caller = 'default' | 'acme'
const callerAuth = async (c: Caller): Promise<AuthResult> => (c === 'default' ? tokenAuth('tok-alpha') : session('acme'))
const ownCard = (c: Caller) => (c === 'default' ? 'card-default' : 'card-acme')

const cardState = (id: string) => getDb().prepare('SELECT assignee, updated_at, title FROM kanban_cards WHERE id = ?').get(id) as { assignee: string | null; updated_at: number; title: string }
const auditCount = () => (getDb().prepare('SELECT COUNT(*) AS c FROM agent_audit_log').get() as { c: number }).c
const cardsTitled = (t: string) => (getDb().prepare('SELECT COUNT(*) AS c FROM kanban_cards WHERE title = ?').get(t) as { c: number }).c

// [caller tenant, assignee value, allowed]
const CASES: Array<[Caller, string, boolean]> = [
  ['default', 'beta', true],
  ['default', 'Beta', true],
  ['default', 'beta, alpha', true],
  ['default', 'carmen', true],
  ['default', 'main-a', true],
  ['default', 'Some Person', true],
  // the bot name is the main agent for the dispatcher (here a name that differs from the main agent id)
  ['default', 'Botty', true],
  ['acme', 'Botty', false],
  ['acme', 'botty, main-b', false],
  ['default', 'main-b', false],
  ['default', 'MAIN-B', false],
  ['default', ' main-b ', false],
  ['default', 'beta, main-b', false],
  ['default', 'main-b, beta', false],
  ['acme', 'main-b', true],
  ['acme', 'carmen', true],
  ['acme', 'Some Person', true],
  ['acme', 'beta', false],
  ['acme', 'main-a', false],
  ['acme', 'main-b, beta', false],
]

beforeEach(async () => {
  lookup.fail = false
  initDatabase(':memory:')
  await createTenant('acme', 'Acme')
  getDb().prepare("UPDATE tenants SET main_agent_id = 'main-a' WHERE id = 'default'").run()
  getDb().prepare("UPDATE tenants SET main_agent_id = 'main-b' WHERE id = 'acme'").run()
  await setTenantAgentAvailability('default', 'carmen', true)
  await setTenantAgentAvailability('acme', 'carmen', true)
  await insertApiToken({ tokenHash: sha('tok-alpha'), name: 'fleet:alpha', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'alpha' })
  await createKanbanCard({ id: 'card-default', title: 'Default card', tenant_id: 'default' })
  await createKanbanCard({ id: 'card-acme', title: 'Acme card', tenant_id: 'acme' })
})

describe('PUT /api/kanban/:id: the assignee names no foreign tenant agent', () => {
  it.each(CASES)('%s caller, assignee %j -> allowed: %s', async (caller, value, allowed) => {
    const id = ownCard(caller)
    const before = cardState(id)
    const audits = auditCount()
    const out = await callAs(await callerAuth(caller), 'PUT', `/api/kanban/${id}`, { title: 'Renamed', assignee: value })
    if (allowed) {
      expect(out.status).toBe(200)
      expect(cardState(id)).toMatchObject({ assignee: value, title: 'Renamed' })
    } else {
      expect(out.status).toBe(404)
      expect(out.body).toMatchObject({ error: 'not_found', field: 'assignee' })
      expect(cardState(id)).toEqual(before) // no other field of the PUT is written either
      expect(auditCount()).toBe(audits)
    }
  })

  it('the admin may name any agent', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'PUT', '/api/kanban/card-default', { assignee: 'main-b' })
    expect(out.status).toBe(200)
    expect(cardState('card-default').assignee).toBe('main-b')
  })

  it('unassigning (null, empty string, blanks) is not judged', async () => {
    for (const v of [null, '', '   ']) {
      const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: v })
      expect(out.status, JSON.stringify(v)).toBe(200)
    }
  })

  it('a value that is not a string is not judged by this rule', async () => {
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 123 })
    expect(out.body.field).not.toBe('assignee')
  })

  it('a foreign CARD still answers 404 before the assignee is looked at', async () => {
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-acme', { assignee: 'main-b' })
    expect(out.status).toBe(404)
    expect(out.body.field).toBeUndefined()
  })

  it('a failing lookup is a 500 and writes nothing (fail closed)', async () => {
    const before = cardState('card-default')
    lookup.fail = true
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { title: 'Renamed', assignee: 'main-a' })
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
    expect(cardState('card-default')).toEqual(before)
  })
})

describe('POST /api/kanban: the assignee names no foreign tenant agent', () => {
  it.each(CASES)('%s caller, assignee %j -> allowed: %s', async (caller, value, allowed) => {
    const title = `New card ${caller} ${value}`
    const out = await callAs(await callerAuth(caller), 'POST', '/api/kanban', { title, assignee: value })
    if (allowed) {
      expect(out.status).toBe(200)
      expect(cardsTitled(title)).toBe(1)
    } else {
      expect(out.status).toBe(404)
      expect(out.body).toMatchObject({ error: 'not_found', field: 'assignee' })
      expect(cardsTitled(title)).toBe(0)
    }
  })

  it('the admin may name any agent', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'POST', '/api/kanban', { title: 'Admin card', assignee: 'main-b' })
    expect(out.status).toBe(200)
  })

  it('no assignee, or an empty one, is not judged', async () => {
    expect((await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'No assignee' })).status).toBe(200)
    expect((await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'Empty assignee', assignee: '' })).status).toBe(200)
  })

  it('a failing lookup is a 500 and creates nothing (fail closed)', async () => {
    lookup.fail = true
    const out = await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'Lookup down', assignee: 'main-a' })
    expect(out.status).toBe(500)
    expect(cardsTitled('Lookup down')).toBe(0)
  })
})

describe('POST /api/kanban/:id/claim: the claimant names no foreign tenant agent', () => {
  // a self-declared claimant (X-Agent-Id, any name) of each tenant
  it.each(CASES)('%s caller, X-Agent-Id %j -> allowed: %s', async (caller, value, allowed) => {
    const id = ownCard(caller)
    const before = cardState(id)
    const audits = auditCount()
    const out = await callAs(session(caller), 'POST', `/api/kanban/${id}/claim`, undefined, value)
    if (allowed) {
      expect(out.status).toBe(200)
      expect(cardState(id).assignee).toBe(value)
    } else {
      expect(out.status).toBe(404)
      expect(out.body).toMatchObject({ error: 'not_found', field: 'agent' })
      expect(cardState(id)).toEqual(before)
      expect(auditCount()).toBe(audits)
    }
  })

  it('a signed-in user whose name is a foreign tenant agent is refused as well (accepted edge case)', async () => {
    const out = await callAs(session('default', 'main-b'), 'POST', '/api/kanban/card-default/claim')
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('agent')
  })

  it('the token agent of the caller claims its own card', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', '/api/kanban/card-default/claim')
    expect(out.status).toBe(200)
    expect(cardState('card-default').assignee).toBe('alpha')
  })

  it('the admin may claim as any name', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'POST', '/api/kanban/card-default/claim', undefined, 'main-b')
    expect(out.status).toBe(200)
    expect(cardState('card-default').assignee).toBe('main-b')
  })

  it('a foreign CARD still answers 404 before the claimant is looked at', async () => {
    const out = await callAs(session('default'), 'POST', '/api/kanban/card-acme/claim', undefined, 'main-b')
    expect(out.status).toBe(404)
    expect(out.body.field).toBeUndefined()
  })

  it('a failing lookup is a 500 and claims nothing (fail closed)', async () => {
    lookup.fail = true
    const before = cardState('card-default')
    const out = await callAs(session('default'), 'POST', '/api/kanban/card-default/claim', undefined, 'main-a')
    expect(out.status).toBe(500)
    expect(cardState('card-default')).toEqual(before)
    expect((await getKanbanCard('card-default'))?.assignee ?? null).toBe(before.assignee)
  })
})

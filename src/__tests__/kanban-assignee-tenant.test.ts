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
import { tryHandleKanban, MAX_BREAKDOWN_ACCEPT_SUBTASKS } from '../web/routes/kanban.js'
import { MAX_ASSIGNEE_LENGTH } from '../web/routes/kanban-assignee-tenant.js'
import { generateBreakdown } from '../web/llm-breakdown.js'
import { OWNER_NAME } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

// `calls` records the agent name of every served-tenants lookup, so a test can count the lookups of one request.
const lookup = vi.hoisted(() => ({ fail: false, calls: [] as string[] }))
vi.mock('../db/agents.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/agents.js')>()
  return {
    ...real,
    getServedTenantIds: (...a: Parameters<typeof real.getServedTenantIds>) => {
      lookup.calls.push(String(a[0]))
      return lookup.fail ? Promise.reject(new Error('lookup down')) : real.getServedTenantIds(...a)
    },
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
  lookup.calls.length = 0
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

// A value that is not a string never reaches the tenant verdict: the database layer would write a one-element array as
// its single element (a foreign agent name on the card), so a tenant-bound caller gets a 400 and nothing is written.
const NON_STRING: Array<[string, unknown]> = [
  ['a one-element array naming an agent of the other tenant', ['alpha']],
  ['a one-element array naming an agent of the caller tenant', ['main-b']],
  ['a two-element array', ['a', 'b']],
  ['an empty array', []],
  ['an empty object', {}],
  ['an object', { a: 1 }],
  ['true', true],
  ['false', false],
  ['a number', 123],
  ['zero', 0],
]

describe('PUT /api/kanban/:id: the assignee is a string or null for a tenant-bound caller', () => {
  const callers: Caller[] = ['default', 'acme']
  for (const caller of callers) {
    it.each(NON_STRING)(`${caller} caller, %s -> 400 invalid_value, nothing written`, async (_label, value) => {
      const id = ownCard(caller)
      const before = cardState(id)
      const audits = auditCount()
      const out = await callAs(await callerAuth(caller), 'PUT', `/api/kanban/${id}`, { title: 'Renamed', assignee: value })
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
      expect(cardState(id)).toEqual(before)
      expect(auditCount()).toBe(audits)
    })
  }

  it('the type comes first: a one-element array of a foreign agent is a 400, not a 404 and not a 200', async () => {
    const out = await callAs(session('acme'), 'PUT', '/api/kanban/card-acme', { assignee: ['alpha'] })
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(cardState('card-acme').assignee).toBeNull()
  })

  it('null and an empty string still unassign, a plain string follows the tenant rule', async () => {
    await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'beta' })
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: null })).status).toBe(200)
    expect(cardState('card-default').assignee).toBeNull()
    await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'beta' })
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: '' })).status).toBe(200)
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'beta' })).status).toBe(200)
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'main-b' })).status).toBe(404)
  })

  it('a body without the key leaves the assignee alone', async () => {
    await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'beta' })
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { title: 'Only a title' })).status).toBe(200)
    expect(cardState('card-default')).toMatchObject({ assignee: 'beta', title: 'Only a title' })
  })

  it('a foreign CARD and a foreign parent still answer 404 before the assignee type is looked at', async () => {
    const card = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-acme', { assignee: ['alpha'] })
    expect(card.status).toBe(404)
    expect(card.body.field).toBeUndefined()
    const parent = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { parent_id: 'card-acme', assignee: ['alpha'] })
    expect(parent.status).toBe(404)
    expect(parent.body.field).toBe('parent_id')
  })

  it('the admin may still name a foreign tenant agent by name (the tenant verdict is not for the admin)', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'PUT', '/api/kanban/card-default', { assignee: 'main-b' })
    expect(out.status).toBe(200)
  })
})

describe('POST /api/kanban: the assignee is a string or null for a tenant-bound caller', () => {
  const callers: Caller[] = ['default', 'acme']
  for (const caller of callers) {
    it.each(NON_STRING)(`${caller} caller, %s -> 400 invalid_value, no card created`, async (label, value) => {
      const title = `Typed ${caller} ${label}`
      const cards = (getDb().prepare('SELECT COUNT(*) AS c FROM kanban_cards').get() as { c: number }).c
      const out = await callAs(await callerAuth(caller), 'POST', '/api/kanban', { title, assignee: value })
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
      expect(cardsTitled(title)).toBe(0)
      expect((getDb().prepare('SELECT COUNT(*) AS c FROM kanban_cards').get() as { c: number }).c).toBe(cards)
    })
  }

  it('the type comes first: a one-element array of a foreign agent is a 400, not a 404 and not a 200', async () => {
    const out = await callAs(session('acme'), 'POST', '/api/kanban', { title: 'Array of a foreign agent', assignee: ['alpha'] })
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(cardsTitled('Array of a foreign agent')).toBe(0)
  })

  it('null still creates an unassigned card', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'Null assignee', assignee: null })
    expect(out.status).toBe(200)
    expect(cardsTitled('Null assignee')).toBe(1)
  })

  it('a foreign parent still answers 404 before the assignee type is looked at', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'Foreign parent', parent_id: 'card-acme', assignee: ['alpha'] })
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('parent_id')
  })

  it('the admin may still name a foreign tenant agent by name (the tenant verdict is not for the admin)', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'POST', '/api/kanban', { title: 'Admin typed', assignee: 'main-b' })
    expect(out.status).toBe(200)
  })
})

describe('an agent that only the tenant availability list names (no agents/ folder)', () => {
  // 'ghost' is enabled for the default tenant only and is no known agent folder: the served-tenants list alone makes it
  // an agent name, so the acme caller must not name it (a rule that required a folder would pass it as free text).
  beforeEach(async () => { await setTenantAgentAvailability('default', 'ghost', true) })

  it.each([['PUT'], ['POST']])('%s: the acme caller naming it is a 404', async (method) => {
    const out = method === 'PUT'
      ? await callAs(session('acme'), 'PUT', '/api/kanban/card-acme', { assignee: 'ghost' })
      : await callAs(session('acme'), 'POST', '/api/kanban', { title: 'Ghost card', assignee: 'ghost' })
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ error: 'not_found', field: 'assignee' })
    expect(cardsTitled('Ghost card')).toBe(0)
    expect(cardState('card-acme').assignee).toBeNull()
  })

  it('the claim: the acme caller claiming as it is a 404', async () => {
    const out = await callAs(session('acme'), 'POST', '/api/kanban/card-acme/claim', undefined, 'ghost')
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('agent')
  })

  it('the default tenant may name it', async () => {
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'ghost' })
    expect(out.status).toBe(200)
  })
})

describe('the admin bypass holds with a ?tenant= narrowing as well', () => {
  // main-a serves the default tenant; with ?tenant=acme the admin's effective tenant is acme, and the admin still names it.
  it('PUT', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'PUT', '/api/kanban/card-acme?tenant=acme', { assignee: 'main-a' })
    expect(out.status).toBe(200)
    expect(cardState('card-acme').assignee).toBe('main-a')
  })

  it('POST', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'POST', '/api/kanban?tenant=acme', { title: 'Admin narrowed', assignee: 'main-a' })
    expect(out.status).toBe(200)
    expect(cardsTitled('Admin narrowed')).toBe(1)
  })

  it('claim', async () => {
    const out = await callAs(await tokenAuth('the-file-token'), 'POST', '/api/kanban/card-acme/claim?tenant=acme', undefined, 'main-a')
    expect(out.status).toBe(200)
    expect(cardState('card-acme').assignee).toBe('main-a')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// POST /api/kanban/:id/breakdown/accept: the `assignee` of every subtask is a string or null, and a tenant-bound caller
// names no foreign tenant agent. One bad element refuses the whole batch; nothing is written.
// ---------------------------------------------------------------------------------------------------------------

const acceptPath = (parent: string, query = '') => `/api/kanban/${parent}/breakdown/accept${query}`
const childRows = (parent: string) => getDb().prepare('SELECT assignee, title FROM kanban_cards WHERE parent_id = ? ORDER BY rowid').all(parent) as Array<{ assignee: string | null; title: string }>
const commentCount = (card: string) => (getDb().prepare('SELECT COUNT(*) AS c FROM kanban_comments WHERE card_id = ?').get(card) as { c: number }).c
const cardCount = () => (getDb().prepare('SELECT COUNT(*) AS c FROM kanban_cards').get() as { c: number }).c
const sub = (title: string, extra: Record<string, unknown> = {}) => ({ title, description: '', priority: 'normal', ...extra })

// per caller: the parent card it owns, an agent of ANOTHER tenant, an agent of its own tenant
const ACCEPT_CALLERS: Array<[Caller, string, string]> = [
  ['default', 'main-b', 'main-a'],
  ['acme', 'main-a', 'main-b'],
]
const acceptAuth = (c: Caller) => (c === 'default' ? callerAuth(c) : Promise.resolve(session('acme')))

// Nothing about the parent or the board changed: no child, no comment, no audit row, same parent row.
function snapshotBoard(parent: string) {
  return { parent: cardState(parent), cards: cardCount(), comments: commentCount(parent), audits: auditCount() }
}

describe.each(ACCEPT_CALLERS)('breakdown/accept, %s caller: the subtask assignees', (caller, foreign, own) => {
  const parent = ownCard(caller)

  it('a foreign tenant agent on the 2nd of 3 subtasks is a 404 on subtasks[1].assignee and nothing is written', async () => {
    const before = snapshotBoard(parent)
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one'), sub('two', { assignee: foreign }), sub('three')] })
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ error: 'not_found', field: 'subtasks[1].assignee' })
    expect(childRows(parent)).toEqual([])
    expect(snapshotBoard(parent)).toEqual(before)
  })

  it('free text, an own tenant agent, null, a blank and an absent assignee all pass and the children are created', async () => {
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), {
      subtasks: [sub('a', { assignee: 'Some Person' }), sub('b', { assignee: own }), sub('c', { assignee: null }), sub('d', { assignee: '   ' }), sub('e')],
    })
    expect(out.status).toBe(200)
    const rows = childRows(parent)
    expect(rows.map((r) => r.title)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(rows[0].assignee).toBe('Some Person')
    expect(rows[1].assignee).toBe(own)
    expect(rows[2].assignee).toBeNull()
  })

  it('a comma list with one foreign part refuses the whole batch', async () => {
    const before = snapshotBoard(parent)
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one'), sub('two', { assignee: `${own}, ${foreign}` })] })
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('subtasks[1].assignee')
    expect(snapshotBoard(parent)).toEqual(before)
  })

  it('the LAST subtask is judged too (not only the first)', async () => {
    const before = snapshotBoard(parent)
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one'), sub('two'), sub('three'), sub('four', { assignee: foreign })] })
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('subtasks[3].assignee')
    expect(snapshotBoard(parent)).toEqual(before)
  })

  it.each([['null', null], ['a number', 5], ['a string', 'x'], ['an array', []], ['a boolean', true]])('an element that is %s is a 400 on subtasks', async (_l, el) => {
    const before = snapshotBoard(parent)
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one'), el] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'subtasks' })
    expect(snapshotBoard(parent)).toEqual(before)
  })

  it.each(NON_STRING)('the 3rd subtask with assignee %s is a 400 on subtasks[2].assignee and nothing is written', async (_l, value) => {
    const before = snapshotBoard(parent)
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one'), sub('two'), sub('three', { assignee: value })] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'subtasks[2].assignee' })
    expect(snapshotBoard(parent)).toEqual(before)
  })

  it('the type comes first: a one-element array naming a foreign agent is a 400, not a 200 and not a 404', async () => {
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one', { assignee: [foreign] })] })
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(childRows(parent)).toEqual([])
  })

  it('the elements are judged in order: the first refusal wins', async () => {
    const a = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one', { assignee: foreign }), sub('two', { assignee: 5 })] })
    expect(a.status).toBe(404)
    expect(a.body.field).toBe('subtasks[0].assignee')
    const b = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one', { assignee: 5 }), sub('two', { assignee: foreign })] })
    expect(b.status).toBe(400)
    expect(b.body.field).toBe('subtasks[0].assignee')
  })

  it('a foreign PARENT is a 404 before any subtask is looked at', async () => {
    const other = caller === 'default' ? 'card-acme' : 'card-default'
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(other), { subtasks: [sub('one', { assignee: [foreign] })] })
    expect(out.status).toBe(404)
    expect(out.body.field).toBeUndefined()
  })

  it('an empty list is still the required-field 400', async () => {
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'subtasks' })
  })

  it('a failing lookup is a 500 and nothing is written (fail closed)', async () => {
    const before = snapshotBoard(parent)
    lookup.fail = true
    const out = await callAs(await acceptAuth(caller), 'POST', acceptPath(parent), { subtasks: [sub('one'), sub('two', { assignee: own })] })
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
    expect(snapshotBoard(parent)).toEqual(before)
  })
})

describe('breakdown/accept: one lookup per distinct agent name of the batch', () => {
  it('the same name five times is looked up once, and a name repeated inside comma lists too', async () => {
    const same = Array.from({ length: 5 }, (_v, i) => sub(`s${i}`, { assignee: 'beta' }))
    // ends in a foreign agent, so the batch is refused after all the names were judged (no create, no create-time lookups)
    const out = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [...same, sub('lists', { assignee: 'main-a, beta' }), sub('again', { assignee: 'MAIN-A' }), sub('last', { assignee: 'main-b' })] })
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('subtasks[7].assignee')
    expect([...lookup.calls].sort()).toEqual(['beta', 'main-a', 'main-b'])
  })
})

describe('breakdown/accept and the body assignee: the admin', () => {
  const ADMIN = () => tokenAuth('the-file-token')

  it('names a foreign tenant agent on a subtask (no tenant line to hold), with ?tenant= as well', async () => {
    const plain = await callAs(await ADMIN(), 'POST', acceptPath('card-default'), { subtasks: [sub('one', { assignee: 'main-b' })] })
    expect(plain.status).toBe(200)
    const narrowed = await callAs(await ADMIN(), 'POST', acceptPath('card-acme', '?tenant=acme'), { subtasks: [sub('one', { assignee: 'main-a' })] })
    expect(narrowed.status).toBe(200)
    expect(childRows('card-acme')[0].assignee).toBe('main-a')
  })

  it('a null element is a 400 on subtasks, no longer an unhandled TypeError', async () => {
    const before = snapshotBoard('card-default')
    const out = await callAs(await ADMIN(), 'POST', acceptPath('card-default'), { subtasks: [sub('one'), null] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'subtasks' })
    expect(snapshotBoard('card-default')).toEqual(before)
  })

  // the old admin behaviour (a one-element array written as text, a longer one or an object thrown by the database
  // layer, a number written as "123.0") is gone: a 400 and nothing written, on all three routes
  it.each(NON_STRING)('PUT with assignee %s is a 400 and nothing is written', async (_l, value) => {
    const before = cardState('card-default')
    const audits = auditCount()
    const out = await callAs(await ADMIN(), 'PUT', '/api/kanban/card-default', { title: 'Renamed', assignee: value })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
    expect(cardState('card-default')).toEqual(before)
    expect(auditCount()).toBe(audits)
  })

  it.each(NON_STRING)('PUT ?tenant=acme with assignee %s is a 400 as well', async (_l, value) => {
    const before = cardState('card-acme')
    const out = await callAs(await ADMIN(), 'PUT', '/api/kanban/card-acme?tenant=acme', { assignee: value })
    expect(out.status).toBe(400)
    expect(cardState('card-acme')).toEqual(before)
  })

  it.each(NON_STRING)('POST with assignee %s is a 400 and no card is created', async (label, value) => {
    const cards = cardCount()
    const out = await callAs(await ADMIN(), 'POST', '/api/kanban', { title: `Admin typed ${label}`, assignee: value })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
    expect(cardCount()).toBe(cards)
  })

  it.each(NON_STRING)('breakdown/accept with a subtask assignee %s is a 400 on subtasks[1].assignee and nothing is written', async (_l, value) => {
    const before = snapshotBoard('card-default')
    const out = await callAs(await ADMIN(), 'POST', acceptPath('card-default'), { subtasks: [sub('one'), sub('two', { assignee: value })] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'subtasks[1].assignee' })
    expect(snapshotBoard('card-default')).toEqual(before)
  })

  it('null and a string still go through on PUT and POST', async () => {
    expect((await callAs(await ADMIN(), 'PUT', '/api/kanban/card-default', { assignee: null })).status).toBe(200)
    expect((await callAs(await ADMIN(), 'PUT', '/api/kanban/card-default', { assignee: 'main-b' })).status).toBe(200)
    expect((await callAs(await ADMIN(), 'POST', '/api/kanban', { title: 'Admin null', assignee: null })).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Follow-ups: (1) the PUT verdict judges a CHANGE, (2) the assignee length cap, (3) the breakdown suggestion is
// filtered to the caller's tenant, (4) the accept batch cap, (5) a non-object accept body.
// ---------------------------------------------------------------------------------------------------------------

const ADMIN_AUTH = () => tokenAuth('the-file-token')
const setAssignee = (id: string, value: string | null) => { getDb().prepare('UPDATE kanban_cards SET assignee = ? WHERE id = ?').run(value, id) }

describe('PUT /api/kanban/:id: the tenant verdict judges a change, not the value the card already holds', () => {
  it('pins the contract values', () => {
    expect(MAX_ASSIGNEE_LENGTH).toBe(500)
    expect(MAX_BREAKDOWN_ACCEPT_SUBTASKS).toBe(50)
  })

  it('a full-card PUT that sends the foreign assignee back unchanged is a 200 and the other fields are written', async () => {
    setAssignee('card-default', 'main-b') // an admin gave the card to the other tenant's agent
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { title: 'Renamed', assignee: 'main-b' })
    expect(out.status).toBe(200)
    expect(cardState('card-default')).toMatchObject({ assignee: 'main-b', title: 'Renamed' })
  })

  it('the same on the other tenant (an own card held by a foreign agent)', async () => {
    setAssignee('card-acme', 'main-a')
    const out = await callAs(await callerAuth('acme'), 'PUT', '/api/kanban/card-acme', { title: 'Renamed', assignee: 'main-a' })
    expect(out.status).toBe(200)
    expect(cardState('card-acme')).toMatchObject({ assignee: 'main-a', title: 'Renamed' })
  })

  it('and no agent lookup is made for the unchanged value', async () => {
    setAssignee('card-default', 'main-b')
    await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'main-b' })
    expect(lookup.calls).toEqual([])
  })

  // the stored assignee is main-b: every one of these is a DIFFERENT value (plain string equality, nothing normalised)
  it.each([
    ['another foreign agent', 'main-b, main-b2'],
    ['another capitalisation', 'MAIN-B'],
    ['another capitalisation of one letter', 'Main-b'],
    ['a trailing blank', 'main-b '],
    ['a comma list that starts with the stored value', 'main-b, beta'],
    ['the stored value as a list part of a longer one', 'beta, main-b'],
  ])('a foreign value that differs from the stored one is a 404 and writes nothing: %s', async (_l, value) => {
    setAssignee('card-default', 'main-b')
    const before = cardState('card-default')
    const audits = auditCount()
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { title: 'Renamed', assignee: value })
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ error: 'not_found', field: 'assignee' })
    expect(cardState('card-default')).toEqual(before)
    expect(auditCount()).toBe(audits)
  })

  it.each([[null], [''], ['   ']])('a card whose assignee is %j has no unchanged value: a foreign name is a 404', async (stored) => {
    setAssignee('card-default', stored)
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'main-b' })
    expect(out.status).toBe(404)
    expect(cardState('card-default').assignee).toBe(stored)
  })

  it('a card held by a foreign agent can still be handed to an own-tenant agent, and the unassign works', async () => {
    setAssignee('card-default', 'main-b')
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: 'beta' })).status).toBe(200)
    setAssignee('card-default', 'main-b')
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: null })).status).toBe(200)
  })

  it('the length cap still runs on an unchanged value (a stored over-long assignee is not a way past it)', async () => {
    const huge = 'x'.repeat(MAX_ASSIGNEE_LENGTH + 1)
    setAssignee('card-default', huge)
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: huge })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
  })

  it('the type rule still runs on a card that holds a foreign agent', async () => {
    setAssignee('card-default', 'main-b')
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: ['main-b'] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
  })

  it('the admin sends the same unchanged value and a new one: both 200', async () => {
    setAssignee('card-default', 'main-b')
    expect((await callAs(await ADMIN_AUTH(), 'PUT', '/api/kanban/card-default', { title: 'Renamed', assignee: 'main-b' })).status).toBe(200)
    expect((await callAs(await ADMIN_AUTH(), 'PUT', '/api/kanban/card-default', { assignee: 'main-a' })).status).toBe(200)
  })

  it('POST has no current value: a foreign agent is a 404 even when the board holds the same name elsewhere', async () => {
    setAssignee('card-default', 'main-b')
    const out = await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'New one', assignee: 'main-b' })
    expect(out.status).toBe(404)
    expect(cardsTitled('New one')).toBe(0)
  })
})

describe('the assignee is at most 500 characters, for every caller', () => {
  const at = 'x'.repeat(MAX_ASSIGNEE_LENGTH)
  const over = 'x'.repeat(MAX_ASSIGNEE_LENGTH + 1)
  // 'main-b' is a foreign agent for the default caller: the value would be a 404 if the verdict ran first
  const overForeign = `main-b${' '.repeat(MAX_ASSIGNEE_LENGTH)}`

  it('PUT: 500 passes, 501 is a 400 with the hint and nothing is written', async () => {
    expect((await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: at })).status).toBe(200)
    const before = cardState('card-default')
    const audits = auditCount()
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { title: 'Renamed', assignee: over })
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'invalid_value', field: 'assignee', hint: 'assignee must be at most 500 characters' })
    expect(cardState('card-default')).toEqual(before)
    expect(auditCount()).toBe(audits)
  })

  it('POST: 500 passes, 501 is a 400 and no card is created', async () => {
    expect((await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'At the cap', assignee: at })).status).toBe(200)
    const out = await callAs(await callerAuth('default'), 'POST', '/api/kanban', { title: 'Over the cap', assignee: over })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
    expect(cardsTitled('Over the cap')).toBe(0)
  })

  it('accept: 500 passes, 501 on the 2nd subtask is a 400 on subtasks[1].assignee and nothing is written', async () => {
    const ok = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [sub('a', { assignee: at })] })
    expect(ok.status).toBe(200)
    getDb().prepare('DELETE FROM kanban_cards WHERE parent_id = ?').run('card-default')
    const before = snapshotBoard('card-default')
    const out = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [sub('a'), sub('b', { assignee: over })] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'subtasks[1].assignee' })
    expect(snapshotBoard('card-default')).toEqual(before)
  })

  it('a megabyte is a 400 and is never handed to the agent lookup', async () => {
    const mb = 'beta, '.repeat(200_000)
    for (const [method, path, body] of [
      ['PUT', '/api/kanban/card-default', { assignee: mb }],
      ['POST', '/api/kanban', { title: 'Huge', assignee: mb }],
      ['POST', acceptPath('card-default'), { subtasks: [sub('a', { assignee: mb })] }],
    ] as const) {
      const out = await callAs(await callerAuth('default'), method, path, body)
      expect(out.status, path).toBe(400)
    }
    expect(lookup.calls).toEqual([])
  })

  it('the cap comes BEFORE the tenant verdict: an over-long value naming a foreign agent is a 400, not a 404', async () => {
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: overForeign })
    expect(out.status).toBe(400)
    expect(lookup.calls).toEqual([])
  })

  it('the cap comes AFTER the type rule: a non-string is the type 400', async () => {
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: [over] })
    expect(out.status).toBe(400)
    expect(out.body.hint).toBe('assignee must be a string or null')
  })

  it('the admin is capped as well, on all three routes', async () => {
    expect((await callAs(await ADMIN_AUTH(), 'PUT', '/api/kanban/card-default', { assignee: at })).status).toBe(200)
    expect((await callAs(await ADMIN_AUTH(), 'PUT', '/api/kanban/card-default', { assignee: over })).status).toBe(400)
    expect((await callAs(await ADMIN_AUTH(), 'POST', '/api/kanban', { title: 'Admin over', assignee: over })).status).toBe(400)
    const accept = await callAs(await ADMIN_AUTH(), 'POST', acceptPath('card-default'), { subtasks: [sub('a', { assignee: over })] })
    expect(accept.status).toBe(400)
    expect(accept.body).toMatchObject({ field: 'subtasks[0].assignee' })
  })

  it('counts UTF-16 units (.length): 251 two-unit characters are over the cap', async () => {
    const out = await callAs(await callerAuth('default'), 'PUT', '/api/kanban/card-default', { assignee: '\u{1F600}'.repeat(MAX_ASSIGNEE_LENGTH / 2 + 1) })
    expect(out.status).toBe(400)
  })
})

describe('breakdown/accept: a batch of at most 50 subtasks', () => {
  const many = (n: number) => Array.from({ length: n }, (_v, i) => sub(`s${i}`))

  it.each<[Caller | 'admin']>([['default'], ['acme'], ['admin']])('%s: 50 pass and 50 children are created', async (who) => {
    const auth = who === 'admin' ? await ADMIN_AUTH() : await callerAuth(who)
    const parent = who === 'acme' ? 'card-acme' : 'card-default'
    const out = await callAs(auth, 'POST', acceptPath(parent), { subtasks: many(MAX_BREAKDOWN_ACCEPT_SUBTASKS) })
    expect(out.status).toBe(200)
    expect(childRows(parent)).toHaveLength(50)
  })

  it.each<[Caller | 'admin']>([['default'], ['acme'], ['admin']])('%s: 51 are a 400 limit_exceeded on subtasks and nothing is written', async (who) => {
    const auth = who === 'admin' ? await ADMIN_AUTH() : await callerAuth(who)
    const parent = who === 'acme' ? 'card-acme' : 'card-default'
    const before = snapshotBoard(parent)
    const out = await callAs(auth, 'POST', acceptPath(parent), { subtasks: many(MAX_BREAKDOWN_ACCEPT_SUBTASKS + 1) })
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'limit_exceeded', field: 'subtasks', hint: 'At most 50 subtasks per request' })
    expect(snapshotBoard(parent)).toEqual(before)
  })

  it('the cap comes before the per-element check: 51 elements whose first is not an object are limit_exceeded', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [null, ...many(50)] })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'limit_exceeded', field: 'subtasks' })
  })

  it('the elements of an over-sized batch are never looked up (no agent lookup, even with a foreign assignee first)', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [sub('x', { assignee: 'main-b' }), ...many(50)] })
    expect(out.body).toMatchObject({ error: 'limit_exceeded' })
    expect(lookup.calls).toEqual([])
  })

  it('an empty list is still the required-field 400 and a foreign parent still a 404 before the cap', async () => {
    const empty = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [] })
    expect(empty.body).toMatchObject({ error: 'required', field: 'subtasks' })
    const foreignParent = await callAs(await callerAuth('default'), 'POST', acceptPath('card-acme'), { subtasks: many(51) })
    expect(foreignParent.status).toBe(404)
  })
})

describe('breakdown/accept: the body must be a JSON object', () => {
  it.each([
    ['null', null],
    ['a number', 5],
    ['a string', 'x'],
    ['an array', []],
    ['a non-empty array', [{ subtasks: [{ title: 'a' }] }]],
    ['a boolean', true],
  ])('%s is a 400 invalid_value on body and nothing is written', async (_l, body) => {
    for (const auth of [await callerAuth('default'), await ADMIN_AUTH()]) {
      const before = snapshotBoard('card-default')
      const out = await callAs(auth, 'POST', acceptPath('card-default'), body)
      expect(out.status).toBe(400)
      expect(out.body).toEqual({ error: 'invalid_value', field: 'body', hint: 'The body must be a JSON object' })
      expect(snapshotBoard('card-default')).toEqual(before)
    }
  })

  it('an empty object is the existing required-field 400, a valid body is unchanged', async () => {
    const empty = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), {})
    expect(empty.body).toMatchObject({ error: 'required', field: 'subtasks' })
    const ok = await callAs(await callerAuth('default'), 'POST', acceptPath('card-default'), { subtasks: [sub('a')] })
    expect(ok.status).toBe(200)
    expect(childRows('card-default')).toHaveLength(1)
  })
})

describe('breakdown generate: the suggestion is filtered to the caller tenant', () => {
  const generate = vi.mocked(generateBreakdown)
  const generatePath = (id: string, query = '') => `/api/kanban/${id}/breakdown${query}`
  const candidates = (call = 0) => [...(generate.mock.calls[call][2] ?? [])].sort()

  beforeEach(() => {
    generate.mockReset()
    generate.mockResolvedValue({ subtasks: [] })
  })

  it('the default tenant is offered its own agents, the bot name and the owner, not the other tenant main agent', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', generatePath('card-default'))
    expect(out.status).toBe(200)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][2]).toBeInstanceOf(Set)
    expect(candidates()).toEqual([OWNER_NAME, 'Botty', 'alpha', 'beta', 'carmen', 'main-a', 'main-agent'].sort())
  })

  it('the other tenant is offered only its own and the shared agents; the bot name (the main agent of the default tenant) drops out', async () => {
    const out = await callAs(await callerAuth('acme'), 'POST', generatePath('card-acme'))
    expect(out.status).toBe(200)
    expect(candidates()).toEqual([OWNER_NAME, 'carmen', 'main-b'].sort())
  })

  it('the admin gets the install-wide set: no candidate set is passed', async () => {
    const out = await callAs(await ADMIN_AUTH(), 'POST', generatePath('card-default'))
    expect(out.status).toBe(200)
    expect(generate.mock.calls[0][2]).toBeUndefined()
    const narrowed = await callAs(await ADMIN_AUTH(), 'POST', generatePath('card-acme', '?tenant=acme'))
    expect(narrowed.status).toBe(200)
    expect(generate.mock.calls[1][2]).toBeUndefined()
  })

  it('a failing agent lookup is a 500 and the LLM is not called (fail closed, no fall back to the install-wide set)', async () => {
    lookup.fail = true
    const out = await callAs(await callerAuth('default'), 'POST', generatePath('card-default'))
    expect(out.status).toBe(500)
    expect(out.body).toMatchObject({ error: 'internal_error' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('the admin does not depend on the lookup', async () => {
    lookup.fail = true
    const out = await callAs(await ADMIN_AUTH(), 'POST', generatePath('card-default'))
    expect(out.status).toBe(200)
    expect(lookup.calls).toEqual([])
  })

  it('a foreign card is a 404 and the LLM is not called', async () => {
    const out = await callAs(await callerAuth('default'), 'POST', generatePath('card-acme'))
    expect(out.status).toBe(404)
    expect(generate).not.toHaveBeenCalled()
  })

  it('the lookups of one request are shared: no agent is looked up twice', async () => {
    await callAs(await callerAuth('default'), 'POST', generatePath('card-default'))
    expect(new Set(lookup.calls).size).toBe(lookup.calls.length)
  })
})

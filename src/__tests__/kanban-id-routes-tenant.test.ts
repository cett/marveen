// Every kanban route that reaches a card by the id in its path must hold the tenant line for a non-admin
// caller: move, archive, unarchive, comments (read and write), events, tokens, labels (read, attach, detach),
// breakdown, children, subtree. A foreign id answers 404 exactly like a missing one and the row stays as it
// was; an own card keeps working; an admin keeps the cross-tenant reach. Real in-memory database, the gate
// chain of web.ts in miniature.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import {
  initDatabase, getDb, createTenant, insertApiToken, createKanbanCard, createLabel, addLabelToCard, archiveKanbanCard,
  addKanbanComment, getKanbanComments, getLabelsForCard, getKanbanCard,
} from '../db.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['alpha', 'beta'],
  isKnownAgent: (n: string) => ['alpha', 'beta', 'main-agent'].includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))
const generateBreakdown = vi.fn(async () => ({ subtasks: [{ title: 'generated', description: '', assignee: null, priority: 'normal' }] }))
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: (...a: unknown[]) => generateBreakdown(...(a as [])) }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)

// The gate of web.ts in miniature, from an already resolved principal.
async function callAs(auth: AuthResult, method: string, path: string, body?: unknown) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
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
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
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

async function tokenAuth(raw: string): Promise<AuthResult> {
  const req = { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
  return resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
}
const session = (role: 'admin' | 'agent' | 'read_only' | 'viewer', tenantId: string | null): AuthResult => ({ kind: 'session', user: `u-${role}`, role, tenantId })

const DEFAULT_CARD = 'card-default'
const ACME_CARD = 'card-acme'
const ACME_ARCHIVED = 'card-acme-archived'

const alpha = async () => tokenAuth('tok-alpha') // fleet_agent, tenant default
const acmeUser = () => session('agent', 'acme') // tenant user of acme
const admin = async () => tokenAuth('the-file-token')

const row = (id: string) => getDb().prepare('SELECT status, archived_at, dispatched_at FROM kanban_cards WHERE id = ?').get(id) as
  { status: string; archived_at: number | null; dispatched_at: number | null }

beforeEach(async () => {
  generateBreakdown.mockClear()
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  await insertApiToken({ tokenHash: sha('tok-alpha'), name: 'fleet:alpha', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'alpha' })
  await createKanbanCard({ id: DEFAULT_CARD, title: 'Default card', assignee: 'beta', tenant_id: 'default' })
  await createKanbanCard({ id: ACME_CARD, title: 'Acme card', assignee: 'beta', tenant_id: 'acme' })
  await createKanbanCard({ id: ACME_ARCHIVED, title: 'Acme archived', tenant_id: 'acme' })
  archiveKanbanCard(ACME_ARCHIVED)
  await createKanbanCard({ id: 'acme-child', title: 'Acme child', parent_id: ACME_CARD, tenant_id: 'acme' })
  await createKanbanCard({ id: 'default-child', title: 'Default child', parent_id: DEFAULT_CARD, tenant_id: 'default' })
  createLabel({ id: 'lbl-acme', name: 'acme-label', color: '#3b82f6', tenant_id: 'acme' })
  createLabel({ id: 'lbl-default', name: 'default-label', color: '#10b981', tenant_id: 'default' })
  addLabelToCard(ACME_CARD, 'lbl-acme')
  addKanbanComment(ACME_CARD, 'someone', 'secret acme comment')
})

type Case = { name: string; method: string; path: (id: string) => string; body?: unknown }

// Each case is expressed against a card id; the matrix runs it against an own and a foreign card.
const CASES: Case[] = [
  { name: 'POST move', method: 'POST', path: (id) => `/api/kanban/${id}/move`, body: { status: 'in_progress', sort_order: 1 } },
  { name: 'POST archive', method: 'POST', path: (id) => `/api/kanban/${id}/archive` },
  { name: 'POST unarchive', method: 'POST', path: (id) => `/api/kanban/${id}/unarchive` },
  { name: 'GET comments', method: 'GET', path: (id) => `/api/kanban/${id}/comments` },
  { name: 'POST comments', method: 'POST', path: (id) => `/api/kanban/${id}/comments`, body: { author: 'x', content: 'hello' } },
  { name: 'GET events', method: 'GET', path: (id) => `/api/kanban/${id}/events` },
  { name: 'GET tokens', method: 'GET', path: (id) => `/api/kanban/${id}/tokens` },
  { name: 'GET labels', method: 'GET', path: (id) => `/api/kanban/${id}/labels` },
  { name: 'POST labels', method: 'POST', path: (id) => `/api/kanban/${id}/labels`, body: { labelId: 'lbl-acme' } },
  { name: 'DELETE labels/:labelId', method: 'DELETE', path: (id) => `/api/kanban/${id}/labels/lbl-acme` },
  { name: 'POST breakdown', method: 'POST', path: (id) => `/api/kanban/${id}/breakdown` },
  { name: 'POST breakdown/accept', method: 'POST', path: (id) => `/api/kanban/${id}/breakdown/accept`, body: { subtasks: [{ title: 's', description: '', assignee: null, priority: 'normal' }] } },
  { name: 'PATCH parent', method: 'PATCH', path: (id) => `/api/kanban/${id}/parent`, body: { parent_id: null } },
  { name: 'GET children', method: 'GET', path: (id) => `/api/kanban/${id}/children` },
  { name: 'GET subtree', method: 'GET', path: (id) => `/api/kanban/${id}/subtree` },
]

describe("a foreign card id on a /api/kanban/:id/* route is a 404 for a non-admin caller", () => {
  for (const c of CASES) {
    it(`${c.name}: fleet token and tenant user get 404 on the other tenant's card`, async () => {
      expect((await callAs(await alpha(), c.method, c.path(ACME_CARD), c.body)).status).toBe(404)
      expect((await callAs(acmeUser(), c.method, c.path(DEFAULT_CARD), c.body)).status).toBe(404)
    })
  }

  it('GET /api/kanban/:id: a foreign card is a 404, an own card is read, an admin reads any', async () => {
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${ACME_CARD}`)).status).toBe(404)
    expect((await callAs(acmeUser(), 'GET', `/api/kanban/${DEFAULT_CARD}`)).status).toBe(404)
    const own = await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}`)
    expect(own.status).toBe(200)
    expect((own.body as { id: string }).id).toBe(DEFAULT_CARD)
    expect((await callAs(await admin(), 'GET', `/api/kanban/${ACME_CARD}`)).status).toBe(200)
  })

  it('the 404 body is the same as for a card that does not exist (no id probing)', async () => {
    const foreign = await callAs(await alpha(), 'GET', `/api/kanban/${ACME_CARD}/comments`)
    const missing = await callAs(await alpha(), 'GET', '/api/kanban/no-such-card/comments')
    expect(foreign).toEqual(missing)
    expect(foreign.status).toBe(404)
  })

  it('an archived foreign card is covered too', async () => {
    expect((await callAs(await alpha(), 'POST', `/api/kanban/${ACME_ARCHIVED}/unarchive`)).status).toBe(404)
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${ACME_ARCHIVED}/comments`)).status).toBe(404)
    expect(row(ACME_ARCHIVED).archived_at).not.toBeNull()
  })
})

describe('a foreign card is left exactly as it was', () => {
  it('move does not change the status and does not dispatch', async () => {
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_CARD}/move`, { status: 'in_progress', sort_order: 1 })
    expect(row(ACME_CARD)).toMatchObject({ status: 'planned', dispatched_at: null })
    const msgs = getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }
    expect(msgs.n).toBe(0)
  })

  it('archive and unarchive change nothing', async () => {
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_CARD}/archive`)
    expect(row(ACME_CARD).archived_at).toBeNull()
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_ARCHIVED}/unarchive`)
    expect(row(ACME_ARCHIVED).archived_at).not.toBeNull()
  })

  it('a comment is not written, the existing one is not readable', async () => {
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_CARD}/comments`, { author: 'x', content: 'intruder' })
    expect(getKanbanComments(ACME_CARD).map((c) => c.content)).toEqual(['secret acme comment'])
    const read = await callAs(await alpha(), 'GET', `/api/kanban/${ACME_CARD}/comments`)
    expect(JSON.stringify(read.body)).not.toContain('secret acme comment')
  })

  it('labels are not attached to or detached from it', async () => {
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_CARD}/labels`, { labelId: 'lbl-default' })
    await callAs(await alpha(), 'DELETE', `/api/kanban/${ACME_CARD}/labels/lbl-acme`)
    expect(getLabelsForCard(ACME_CARD).map((l) => l.id)).toEqual(['lbl-acme'])
  })

  it('breakdown never reaches the LLM with the foreign card\'s title', async () => {
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_CARD}/breakdown`)
    expect(generateBreakdown).not.toHaveBeenCalled()
  })

  it('a foreign card is not detached from its parent and gets no accepted subtasks', async () => {
    await callAs(await alpha(), 'PATCH', '/api/kanban/acme-child/parent', { parent_id: null })
    expect((getKanbanCard('acme-child') as { parent_id: string | null }).parent_id).toBe(ACME_CARD)
    await callAs(await alpha(), 'POST', `/api/kanban/${ACME_CARD}/breakdown/accept`, { subtasks: [{ title: 'intruder', description: '', assignee: null, priority: 'normal' }] })
    const kids = getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE parent_id = ?').get(ACME_CARD) as { n: number }
    expect(kids.n).toBe(1)
    expect(getKanbanComments(ACME_CARD).map((c) => c.content)).toEqual(['secret acme comment'])
  })

  it('children and subtree do not list the foreign tree', async () => {
    for (const p of ['children', 'subtree']) {
      const r = await callAs(await alpha(), 'GET', `/api/kanban/${ACME_CARD}/${p}`)
      expect(JSON.stringify(r.body)).not.toContain('Acme child')
    }
  })
})

describe('move: the orderedIds column list is cut down to the caller\'s own tenant', () => {
  const sortOrder = (id: string) => (getDb().prepare('SELECT sort_order FROM kanban_cards WHERE id = ?').get(id) as { sort_order: number }).sort_order

  it("a foreign card id in orderedIds keeps its sort_order, the own cards are renumbered", async () => {
    await createKanbanCard({ id: 'default-b', title: 'Default b', tenant_id: 'default' })
    getDb().prepare('UPDATE kanban_cards SET sort_order = 777 WHERE id = ?').run(ACME_CARD)
    const res = await callAs(await alpha(), 'POST', `/api/kanban/${DEFAULT_CARD}/move`, {
      status: 'waiting', sort_order: 0, orderedIds: ['default-b', ACME_CARD, DEFAULT_CARD],
    })
    expect(res.status).toBe(200)
    expect(sortOrder(ACME_CARD)).toBe(777)
    expect(sortOrder('default-b')).toBe(0)
    expect(sortOrder(DEFAULT_CARD)).toBe(1)
  })

  it('an admin renumbers a list that crosses tenants, as before', async () => {
    getDb().prepare('UPDATE kanban_cards SET sort_order = 777 WHERE id = ?').run(ACME_CARD)
    await callAs(await admin(), 'POST', `/api/kanban/${DEFAULT_CARD}/move`, { status: 'waiting', sort_order: 0, orderedIds: [DEFAULT_CARD, ACME_CARD] })
    expect(sortOrder(ACME_CARD)).toBe(1)
  })
})

describe('PATCH /parent and breakdown/accept: the references and the tenant of what is created', () => {
  const tree = (id: string) => getDb().prepare('SELECT parent_id, tenant_id FROM kanban_cards WHERE id = ?').get(id) as { parent_id: string | null; tenant_id: string }

  it("an own card cannot be moved under another tenant's card (404, unchanged)", async () => {
    expect((await callAs(await alpha(), 'PATCH', `/api/kanban/${DEFAULT_CARD}/parent`, { parent_id: ACME_CARD })).status).toBe(404)
    expect((await callAs(acmeUser(), 'PATCH', `/api/kanban/${ACME_CARD}/parent`, { parent_id: DEFAULT_CARD })).status).toBe(404)
    expect(tree(DEFAULT_CARD).parent_id).toBeNull()
    expect(tree(ACME_CARD).parent_id).toBeNull()
  })

  it('an own card moves under an own parent and detaches again (200); an admin may cross', async () => {
    await createKanbanCard({ id: 'parent-default', title: 'P', tenant_id: 'default' })
    expect((await callAs(await alpha(), 'PATCH', `/api/kanban/${DEFAULT_CARD}/parent`, { parent_id: 'parent-default' })).status).toBe(200)
    expect(tree(DEFAULT_CARD).parent_id).toBe('parent-default')
    expect((await callAs(await alpha(), 'PATCH', `/api/kanban/${DEFAULT_CARD}/parent`, { parent_id: null })).status).toBe(200)
    expect((await callAs(await admin(), 'PATCH', `/api/kanban/${ACME_CARD}/parent`, { parent_id: 'parent-default' })).status).toBe(200)
  })

  it('the subtasks of an accepted breakdown carry the tenant of the card they hang under', async () => {
    const subtasks = { subtasks: [{ title: 'sub', description: '', assignee: null, priority: 'normal' }] }
    expect((await callAs(acmeUser(), 'POST', `/api/kanban/${ACME_CARD}/breakdown/accept`, subtasks)).status).toBe(200)
    const kids = getDb().prepare("SELECT tenant_id FROM kanban_cards WHERE parent_id = ? AND title = 'sub'").all(ACME_CARD) as Array<{ tenant_id: string }>
    expect(kids).toEqual([{ tenant_id: 'acme' }])
  })
})

describe('POST /api/kanban: a parent_id in the body is held to the caller\'s tenant', () => {
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n

  it("a card cannot be created under another tenant's card (404, nothing created)", async () => {
    const before = count()
    expect((await callAs(await alpha(), 'POST', '/api/kanban', { title: 'sneaky', parent_id: ACME_CARD })).status).toBe(404)
    expect((await callAs(acmeUser(), 'POST', '/api/kanban', { title: 'sneaky', parent_id: DEFAULT_CARD })).status).toBe(404)
    expect(count()).toBe(before)
  })

  it('under an own card it is created in the caller\'s tenant (200)', async () => {
    const res = await callAs(await alpha(), 'POST', '/api/kanban', { title: 'child', parent_id: DEFAULT_CARD })
    expect(res.status).toBe(200)
    const created = getDb().prepare('SELECT tenant_id, parent_id FROM kanban_cards WHERE id = ?').get((res.body as { id: string }).id)
    expect(created).toEqual({ tenant_id: 'default', parent_id: DEFAULT_CARD })
  })

  it('without a parent_id nothing changes, and an admin keeps the cross-tenant reach', async () => {
    expect((await callAs(await alpha(), 'POST', '/api/kanban', { title: 'plain' })).status).toBe(200)
    expect((await callAs(await admin(), 'POST', '/api/kanban', { title: 'admin child', parent_id: ACME_CARD })).status).toBe(200)
  })
})

// A card whose id is the route word `labels` (the create route used to take the id from the body, and an import
// can carry one). The label registry lives under the same prefix, so the path-id gate must not wave `labels`
// through for the card routes.
describe('a card with the id "labels" is held to its tenant like any other card', () => {
  beforeEach(async () => {
    await createKanbanCard({ id: 'labels', title: 'Acme labels card', tenant_id: 'acme' })
    addKanbanComment('labels', 'someone', 'secret labels comment')
    // A label on the card, so that a detach through the loose registry shape (DELETE
    // /api/kanban/labels/labels/<labelId>, which is a card route) would have something to remove.
    addLabelToCard('labels', 'lbl-acme')
  })

  for (const c of CASES) {
    it(`${c.name}: a default-tenant token gets 404 for the acme card "labels"`, async () => {
      expect((await callAs(await alpha(), c.method, c.path('labels'), c.body)).status).toBe(404)
    })
  }

  it('the foreign card is left as it was', async () => {
    const read = await callAs(await alpha(), 'GET', '/api/kanban/labels/comments')
    expect(JSON.stringify(read.body)).not.toContain('secret labels comment')
    await callAs(await alpha(), 'POST', '/api/kanban/labels/archive')
    await callAs(await alpha(), 'POST', '/api/kanban/labels/comments', { author: 'x', content: 'intruder' })
    expect(getKanbanCard('labels')?.archived_at ?? null).toBeNull()
    expect(getKanbanComments('labels').map((x) => x.content)).toEqual(['secret labels comment'])
  })

  it('a label is neither detached from nor attached to the foreign card', async () => {
    const detach = await callAs(await alpha(), 'DELETE', '/api/kanban/labels/labels/lbl-acme')
    expect(detach.status).toBe(404)
    const attach = await callAs(await alpha(), 'POST', '/api/kanban/labels/labels', { labelId: 'lbl-default' })
    expect(attach.status).toBe(404)
    expect(getLabelsForCard('labels').map((l) => l.id)).toEqual(['lbl-acme'])
  })

  it('GET /api/kanban/labels is the label registry list, tenant-filtered, never the card', async () => {
    const res = await callAs(await alpha(), 'GET', '/api/kanban/labels')
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('Acme labels card')
    expect(JSON.stringify(res.body)).not.toContain('acme-label')
  })

  it('the owning tenant and an admin reach it', async () => {
    expect((await callAs(acmeUser(), 'GET', '/api/kanban/labels/comments')).status).toBe(200)
    expect((await callAs(await admin(), 'GET', '/api/kanban/labels/comments')).status).toBe(200)
  })

  it('the label registry still answers PUT/DELETE /api/kanban/labels/:labelId, also for a label id that is a card-route word', async () => {
    // The caller's tenant (default) has no card "labels": without the registry exemption the gate would read
    // these as card routes of a card "labels" and answer 404.
    const defaultUser = session('agent', 'default')
    createLabel({ id: 'comments', name: 'comments-label', color: '#3b82f6', tenant_id: 'default' })
    createLabel({ id: 'archive', name: 'archive-label', color: '#3b82f6', tenant_id: 'default' })
    expect((await callAs(defaultUser, 'PUT', '/api/kanban/labels/comments', { name: 'renamed' })).status).toBe(200)
    expect((await callAs(defaultUser, 'DELETE', '/api/kanban/labels/archive')).status).toBe(200)
    expect((await callAs(defaultUser, 'DELETE', '/api/kanban/labels/comments')).status).toBe(200)
  })
})

describe('POST /api/kanban never takes the card id from the body', () => {
  it('an id in the body is ignored: the card gets a generated id, which is the one returned', async () => {
    const res = await callAs(await alpha(), 'POST', '/api/kanban', { id: 'labels', title: 'picked id' })
    expect(res.status).toBe(200)
    const id = (res.body as { id: string }).id
    expect(id).not.toBe('labels')
    expect(id).toMatch(/^[0-9a-f]{8}$/)
    expect(getKanbanCard('labels')).toBeUndefined()
    // the id the response names is the stored one: the card is there under it, and readable
    expect(getKanbanCard(id)?.title).toBe('picked id')
    const read = await callAs(await alpha(), 'GET', `/api/kanban/${id}`)
    expect(read.status).toBe(200)
    expect((read.body as { id: string; title: string })).toMatchObject({ id, title: 'picked id' })
  })

  it('an id that exists in another tenant answers like any other create (no probing, nothing overwritten)', async () => {
    const res = await callAs(await alpha(), 'POST', '/api/kanban', { id: ACME_CARD, title: 'probe' })
    expect(res.status).toBe(200)
    expect((res.body as { id: string }).id).not.toBe(ACME_CARD)
    expect(getKanbanCard(ACME_CARD)?.title).toBe('Acme card')
  })
})

describe('an own card keeps working', () => {
  it('move, comments, labels, events, children and subtree answer 200 for the owning tenant', async () => {
    expect((await callAs(await alpha(), 'POST', `/api/kanban/${DEFAULT_CARD}/move`, { status: 'waiting', sort_order: 1 })).status).toBe(200)
    expect(row(DEFAULT_CARD).status).toBe('waiting')
    expect((await callAs(await alpha(), 'POST', `/api/kanban/${DEFAULT_CARD}/comments`, { author: 'a', content: 'mine' })).status).toBe(200)
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}/comments`)).status).toBe(200)
    expect((await callAs(await alpha(), 'POST', `/api/kanban/${DEFAULT_CARD}/labels`, { labelId: 'lbl-default' })).status).toBe(200)
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}/labels`)).status).toBe(200)
    expect((await callAs(await alpha(), 'DELETE', `/api/kanban/${DEFAULT_CARD}/labels/lbl-default`)).status).toBe(200)
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}/events`)).status).toBe(200)
    // Tokens per card is admin only (the rows are keyed by agent, not tenant): an own card is 403 for a fleet
    // token, 200 for an admin.
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}/tokens`)).status).toBe(403)
    expect((await callAs(await admin(), 'GET', `/api/kanban/${DEFAULT_CARD}/tokens`)).status).toBe(200)
    expect((await callAs(await admin(), 'GET', `/api/kanban/${ACME_CARD}/tokens`)).status).toBe(200)
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}/children`)).status).toBe(200)
    expect((await callAs(await alpha(), 'GET', `/api/kanban/${DEFAULT_CARD}/subtree`)).status).toBe(200)
  })

  it('a tenant user reaches the archived card of its own tenant (unarchive 200)', async () => {
    expect((await callAs(acmeUser(), 'POST', `/api/kanban/${ACME_ARCHIVED}/unarchive`)).status).toBe(200)
    expect(row(ACME_ARCHIVED).archived_at).toBeNull()
  })

  it('archive of an own card works', async () => {
    expect((await callAs(acmeUser(), 'POST', `/api/kanban/${ACME_CARD}/archive`)).status).toBe(200)
    expect(row(ACME_CARD).archived_at).not.toBeNull()
  })

  it('breakdown of an own card reaches the generator', async () => {
    expect((await callAs(acmeUser(), 'POST', `/api/kanban/${ACME_CARD}/breakdown`)).status).toBe(409) // it already has a child
    await createKanbanCard({ id: 'lonely', title: 'Lonely', tenant_id: 'acme' })
    expect((await callAs(acmeUser(), 'POST', '/api/kanban/lonely/breakdown')).status).toBe(200)
    expect(generateBreakdown).toHaveBeenCalledTimes(1)
  })
})

describe('an admin keeps the cross-tenant reach', () => {
  it('reads and writes a card of any tenant', async () => {
    expect((await callAs(await admin(), 'GET', `/api/kanban/${ACME_CARD}/comments`)).status).toBe(200)
    expect((await callAs(await admin(), 'POST', `/api/kanban/${ACME_CARD}/comments`, { author: 'root', content: 'from admin' })).status).toBe(200)
    expect((await callAs(await admin(), 'POST', `/api/kanban/${ACME_CARD}/move`, { status: 'waiting', sort_order: 1 })).status).toBe(200)
    expect(getKanbanCard(ACME_CARD)?.status).toBe('waiting')
    expect((await callAs(await admin(), 'POST', `/api/kanban/${ACME_CARD}/archive`)).status).toBe(200)
    expect((await callAs(await admin(), 'POST', `/api/kanban/${ACME_CARD}/unarchive`)).status).toBe(200)
    expect((await callAs(await admin(), 'GET', `/api/kanban/${ACME_CARD}/subtree`)).status).toBe(200)
  })
})

describe('the label registry paths are not mistaken for a card id', () => {
  it('PUT/DELETE /api/kanban/labels/:id still reach the registry for a tenant user', async () => {
    expect((await callAs(acmeUser(), 'PUT', '/api/kanban/labels/lbl-acme', { name: 'renamed' })).status).toBe(200)
    expect((await callAs(acmeUser(), 'DELETE', '/api/kanban/labels/lbl-acme')).status).toBe(200)
    expect((await callAs(acmeUser(), 'GET', '/api/kanban/labels')).status).toBe(200)
  })
})

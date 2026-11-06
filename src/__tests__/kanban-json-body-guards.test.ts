// Kanban: a request body that is valid JSON but not an OBJECT (null, a number, a string, a boolean, an array) is a
// 400 invalid_value (field body) on every route that reads a JSON object body, and nothing is written. Before the
// guard, `null` made the route throw a TypeError (the top-level handler's 500), a number / string / boolean made
// POST and PUT /api/kanban throw the same, and on the label update and the reparent route every one of them was a
// silent success (the reparent of `5` moved the card to the root). Also: the X-Agent-Id a claim takes its claimant
// from (self_declared only) is at most MAX_ASSIGNEE_LENGTH characters. Real in-memory database, the real routes.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { getServedTenantIds as realGetServedTenantIds } from '../db/agents.js'
import { initDatabase, getDb, createKanbanCard, createLabel, createTenant } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { MAX_ASSIGNEE_LENGTH } from '../web/routes/kanban-assignee-tenant.js'
import { isInvalidJsonBodyError, json, parseJsonObject } from '../web/http-helpers.js'
import type { RouteContext } from '../web/routes/types.js'

const servedLookups = vi.hoisted(() => ({ count: 0 }))
vi.mock('../db/agents.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/agents.js')>()
  return { ...real, getServedTenantIds: (name: string) => { servedLookups.count++; return real.getServedTenantIds(name) } }
})
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))
void realGetServedTenantIds

interface Reply { status: number; body: any }
interface CtxOpts { role?: string; tenantId?: string | null; tokenAgentId?: string; agentId?: string; auth?: unknown }

// The shape of the top-level catch in web.ts: the route throws, the catch classifies (400 parse_error / 500).
async function callRaw(method: string, path: string, raw: string | undefined, o: CtxOpts = {}): Promise<Reply> {
  const authReq = { headers: { authorization: 'Bearer the-file-token' } } as unknown as http.IncomingMessage
  const auth = await resolveAuth(authReq, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', Buffer.from(raw ?? '')); req.emit('end') })
  const out: Reply = { status: 200, body: {} }
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
  if (!decision.allowed) return { status: decision.status, body: { error: 'denied' } }
  const ctx = {
    req, res, path: url.pathname, method, url,
    role: o.role ?? resolveRole(auth), tenantId: o.tenantId !== undefined ? o.tenantId : resolveTenantId(auth),
    tokenAgentId: o.tokenAgentId, agentId: o.agentId, auth: o.auth,
  } as unknown as RouteContext
  try {
    await tryHandleKanban(ctx)
  } catch (err) {
    if (isInvalidJsonBodyError(err, req)) json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
    else json(res, { error: 'internal_error', hint: 'Szerver hiba' }, 500)
  }
  return out
}

// Every row of every kanban / label / audit table: what a request that must not write leaves untouched.
function snapshot(): string {
  const db = getDb()
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'kanban%' OR name LIKE '%label%' OR name = 'agent_audit_log') AND name NOT LIKE '%fts%' ORDER BY name",
  ).all() as { name: string }[]).map((t) => t.name)
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
}

// name, method, path -- the seven routes that read a JSON object body, and the accept route that already guarded.
const ROUTES: Array<[string, string, string]> = [
  ['label create', 'POST', '/api/kanban/labels'],
  ['label update', 'PUT', '/api/kanban/labels/l1'],
  ['label attach', 'POST', '/api/kanban/c1/labels'],
  ['card create', 'POST', '/api/kanban'],
  ['card update', 'PUT', '/api/kanban/c1'],
  ['comment', 'POST', '/api/kanban/c1/comments'],
  ['parent', 'PATCH', '/api/kanban/c1/parent'],
  ['accept', 'POST', '/api/kanban/parent/breakdown/accept'],
]
const NOT_AN_OBJECT = ['null', '5', '"x"', '[]', 'true']
const CASES = ROUTES.flatMap(([name, method, path]) => NOT_AN_OBJECT.map((raw) => [name, method, path, raw] as const))

beforeEach(async () => {
  servedLookups.count = 0
  initDatabase(':memory:')
  await createKanbanCard({ id: 'parent', title: 'Parent' })
  await createKanbanCard({ id: 'c1', title: 'Card' })
  await createLabel({ id: 'l1', name: 'L', color: '#f00' })
})

describe('a body that is valid JSON but not an object', () => {
  it.each(CASES)('%s: %s %s %s -> 400 invalid_value on the body, nothing written', async (_name, method, path, raw) => {
    const before = snapshot()
    const res = await callRaw(method, path, raw)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_value', field: 'body', hint: 'The body must be a JSON object' })
    expect(snapshot()).toBe(before)
  })

  it('a reparent with a non-object body does not move the card to the root', async () => {
    await callRaw('PATCH', '/api/kanban/c1/parent', JSON.stringify({ parent_id: 'parent' }))
    const parentOf = () => (getDb().prepare('SELECT parent_id FROM kanban_cards WHERE id = ?').get('c1') as { parent_id: string | null }).parent_id
    expect(parentOf()).toBe('parent')
    expect((await callRaw('PATCH', '/api/kanban/c1/parent', '5')).status).toBe(400)
    expect(parentOf()).toBe('parent')
  })
})

describe('the answers an object body gets are the ones develop gave (pinned before the change)', () => {
  // `{}` is an object: it reaches the route's own checks. Recorded on develop; the empty card create was a 500 there (the
  // insert failed on the missing title) and is a 400 `required` on `title` since the title check (see the title block below).
  const EMPTY_OBJECT: Array<[string, string, string, number, string | undefined, string | undefined]> = [
    ['label create', 'POST', '/api/kanban/labels', 400, 'required', 'name'],
    ['label update', 'PUT', '/api/kanban/labels/l1', 200, undefined, undefined],
    ['label attach', 'POST', '/api/kanban/c1/labels', 400, 'required', 'labelId'],
    ['card create', 'POST', '/api/kanban', 400, 'required', 'title'],
    ['card update', 'PUT', '/api/kanban/c1', 200, undefined, undefined],
    ['comment', 'POST', '/api/kanban/c1/comments', 400, 'required', undefined],
    ['parent', 'PATCH', '/api/kanban/c1/parent', 200, undefined, undefined],
    ['accept', 'POST', '/api/kanban/parent/breakdown/accept', 400, 'required', 'subtasks'],
  ]
  it.each(EMPTY_OBJECT)('%s: {} -> %i', async (_name, method, path, status, error, field) => {
    const res = await callRaw(method, path, '{}')
    expect(res.status).toBe(status)
    expect(res.body.error).toBe(error)
    expect(res.body.field).toBe(field)
  })

  it.each(ROUTES)('%s: a body that is not JSON at all is still the 400 parse_error, nothing written', async (_name, method, path) => {
    const before = snapshot()
    const res = await callRaw(method, path, '{"a":')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'parse_error', hint: 'Invalid JSON body' })
    expect(snapshot()).toBe(before)
  })

  it('valid bodies still work on every route', async () => {
    const label = await callRaw('POST', '/api/kanban/labels', JSON.stringify({ name: ' New ' }))
    expect(label.status).toBe(200)
    expect(label.body).toMatchObject({ name: 'New' })
    expect((await callRaw('PUT', '/api/kanban/labels/l1', JSON.stringify({ name: 'Renamed' }))).body).toEqual({ ok: true })
    expect((await callRaw('POST', '/api/kanban/c1/labels', JSON.stringify({ labelId: 'l1' }))).status).toBe(200)
    const card = await callRaw('POST', '/api/kanban', JSON.stringify({ title: 'Made', due_date: '2030-01-02' }))
    expect(card.status).toBe(200)
    expect(card.body).toMatchObject({ ok: true })
    expect((getDb().prepare('SELECT title FROM kanban_cards WHERE id = ?').get(card.body.id) as { title: string }).title).toBe('Made')
    expect((await callRaw('PUT', '/api/kanban/c1', JSON.stringify({ title: 'Edited' }))).body).toEqual({ ok: true })
    expect((await callRaw('POST', '/api/kanban/c1/comments', JSON.stringify({ author: 'bot', content: 'note' }))).body).toMatchObject({ card_id: 'c1', content: 'note' })
    expect((await callRaw('PATCH', '/api/kanban/c1/parent', JSON.stringify({ parent_id: 'parent' }))).body).toEqual({ ok: true })
    const accept = await callRaw('POST', '/api/kanban/parent/breakdown/accept', JSON.stringify({ subtasks: [{ title: 'S', description: '', assignee: null, priority: 'normal' }] }))
    expect(accept.status).toBe(200)
  })
})

describe('parseJsonObject', () => {
  it.each([['{}', {}], ['{"a":1}', { a: 1 }]])('%s is an object', (text, value) => {
    expect(parseJsonObject(text)).toEqual({ ok: true, value })
  })
  it.each(['null', '5', '"x"', '[]', '[{"a":1}]', 'true', 'false'])('%s is not', (text) => {
    expect(parseJsonObject(text)).toEqual({ ok: false })
  })
  it('text that is not JSON throws the SyntaxError for the top-level handler', () => {
    expect(() => parseJsonObject('{"a":')).toThrow(SyntaxError)
    expect(() => parseJsonObject('')).toThrow(SyntaxError)
  })
})

describe('POST /api/kanban/:id/claim -- the X-Agent-Id length', () => {
  const CARD = 'claim-card'
  const assignee = () => (getDb().prepare('SELECT assignee FROM kanban_cards WHERE id = ?').get(CARD) as { assignee: string | null }).assignee
  const auditRows = () => (getDb().prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'kanban'").get() as { n: number }).n
  const LONG = (n: number) => 'x'.repeat(n)

  beforeEach(async () => {
    await createTenant('tenant-x', 'Tenant X')
    await createKanbanCard({ id: CARD, title: 'Free card', tenant_id: 'tenant-x' })
  })

  it('exactly MAX_ASSIGNEE_LENGTH characters pass: the claimant is that free-text name', async () => {
    const name = LONG(MAX_ASSIGNEE_LENGTH)
    const res = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role: 'admin', tenantId: null, agentId: name })
    expect(res.status).toBe(200)
    expect(assignee()).toBe(name)
  })

  it('a tenant-bound caller with exactly MAX_ASSIGNEE_LENGTH characters still gets the tenant verdict (free text passes)', async () => {
    const res = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role: 'agent', tenantId: 'tenant-x', agentId: LONG(MAX_ASSIGNEE_LENGTH) })
    expect(res.status).toBe(200)
    expect(servedLookups.count).toBeGreaterThan(0)
  })

  it.each([['admin', null], ['agent', 'tenant-x']] as const)('one character more is a 400 for a %s caller: nothing is written, no lookup is made', async (role, tenantId) => {
    const audits = auditRows()
    const res = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role, tenantId, agentId: LONG(MAX_ASSIGNEE_LENGTH + 1) })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_value', field: 'agent', hint: `X-Agent-Id must be at most ${MAX_ASSIGNEE_LENGTH} characters` })
    expect(assignee()).toBeNull()
    expect(auditRows()).toBe(audits)
    expect(servedLookups.count).toBe(0)
  })

  it('the agent of a token is who the caller is: a long header next to it does not matter (no cap on the token path)', async () => {
    const res = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role: 'admin', tenantId: null, tokenAgentId: 'agent-a', agentId: LONG(600) })
    expect(res.status).toBe(200)
    expect(assignee()).toBe('agent-a')
  })

  it('a signed-in user claims as that user: the header is not used, so its length does not matter either', async () => {
    const res = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role: 'admin', tenantId: null, auth: { kind: 'session', user: 'alice' }, agentId: LONG(600) })
    expect(res.status).toBe(200)
    expect(assignee()).toBe('alice')
  })

  it('the cap is on what the caller WRITES (the header), not on who it is: a long signed-in user or token agent name still claims', async () => {
    const user = LONG(MAX_ASSIGNEE_LENGTH + 1)
    const session = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role: 'admin', tenantId: null, auth: { kind: 'session', user } })
    expect(session.status).toBe(200)
    expect(assignee()).toBe(user)
    await createKanbanCard({ id: 'second-card', title: 'Second', tenant_id: 'tenant-x' })
    const agent = LONG(MAX_ASSIGNEE_LENGTH + 1)
    const token = await callRaw('POST', '/api/kanban/second-card/claim', undefined, { role: 'admin', tenantId: null, tokenAgentId: agent })
    expect(token.status).toBe(200)
  })

  it('an empty header keeps the current answer: the claim needs an agent', async () => {
    const res = await callRaw('POST', `/api/kanban/${CARD}/claim`, undefined, { role: 'admin', tenantId: null })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'required', field: 'agent' })
  })
})

describe('POST /api/kanban -- the title is required', () => {
  const cardCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n
  const titleOf = (id: string) => (getDb().prepare('SELECT title FROM kanban_cards WHERE id = ?').get(id) as { title: string }).title
  const ADMIN = { role: 'admin', tenantId: null } as const
  const TENANT = { role: 'agent', tenantId: 'tenant-x' } as const

  beforeEach(async () => {
    await createTenant('tenant-x', 'Tenant X')
  })

  // Absent, null, empty and whitespace-only (everything JS String.trim removes: tab, line feed, NBSP, em space) are `required`.
  const REQUIRED: Array<[string, Record<string, unknown>]> = [
    ['no title', {}],
    ['no title, other fields', { description: 'x', assignee: 'agent-a' }],
    ['null', { title: null }],
    ['empty string', { title: '' }],
    ['spaces', { title: '   ' }],
    ['tab and line feed', { title: '\t\n' }],
    ['no-break space', { title: '\u00a0' }],
    ['em space', { title: '\u2003' }],
  ]
  it.each(REQUIRED)('%s -> 400 required on title, nothing written (admin and tenant caller alike)', async (_name, body) => {
    for (const who of [ADMIN, TENANT]) {
      const before = snapshot()
      const res = await callRaw('POST', '/api/kanban', JSON.stringify(body), who)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'required', field: 'title', hint: 'title is required and must not be blank' })
      expect(snapshot()).toBe(before)
    }
  })

  // Any other non-string is `invalid_value`: a card with a numeric / array / object title must not be written either.
  const NOT_A_STRING: Array<[string, unknown]> = [['number', 5], ['zero', 0], ['true', true], ['false', false], ['array', []], ['object', {}]]
  it.each(NOT_A_STRING)('title as %s -> 400 invalid_value on title, nothing written', async (_name, title) => {
    const before = snapshot()
    const res = await callRaw('POST', '/api/kanban', JSON.stringify({ title }), ADMIN)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_value', field: 'title', hint: 'title must be a string' })
    expect(snapshot()).toBe(before)
  })

  it('a refused create writes no card, no comment, no label row and no audit row', async () => {
    const cards = cardCount()
    const before = snapshot()
    await callRaw('POST', '/api/kanban', '{}', { ...ADMIN, auth: { kind: 'session', user: 'alice' } })
    expect(cardCount()).toBe(cards)
    expect(snapshot()).toBe(before)
  })

  it('a usable title is a 200 and is stored exactly as sent (no trim on write)', async () => {
    const plain = await callRaw('POST', '/api/kanban', JSON.stringify({ title: 'x' }), ADMIN)
    expect(plain.status).toBe(200)
    expect(titleOf(plain.body.id)).toBe('x')
    const padded = await callRaw('POST', '/api/kanban', JSON.stringify({ title: '  padded  ' }), TENANT)
    expect(padded.status).toBe(200)
    expect(titleOf(padded.body.id)).toBe('  padded  ')
  })

  it('observed, not promised: a title of only zero-width characters is not blank to String.trim and creates a card; there is no length cap', async () => {
    const hidden = await callRaw('POST', '/api/kanban', JSON.stringify({ title: '\u200b' }), ADMIN)
    expect(hidden.status).toBe(200)
    const long = await callRaw('POST', '/api/kanban', JSON.stringify({ title: 'y'.repeat(5000) }), ADMIN)
    expect(long.status).toBe(200)
    expect(titleOf(long.body.id)).toHaveLength(5000)
  })

  // The title check runs last: the answers the other fields gave before it are the ones they still give.
  it('an invalid due_date next to a missing title is still the due_date answer', async () => {
    const res = await callRaw('POST', '/api/kanban', JSON.stringify({ due_date: 'not-a-date' }), ADMIN)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_value', field: 'due_date' })
  })

  it('a foreign parent_id next to a missing title is still the 404 of the parent, for a tenant caller', async () => {
    await createTenant('tenant-y', 'Tenant Y')
    await createKanbanCard({ id: 'foreign-parent', title: 'Foreign', tenant_id: 'tenant-y' })
    const res = await callRaw('POST', '/api/kanban', JSON.stringify({ parent_id: 'foreign-parent' }), TENANT)
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'not_found', field: 'parent_id' })
  })

  it('a non-string assignee next to a missing title is still the assignee answer', async () => {
    const res = await callRaw('POST', '/api/kanban', JSON.stringify({ assignee: 5 }), ADMIN)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_value', field: 'assignee' })
  })

  it('PUT /api/kanban/:id stays a partial update: a body without a title is a 200 and the title is kept', async () => {
    const res = await callRaw('PUT', '/api/kanban/c1', JSON.stringify({ description: 'changed' }), ADMIN)
    expect(res.status).toBe(200)
    expect(titleOf('c1')).toBe('Card')
  })

  it('the breakdown accept route is another path: its subtask titles are not covered by this check', async () => {
    const res = await callRaw('POST', '/api/kanban/parent/breakdown/accept', JSON.stringify({ subtasks: [{ title: 'S', description: '', assignee: null, priority: 'normal' }] }), ADMIN)
    expect(res.status).toBe(200)
  })
})

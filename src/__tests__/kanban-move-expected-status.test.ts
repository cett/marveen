// POST /api/kanban/:id/move takes an optional `expected_status`: the move only happens if the card is
// still in that status (compare-and-set). A caller that decided from a stale read gets 409
// `status_conflict` with the current status and nothing is written: no status change, no audit event, no
// dispatch, no parent update, and no renumbering of the target column. Without the field the move is
// unconditional, as before. Real in-memory database and the real route, the gate chain of web.ts in
// miniature (same harness as kanban-id-routes-tenant.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import { initDatabase, getDb, createTenant, insertApiToken, createKanbanCard, moveKanbanCard } from '../db.js'
import { db } from '../db/connection.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { checkErrorResponse } from '../api-error-catalog.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a', 'agent-b'],
  isKnownAgent: (n: string) => ['agent-a', 'agent-b', 'main-agent'].includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)

async function callAs(auth: AuthResult, method: string, path: string, body?: unknown, rawBody?: string) {
  const buf = rawBody !== undefined ? Buffer.from(rawBody) : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
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

const agentA = async () => tokenAuth('tok-agent-a') // fleet_agent, tenant default
const admin = async () => tokenAuth('the-file-token')
const tenantUser: AuthResult = { kind: 'session', user: 'u-agent', role: 'agent', tenantId: 'tenant-x' }

const CARD = 'card-1'
const OTHER = 'card-2'
const THIRD = 'card-3'
const FOREIGN = 'card-foreign'

const move = async (id: string, body: unknown, auth?: AuthResult) => callAs(auth ?? await admin(), 'POST', `/api/kanban/${id}/move`, body)
const card = (id: string) => getDb().prepare('SELECT status, sort_order, updated_at, dispatched_at FROM kanban_cards WHERE id = ?').get(id) as
  { status: string; sort_order: number; updated_at: number; dispatched_at: number | null }
const events = (id: string) => getDb().prepare('SELECT from_status, to_status, actor FROM kanban_card_events WHERE card_id = ? ORDER BY id').all(id) as
  { from_status: string; to_status: string; actor: string | null }[]
const sentMessages = () => (getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n

beforeEach(async () => {
  initDatabase(':memory:')
  createTenant('tenant-x', 'Tenant X')
  await insertApiToken({ tokenHash: sha('tok-agent-a'), name: 'fleet:agent-a', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'agent-a' })
  await createKanbanCard({ id: CARD, title: 'Card one', assignee: 'agent-b', tenant_id: 'default' })
  await createKanbanCard({ id: OTHER, title: 'Card two', assignee: 'agent-b', tenant_id: 'default' })
  await createKanbanCard({ id: THIRD, title: 'Card three', assignee: 'agent-b', tenant_id: 'default' })
  await createKanbanCard({ id: FOREIGN, title: 'Foreign card', assignee: 'agent-b', tenant_id: 'tenant-x' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('expected_status matches', () => {
  it('moves the card, writes exactly one event whose from is the expected status', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run(CARD)
    const res = await move(CARD, { status: 'done', actor: 'agent-b', expected_status: 'waiting' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(card(CARD).status).toBe('done')
    expect(events(CARD)).toEqual([{ from_status: 'waiting', to_status: 'done', actor: 'agent-b' }])
  })

  it('works through the orderedIds path too (renumber runs on a successful move)', async () => {
    const res = await move(CARD, { status: 'waiting', sort_order: 1, orderedIds: [OTHER, CARD, THIRD], expected_status: 'planned' })
    expect(res.status).toBe(200)
    expect(card(OTHER).sort_order).toBe(0)
    expect(card(CARD).sort_order).toBe(1)
    expect(card(THIRD).sort_order).toBe(2)
    expect(events(CARD)).toHaveLength(1)
  })

  it('expected_status equal to the target is a pure reorder: 200, sort_order changes, no event', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting', sort_order = 5 WHERE id = ?").run(CARD)
    const res = await move(CARD, { status: 'waiting', sort_order: 2, expected_status: 'waiting' })
    expect(res.status).toBe(200)
    expect(card(CARD)).toMatchObject({ status: 'waiting', sort_order: 2 })
    expect(events(CARD)).toEqual([])
  })

  it('a move into in_progress still dispatches (the positive control for the no-dispatch check below)', async () => {
    const res = await move(CARD, { status: 'in_progress', actor: 'agent-a', expected_status: 'planned' })
    expect(res.status).toBe(200)
    expect(card(CARD).dispatched_at).not.toBeNull()
    expect(sentMessages()).toBe(1)
  })
})

describe('expected_status does not match -> 409 status_conflict, nothing written', () => {
  it('answers with current_status and expected_status; the card, its events and its sort_order are untouched', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting', sort_order = 4 WHERE id = ?").run(CARD)
    const before = card(CARD)
    const res = await move(CARD, { status: 'done', sort_order: 9, actor: 'agent-b', expected_status: 'in_progress' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('status_conflict')
    expect(res.body.current_status).toBe('waiting')
    expect(res.body.expected_status).toBe('in_progress')
    expect(checkErrorResponse(res.body.error, res.status)).toBeNull()
    expect(card(CARD)).toEqual(before)
    expect(events(CARD)).toEqual([])
  })

  it('does not dispatch: a refused move into in_progress sends no message and does not stamp dispatched_at', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run(CARD)
    const res = await move(CARD, { status: 'in_progress', actor: 'agent-a', expected_status: 'planned' })
    expect(res.status).toBe(409)
    expect(sentMessages()).toBe(0)
    expect(card(CARD).dispatched_at).toBeNull()
  })

  it('does not update the parent card', async () => {
    await createKanbanCard({ id: 'parent-1', title: 'Parent', tenant_id: 'default' })
    await createKanbanCard({ id: 'child-1', title: 'Child', parent_id: 'parent-1', tenant_id: 'default' })
    // Positive control: an unconditional move of the only child to done pulls the parent along.
    const parentBefore = card('parent-1').status
    expect((await move('child-1', { status: 'done', actor: 'agent-b' })).status).toBe(200)
    expect(card('parent-1').status).not.toBe(parentBefore)

    // Reset, then the refused move must leave the parent alone.
    getDb().prepare("UPDATE kanban_cards SET status = 'planned' WHERE id IN ('parent-1', 'child-1')").run()
    const res = await move('child-1', { status: 'done', actor: 'agent-b', expected_status: 'waiting' })
    expect(res.status).toBe(409)
    expect(card('child-1').status).toBe('planned')
    expect(card('parent-1').status).toBe('planned')
  })

  it('orderedIds + mismatch: the other cards of the target column keep their sort_order (the renumber trap)', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting', sort_order = 40 WHERE id = ?").run(OTHER)
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting', sort_order = 50 WHERE id = ?").run(THIRD)
    const res = await move(CARD, { status: 'waiting', sort_order: 0, orderedIds: [CARD, OTHER, THIRD], expected_status: 'done' })
    expect(res.status).toBe(409)
    expect(card(OTHER).sort_order).toBe(40)
    expect(card(THIRD).sort_order).toBe(50)
    expect(card(CARD).status).toBe('planned')
    expect(events(CARD)).toEqual([])
  })

  it('a second mover with the same expected_status loses (the first one already moved the card)', async () => {
    expect((await move(CARD, { status: 'done', actor: 'agent-a', expected_status: 'planned' })).status).toBe(200)
    const second = await move(CARD, { status: 'waiting', actor: 'agent-b', expected_status: 'planned' })
    expect(second.status).toBe(409)
    expect(second.body.current_status).toBe('done')
    expect(card(CARD).status).toBe('done')
    expect(events(CARD)).toHaveLength(1)
  })
})

describe('the audit event names the status the compare-and-set proved', () => {
  it('a status that changes between the previous-status read and the write does not leak into from_status', async () => {
    // The card is 'planned' when moveKanbanCard reads its status, and another writer parks it in
    // 'waiting' right after; the guard (expected 'waiting') then matches. The event must say
    // waiting -> done, not planned -> done.
    const realPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql)
      if (!sql.startsWith('SELECT status FROM kanban_cards WHERE id=?')) return stmt
      return new Proxy(stmt, {
        get(target, key) {
          if (key === 'get') {
            return (...args: unknown[]) => {
              const row = (target as any).get(...args)
              realPrepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run(args[0])
              return row
            }
          }
          const v = (target as any)[key]
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
    }) as any)

    expect(await moveKanbanCard(CARD, 'done', 0, 'agent-b', undefined, { expectedStatus: 'waiting' })).toBe(true)
    vi.restoreAllMocks()
    expect(events(CARD)).toEqual([{ from_status: 'waiting', to_status: 'done', actor: 'agent-b' }])
  })
})

describe('validation and the unchanged cases', () => {
  it('an unknown expected_status value is 400 invalid_value on that field; nothing moves', async () => {
    const res = await move(CARD, { status: 'done', expected_status: 'finished' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_value')
    expect(res.body.field).toBe('expected_status')
    expect(card(CARD).status).toBe('planned')
  })

  it('a non-string expected_status is 400 too', async () => {
    for (const bad of [42, true, ['planned'], {}]) {
      const res = await move(CARD, { status: 'done', expected_status: bad })
      expect(res.status).toBe(400)
      expect(res.body.field).toBe('expected_status')
    }
    expect(card(CARD).status).toBe('planned')
  })

  it('expected_status: null (or absent) is the plain unconditional move', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run(CARD)
    expect((await move(CARD, { status: 'done', expected_status: null })).status).toBe(200)
    expect(card(CARD).status).toBe('done')
    expect((await move(OTHER, { status: 'testing', sort_order: 3 })).status).toBe(200)
    expect(card(OTHER)).toMatchObject({ status: 'testing', sort_order: 3 })
  })

  it('testing is an accepted expected_status (it is a real column)', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'testing' WHERE id = ?").run(CARD)
    expect((await move(CARD, { status: 'done', expected_status: 'testing' })).status).toBe(200)
  })

  it('a card that does not exist is 404 not_found, not 409, with or without expected_status', async () => {
    const guarded = await move('no-such-card', { status: 'done', expected_status: 'planned' })
    expect(guarded.status).toBe(404)
    expect(guarded.body.error).toBe('not_found')
    expect((await move('no-such-card', { status: 'done' })).status).toBe(404)
  })

  it('a missing card with orderedIds renumbers nothing', async () => {
    getDb().prepare('UPDATE kanban_cards SET sort_order = 77 WHERE id = ?').run(OTHER)
    const res = await move('no-such-card', { status: 'planned', sort_order: 0, orderedIds: ['no-such-card', OTHER] })
    expect(res.status).toBe(404)
    expect(card(OTHER).sort_order).toBe(77)
  })

  it('an unknown key in the body is 400 and the move does not happen (a typo must not switch the guard off)', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run(CARD)
    const res = await move(CARD, { status: 'done', expectedStatus: 'planned' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_value')
    expect(res.body.field).toBe('expectedStatus')
    expect(card(CARD).status).toBe('waiting')
  })

  it('every key the callers send is still accepted', async () => {
    const res = await move(CARD, { status: 'waiting', sort_order: 0, actor: 'agent-b', orderedIds: [CARD, OTHER], expected_status: 'planned' })
    expect(res.status).toBe(200)
  })

  it('a body that is not a JSON object is 400', async () => {
    for (const raw of ['null', '[]', '"done"', '7']) {
      const res = await callAs(await admin(), 'POST', `/api/kanban/${CARD}/move`, undefined, raw)
      expect(res.status, raw).toBe(400)
    }
    expect(card(CARD).status).toBe('planned')
  })
})

describe('tenant line', () => {
  it("a foreign tenant's card is 404 even when expected_status would mismatch (no status leak)", async () => {
    const res = await move(FOREIGN, { status: 'done', expected_status: 'waiting' }, await agentA())
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
    expect(res.body.current_status).toBeUndefined()
    expect(card(FOREIGN).status).toBe('planned')
  })

  it('an own-tenant caller gets the 409 on its own card', async () => {
    const res = await move(FOREIGN, { status: 'done', expected_status: 'waiting' }, tenantUser)
    expect(res.status).toBe(409)
    expect(res.body.current_status).toBe('planned')
  })

  it('the 404 for a foreign card is the same body with and without expected_status', async () => {
    const guarded = await move(FOREIGN, { status: 'done', expected_status: 'planned' }, await agentA())
    const plain = await move(FOREIGN, { status: 'done' }, await agentA())
    expect(guarded).toEqual(plain)
  })
})

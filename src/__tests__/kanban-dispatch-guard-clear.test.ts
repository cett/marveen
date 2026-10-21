// The once-only dispatch guard (kanban_cards.dispatched_at) used to be set on the first move into
// in_progress and never cleared, so a card pulled out of in_progress and moved back in did not wake its
// assignee again. The guard now belongs to ONE stay in in_progress: every write that leaves in_progress
// clears it (move on both branches, full-card update, parent auto-status, tenant-scoped update), a write
// that stays in in_progress keeps it, and only POST /move ever wakes an agent. Real in-memory database and
// the real route (same harness as kanban-move-expected-status.test.ts). Neutral fixtures only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import {
  initDatabase, getDb, createTenant, insertApiToken, createKanbanCard, moveKanbanCard, updateKanbanCard,
  propagateStatus, markScheduledTaskKanbanWaiting, markKanbanCardDispatched, kanbanWriteClearsDispatch,
} from '../db.js'
import { updateTenantKanbanCard, insertTenantKanbanCard } from '../db/tenant-scoped.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
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

async function callAs(auth: AuthResult, method: string, path: string, body?: unknown) {
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
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId: resolveTenantId(auth), tokenAgentId,
    agentId: role === 'fleet_agent' && tokenAgentId ? tokenAgentId : undefined,
    auth: auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName } : undefined,
  } as unknown as RouteContext
  if (await tryHandleKanban(ctx)) return out
  out.status = 404
  return out
}

async function tokenAuth(raw: string): Promise<AuthResult> {
  const req = { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
  return resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
}

const admin = async () => tokenAuth('the-file-token')
const move = async (id: string, body: unknown) => callAs(await admin(), 'POST', `/api/kanban/${id}/move`, body)
const put = async (id: string, body: unknown) => callAs(await admin(), 'PUT', `/api/kanban/${id}`, body)
const stamp = (id: string) => (getDb().prepare('SELECT dispatched_at FROM kanban_cards WHERE id = ?').get(id) as { dispatched_at: number | null }).dispatched_at
const status = (id: string) => (getDb().prepare('SELECT status FROM kanban_cards WHERE id = ?').get(id) as { status: string }).status
const sentMessages = () => (getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n

const CARD = 'card-1'
const OTHER = 'card-2'
const PARENT = 'card-parent'
const CHILD_1 = 'card-child-1'
const CHILD_2 = 'card-child-2'

beforeEach(async () => {
  initDatabase(':memory:')
  createTenant('tenant-x', 'Tenant X')
  await insertApiToken({ tokenHash: sha('tok-agent-a'), name: 'fleet:agent-a', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'agent-a' })
  createKanbanCard({ id: CARD, title: 'Card one', assignee: 'agent-b', tenant_id: 'default' })
  createKanbanCard({ id: OTHER, title: 'Card two', assignee: 'agent-b', tenant_id: 'default' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A card that is in_progress and carries the stamp, as after a normal dispatch. */
function inProgressStamped(id = CARD): void {
  moveKanbanCard(id, 'in_progress', 0)
  expect(markKanbanCardDispatched(id)).toBe(true)
  expect(stamp(id)).not.toBeNull()
}

describe('the rule', () => {
  it('only a write that stays in in_progress keeps the stamp', () => {
    expect(kanbanWriteClearsDispatch('in_progress')).toBe(false)
    for (const s of ['planned', 'waiting', 'done']) expect(kanbanWriteClearsDispatch(s)).toBe(true)
  })
})

describe('moveKanbanCard clears the stamp when the card leaves in_progress', () => {
  it.each(['done', 'waiting', 'planned'] as const)('legacy path: in_progress -> %s', (target) => {
    inProgressStamped()
    expect(moveKanbanCard(CARD, target, 0)).toBe(true)
    expect(stamp(CARD)).toBeNull()
  })

  it.each(['done', 'waiting', 'planned'] as const)('orderedIds path: in_progress -> %s', (target) => {
    inProgressStamped()
    expect(moveKanbanCard(CARD, target, 0, undefined, [OTHER, CARD])).toBe(true)
    expect(stamp(CARD)).toBeNull()
  })

  it('a card that is already stuck with a stamp outside in_progress heals on its next write', () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting', dispatched_at = 1700000000 WHERE id = ?").run(CARD)
    expect(moveKanbanCard(CARD, 'waiting', 3)).toBe(true) // a pure reorder, same column
    expect(stamp(CARD)).toBeNull()
  })

  it('the guard works through a compare-and-set move as well', () => {
    inProgressStamped()
    expect(moveKanbanCard(CARD, 'done', 0, undefined, undefined, { expectedStatus: 'in_progress' })).toBe(true)
    expect(stamp(CARD)).toBeNull()
  })

  it('a REFUSED compare-and-set move writes nothing, so the stamp stays', () => {
    inProgressStamped()
    expect(moveKanbanCard(CARD, 'done', 0, undefined, undefined, { expectedStatus: 'waiting' })).toBe(false)
    expect(status(CARD)).toBe('in_progress')
    expect(stamp(CARD)).not.toBeNull()
  })

  it('markScheduledTaskKanbanWaiting (the scheduler parks the card) clears it too', () => {
    inProgressStamped()
    expect(markScheduledTaskKanbanWaiting('Card one')).toBe(CARD)
    expect(status(CARD)).toBe('waiting')
    expect(stamp(CARD)).toBeNull()
  })
})

describe('a write that stays in in_progress keeps the stamp (the once-only guard per stay)', () => {
  it('a reorder inside in_progress, legacy and orderedIds', () => {
    inProgressStamped()
    const before = stamp(CARD)
    expect(moveKanbanCard(CARD, 'in_progress', 7)).toBe(true)
    expect(moveKanbanCard(CARD, 'in_progress', 1, undefined, [OTHER, CARD])).toBe(true)
    expect(stamp(CARD)).toBe(before)
  })

  it('editing other fields of an in_progress card through the full-card update', () => {
    inProgressStamped()
    const before = stamp(CARD)
    expect(updateKanbanCard(CARD, { title: 'Renamed', priority: 'high' })).toBe(true)
    expect(stamp(CARD)).toBe(before)
  })

  it('a refused move out does not clear it', () => {
    inProgressStamped()
    expect(moveKanbanCard('missing-card', 'done', 0)).toBe(false)
    expect(stamp(CARD)).not.toBeNull()
  })
})

describe('updateKanbanCard (the full-card PUT) clears it when the final status is not in_progress', () => {
  it.each(['done', 'waiting', 'planned'] as const)('PUT status %s', (target) => {
    inProgressStamped()
    expect(updateKanbanCard(CARD, { status: target })).toBe(true)
    expect(stamp(CARD)).toBeNull()
  })

  it('also when the PUT only edits other fields of a card that is not in_progress (a stale stamp heals)', () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'done', dispatched_at = 1700000000 WHERE id = ?").run(CARD)
    expect(updateKanbanCard(CARD, { title: 'Closed out' })).toBe(true)
    expect(stamp(CARD)).toBeNull()
  })
})

describe('propagateStatusForParent (auto status) clears the parent when it becomes done', () => {
  beforeEach(() => {
    createKanbanCard({ id: PARENT, title: 'Parent', assignee: 'agent-b', tenant_id: 'default' })
    createKanbanCard({ id: CHILD_1, title: 'Child one', parent_id: PARENT, tenant_id: 'default' })
    createKanbanCard({ id: CHILD_2, title: 'Child two', parent_id: PARENT, tenant_id: 'default' })
  })

  it('every child done -> the parent turns done and loses its stamp', () => {
    inProgressStamped(PARENT)
    moveKanbanCard(CHILD_1, 'done', 0)
    moveKanbanCard(CHILD_2, 'done', 0)
    propagateStatus(CHILD_2)
    expect(status(PARENT)).toBe('done')
    expect(stamp(PARENT)).toBeNull()
  })

  it('a parent that stays in_progress while a child is open keeps its stamp', () => {
    inProgressStamped(PARENT)
    moveKanbanCard(CHILD_1, 'done', 0)
    propagateStatus(CHILD_1)
    expect(status(PARENT)).toBe('in_progress')
    expect(stamp(PARENT)).not.toBeNull()
  })

  it('a done parent with an old stamp whose child reopens reverts to in_progress with the stamp cleared', () => {
    // Legacy shape: the parent is done but still carries a stamp (written before the clear rule existed).
    getDb().prepare("UPDATE kanban_cards SET status = 'done', dispatched_at = 1700000000 WHERE id = ?").run(PARENT)
    moveKanbanCard(CHILD_1, 'done', 0)
    moveKanbanCard(CHILD_2, 'done', 0)
    // Re-open one child; the stale stamp on the parent must not survive the auto-revert.
    moveKanbanCard(CHILD_2, 'in_progress', 0)
    propagateStatus(CHILD_2)
    expect(status(PARENT)).toBe('in_progress')
    expect(stamp(PARENT)).toBeNull()
  })

  it('the revert is recorded as an auto event (the stamp change does not swallow the audit row)', () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'done', dispatched_at = 1700000000 WHERE id = ?").run(PARENT)
    moveKanbanCard(CHILD_1, 'done', 0)
    moveKanbanCard(CHILD_2, 'in_progress', 0)
    propagateStatus(CHILD_2)
    const ev = getDb().prepare("SELECT from_status, to_status, actor FROM kanban_card_events WHERE card_id = ? AND actor = 'auto'").all(PARENT)
    expect(ev).toEqual([{ from_status: 'done', to_status: 'in_progress', actor: 'auto' }])
  })
})

describe('updateTenantKanbanCard clears it as well', () => {
  it('a tenant-scoped status write out of in_progress', () => {
    insertTenantKanbanCard('tenant-x', 'tenant-card', 'Tenant card', 'in_progress')
    markKanbanCardDispatched('tenant-card')
    expect(updateTenantKanbanCard('tenant-x', 'tenant-card', { status: 'done' })).toBe(true)
    expect(stamp('tenant-card')).toBeNull()
  })

  it('a title-only patch or a write that stays in_progress keeps it', () => {
    insertTenantKanbanCard('tenant-x', 'tenant-card', 'Tenant card', 'in_progress')
    markKanbanCardDispatched('tenant-card')
    const before = stamp('tenant-card')
    updateTenantKanbanCard('tenant-x', 'tenant-card', { title: 'Renamed' })
    updateTenantKanbanCard('tenant-x', 'tenant-card', { status: 'in_progress' })
    expect(stamp('tenant-card')).toBe(before)
  })

  it("a write for another tenant's id changes nothing", () => {
    insertTenantKanbanCard('tenant-x', 'tenant-card', 'Tenant card', 'in_progress')
    markKanbanCardDispatched('tenant-card')
    expect(updateTenantKanbanCard('default', 'tenant-card', { status: 'done' })).toBe(false)
    expect(stamp('tenant-card')).not.toBeNull()
  })
})

describe('the route: leave and come back wakes the assignee again, once per stay', () => {
  // A mover that is not the assignee: the self-pickup rule (an agent starting its own card needs no wake-up)
  // is a different guard and stays in force.
  it.each(['done', 'waiting', 'planned'])('in_progress -> %s -> in_progress sends a second assignment', async (away) => {
    expect((await move(CARD, { status: 'in_progress', actor: 'agent-a' })).status).toBe(200)
    expect(sentMessages()).toBe(1)
    expect((await move(CARD, { status: away, actor: 'agent-a' })).status).toBe(200)
    expect(stamp(CARD)).toBeNull()
    expect((await move(CARD, { status: 'in_progress', actor: 'agent-a' })).status).toBe(200)
    expect(sentMessages()).toBe(2)
    expect(stamp(CARD)).not.toBeNull()
  })

  it('the orderedIds branch behaves the same', async () => {
    await move(CARD, { status: 'in_progress', actor: 'agent-a', orderedIds: [CARD] })
    await move(CARD, { status: 'waiting', actor: 'agent-a', orderedIds: [CARD] })
    await move(CARD, { status: 'in_progress', actor: 'agent-a', orderedIds: [CARD] })
    expect(sentMessages()).toBe(2)
  })

  it('staying in in_progress (a reorder) wakes nobody a second time', async () => {
    await move(CARD, { status: 'in_progress', actor: 'agent-a' })
    await move(CARD, { status: 'in_progress', actor: 'agent-a', sort_order: 5 })
    await move(CARD, { status: 'in_progress', actor: 'agent-a', orderedIds: [OTHER, CARD] })
    expect(sentMessages()).toBe(1)
  })

  it('the assignee pulling its own card back in sends nothing (self-pickup), even after leaving', async () => {
    await move(CARD, { status: 'in_progress', actor: 'agent-a' })
    await move(CARD, { status: 'waiting', actor: 'agent-b' })
    await move(CARD, { status: 'in_progress', actor: 'agent-b' })
    expect(sentMessages()).toBe(1)
    expect(stamp(CARD)).toBeNull() // no dispatch happened, so there is no stamp to keep
  })

  it('a card the scheduler parked in waiting is dispatched again when it returns', async () => {
    await move(CARD, { status: 'in_progress', actor: 'agent-a' })
    markScheduledTaskKanbanWaiting('Card one')
    await move(CARD, { status: 'in_progress', actor: 'agent-a' })
    expect(sentMessages()).toBe(2)
  })

  it('a PUT never wakes anybody: PUT in_progress sends nothing, PUT out of it clears the stamp', async () => {
    expect((await put(CARD, { status: 'in_progress' })).status).toBe(200)
    expect(status(CARD)).toBe('in_progress')
    expect(sentMessages()).toBe(0)
    expect(stamp(CARD)).toBeNull()

    await move(OTHER, { status: 'in_progress', actor: 'agent-a' })
    expect(stamp(OTHER)).not.toBeNull()
    expect((await put(OTHER, { status: 'planned' })).status).toBe(200)
    expect(stamp(OTHER)).toBeNull()
    // and returning by PUT does not wake either
    const sent = sentMessages()
    await put(OTHER, { status: 'in_progress' })
    expect(sentMessages()).toBe(sent)
  })
})

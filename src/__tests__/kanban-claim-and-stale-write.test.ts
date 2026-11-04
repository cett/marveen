// Kanban: the atomic claim (POST /:id/claim), the stale-write guard of PUT /:id (expected_updated_at) and the
// taken-id answer of POST. Real in-memory database and the real route (same harness as
// kanban-dispatch-guard-clear.test.ts). Neutral fixtures only.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import { dbx } from '../db/facade.js'
import { initDatabase, getDb, insertApiToken, createKanbanCard, claimKanbanCard, updateKanbanCard, createTenant } from '../db.js'
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

const asAdmin = async () => tokenAuth('the-file-token')
const asAgent = async (raw: string) => tokenAuth(raw)
const row = (id: string) => getDb().prepare('SELECT assignee, updated_at, title FROM kanban_cards WHERE id = ?').get(id) as { assignee: string | null; updated_at: number; title: string }

const CARD = 'card-1'

beforeEach(async () => {
  initDatabase(':memory:')
  await insertApiToken({ tokenHash: sha('tok-agent-a'), name: 'fleet:agent-a', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'agent-a' })
  await insertApiToken({ tokenHash: sha('tok-agent-b'), name: 'fleet:agent-b', role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: 'agent-b' })
  await createKanbanCard({ id: CARD, title: 'Unassigned card', tenant_id: 'default' })
})

describe('claimKanbanCard', () => {
  it('two claims of an unassigned card started together: exactly one wins and the other is told who holds it', async () => {
    const [a, b] = await Promise.all([claimKanbanCard(CARD, 'agent-a'), claimKanbanCard(CARD, 'agent-b')])
    expect([a.status, b.status].sort()).toEqual(['claimed', 'taken'])
    const winner = a.status === 'claimed' ? 'agent-a' : 'agent-b'
    expect(row(CARD).assignee).toBe(winner)
    expect((a.status === 'taken' ? a : b)).toEqual({ status: 'taken', assignee: winner })
  })

  it('claiming the card one already holds is fine, and an unknown or archived card is not found', async () => {
    expect(await claimKanbanCard(CARD, 'agent-a')).toEqual({ status: 'claimed' })
    expect(await claimKanbanCard(CARD, 'agent-a')).toEqual({ status: 'claimed' })
    expect(await claimKanbanCard('no-such-card', 'agent-a')).toEqual({ status: 'not_found' })
    getDb().prepare('UPDATE kanban_cards SET archived_at = 1, assignee = NULL WHERE id = ?').run(CARD)
    expect(await claimKanbanCard(CARD, 'agent-a')).toEqual({ status: 'not_found' })
  })
})

describe('POST /api/kanban/:id/claim', () => {
  it('claims for the agent of the token; the second agent gets 409 with the holder; the holder can claim again', async () => {
    const first = await callAs(await asAgent('tok-agent-a'), 'POST', `/api/kanban/${CARD}/claim`)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true, id: CARD, assignee: 'agent-a' })
    const second = await callAs(await asAgent('tok-agent-b'), 'POST', `/api/kanban/${CARD}/claim`)
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ error: 'conflict', reason: 'already_claimed', assignee: 'agent-a' })
    expect(row(CARD).assignee).toBe('agent-a')
    expect((await callAs(await asAgent('tok-agent-a'), 'POST', `/api/kanban/${CARD}/claim`)).status).toBe(200)
  })

  it('writes an audit row naming the claimant and the proven identity source; a name in the body is refused', async () => {
    expect((await callAs(await asAgent('tok-agent-a'), 'POST', `/api/kanban/${CARD}/claim`, { agent: 'agent-b' })).status).toBe(400)
    expect(row(CARD).assignee).toBeNull()
    expect((await callAs(await asAgent('tok-agent-a'), 'POST', `/api/kanban/${CARD}/claim`)).status).toBe(200)
    const audit = getDb().prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'kanban' AND action = 'update' AND entity_id = ?").all(CARD) as { agent_id: string; detail: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0].agent_id).toBe('agent-a')
    expect(JSON.parse(audit[0].detail)).toMatchObject({ op: 'claim', actor_source: 'token' })
  })

  it('an unknown card is 404; a body that is not an object is 400', async () => {
    expect((await callAs(await asAgent('tok-agent-a'), 'POST', '/api/kanban/no-such-card/claim')).status).toBe(404)
    expect((await callAs(await asAgent('tok-agent-a'), 'POST', `/api/kanban/${CARD}/claim`, [1])).status).toBe(400)
  })
})

describe('PUT /api/kanban/:id with expected_updated_at', () => {
  it('writes when the card is still the version the caller read, and the guard key is not stored', async () => {
    const v = row(CARD).updated_at
    const out = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'Renamed', expected_updated_at: v })
    expect(out.status).toBe(200)
    expect(row(CARD).title).toBe('Renamed')
  })

  it('answers 409 stale_revision with the current version when the card changed since, and writes nothing', async () => {
    const v = row(CARD).updated_at
    getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(v + 5, CARD)
    const out = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'Lost update', expected_updated_at: v })
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'stale_revision', current_updated_at: v + 5 })
    expect(row(CARD).title).toBe('Unassigned card')
  })

  it('a missing card stays 404 with the guard, a non-integer guard is 400, and without the guard the PUT is unchanged', async () => {
    expect((await callAs(await asAdmin(), 'PUT', '/api/kanban/no-such-card', { title: 'x', expected_updated_at: 1 })).status).toBe(404)
    expect((await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'x', expected_updated_at: 'now' })).status).toBe(400)
    expect((await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'Plain' })).status).toBe(200)
    expect(row(CARD).title).toBe('Plain')
  })

  it('updateKanbanCard itself refuses a stale expectedUpdatedAt', async () => {
    const v = row(CARD).updated_at
    expect(await updateKanbanCard(CARD, { title: 'Stale' }, undefined, { expectedUpdatedAt: v - 1 })).toBe(false)
    expect(await updateKanbanCard(CARD, { title: 'Fresh' }, undefined, { expectedUpdatedAt: v })).toBe(true)
  })

  // The stale check at the top of updateKanbanCard is not only a fast path in front of the guarded UPDATE: it also
  // runs BEFORE the field validation, so a stale write is refused (false) even when its fields are invalid. Without it
  // the same call would throw on the invalid due_date. The UPDATE's own condition cannot give this answer.
  it('updateKanbanCard answers false, and does not throw, for a stale version with an invalid due_date; a fresh version throws', async () => {
    const before = row(CARD)
    const invalid = { title: 'Never written', due_date: 'not-a-date' as unknown as number }
    expect(await updateKanbanCard(CARD, invalid, undefined, { expectedUpdatedAt: before.updated_at - 1 })).toBe(false)
    // the same fields on the CURRENT version are what throws: the due_date really is invalid at this layer
    await expect(updateKanbanCard(CARD, invalid, undefined, { expectedUpdatedAt: before.updated_at })).rejects.toThrow(/Invalid due_date/)
    expect(row(CARD)).toEqual(before)
  })

  // The route validates due_date itself before it calls updateKanbanCard, so there the invalid value is a 400 whether the
  // version is stale or not (it never reaches the db layer); a stale version with a VALID due_date is the 409.
  it('PUT: a stale version with an invalid due_date is the route\'s 400 (not a 409, not a 500) and writes nothing; with a valid one it is the 409', async () => {
    const v = row(CARD).updated_at
    getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(v + 5, CARD)
    const before = row(CARD)
    const bad = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'Lost update', due_date: 'not-a-date', expected_updated_at: v })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'invalid_value', field: 'due_date' })
    const good = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'Lost update', due_date: '2026-12-31', expected_updated_at: v })
    expect(good.status).toBe(409)
    expect(good.body).toMatchObject({ error: 'stale_revision', current_updated_at: v + 5 })
    expect(row(CARD)).toEqual(before)
  })

  // PostgreSQL cannot type a bare `? IS NULL` parameter, so the guard is in the SQL only when the caller asks for it.
  describe('the guard is in the UPDATE only when expected_updated_at is given', () => {
    // The UPDATE of the card row, with the parameters it ran with.
    async function runUpdate(opts?: { expectedUpdatedAt?: number }): Promise<{ sql: string; params: unknown[] }> {
      const seen: Array<{ sql: string; params: unknown[] }> = []
      const real = dbx.tx.bind(dbx)
      const spy = vi.spyOn(dbx, 'tx').mockImplementation((fn: (tx: any) => Promise<unknown>, o?: any) =>
        real((tx: any) => fn({ ...tx, run: async (sql: string, ...params: unknown[]) => { seen.push({ sql, params }); return await tx.run(sql, ...params) } }), o) as never)
      try {
        expect(await updateKanbanCard(CARD, { title: `T${Math.random()}` }, undefined, opts)).toBe(true)
      } finally { spy.mockRestore() }
      const update = seen.find((s) => s.sql.includes('UPDATE kanban_cards SET title'))
      if (!update) throw new Error('no card UPDATE seen')
      return update
    }

    it('a plain write has no updated_at condition and no bare IS NULL parameter', async () => {
      const u = await runUpdate()
      expect(u.sql).not.toMatch(/IS NULL OR updated_at/)
      expect(u.sql).not.toMatch(/\?\s+IS NULL/)
      expect(u.sql).not.toMatch(/AND updated_at=\?/)
      expect(u.sql).not.toMatch(/CASE\s+WHEN\s+\?/)
      expect((u.sql.match(/\?/g) ?? []).length).toBe(u.params.length)
    })

    it('the dispatch stamp is cleared in the SQL text, not by a CASE parameter: NULL when the write leaves in_progress, the column itself otherwise', async () => {
      // A title-only write keeps the stamp; a write that moves the card out of in_progress clears it.
      getDb().prepare("UPDATE kanban_cards SET status = 'in_progress', dispatched_at = 123 WHERE id = ?").run(CARD)
      const keep = await runUpdate()
      expect(keep.sql).toMatch(/dispatched_at=dispatched_at/)
      expect((getDb().prepare('SELECT dispatched_at FROM kanban_cards WHERE id = ?').get(CARD) as { dispatched_at: number | null }).dispatched_at).toBe(123)
      expect(await updateKanbanCard(CARD, { status: 'done' })).toBe(true)
      expect((getDb().prepare('SELECT dispatched_at FROM kanban_cards WHERE id = ?').get(CARD) as { dispatched_at: number | null }).dispatched_at).toBeNull()
    })

    it('a guarded write adds exactly AND updated_at=? and the expected version is its last parameter', async () => {
      const v = row(CARD).updated_at
      const u = await runUpdate({ expectedUpdatedAt: v })
      expect(u.sql).toMatch(/WHERE id=\? AND updated_at=\?/)
      expect((u.sql.match(/\?/g) ?? []).length).toBe(u.params.length)
      expect(u.params[u.params.length - 1]).toBe(v)
    })
  })
})

describe('POST /api/kanban: a taken id', () => {
  it('draws a new id on a clash and answers 409 conflict (id_taken) after three clashes', async () => {
    const real = getDb().prepare.bind(getDb())
    let inserts = 0
    vi.spyOn(getDb(), 'prepare').mockImplementation(((text: string) => {
      if (/^INSERT INTO kanban_cards/.test(text.trim())) {
        inserts++
        throw Object.assign(new Error('UNIQUE constraint failed: kanban_cards.id'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
      }
      return real(text)
    }) as never)
    const out = await callAs(await asAdmin(), 'POST', '/api/kanban', { title: 'New card' })
    vi.restoreAllMocks()
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'conflict', reason: 'id_taken' })
    expect(inserts).toBe(3)
  })
})

// Edges of the claim route, the guard parsing and the id redraw.

// A call with a hand-built request context (the principal, the tenant and the raw body are what the cases vary).
type CtxOpts = { role?: string; tenantId?: string | null; tokenAgentId?: string; agentId?: string; auth?: unknown; raw?: string }
async function callCtx(o: CtxOpts, method: string, path: string, body?: unknown) {
  const buf = o.raw !== undefined ? Buffer.from(o.raw) : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
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
  const ctx = { req, res, path: url.pathname, method, url, role: o.role ?? 'admin', tenantId: o.tenantId ?? null, tokenAgentId: o.tokenAgentId, agentId: o.agentId, auth: o.auth } as unknown as RouteContext
  if (await tryHandleKanban(ctx)) return out
  out.status = 404
  return out
}
const claimAudit = (id: string) => (getDb().prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'kanban' AND action = 'update' AND entity_id = ? ORDER BY rowid").all(id) as { agent_id: string; detail: string }[])
  .map((r) => ({ agent: r.agent_id, ...JSON.parse(r.detail) }))
const tenantCaller = (tenantId: string, extra: CtxOpts = {}): CtxOpts => ({ role: 'agent', tenantId, ...extra })

describe('POST /api/kanban/:id/claim -- tenant boundary', () => {
  beforeEach(async () => {
    await createTenant('tenant-x', 'Tenant X')
    await createKanbanCard({ id: 'card-x', title: 'Foreign card', tenant_id: 'tenant-x' })
  })

  it('a tenant-bound caller cannot claim a card of another tenant, free or held: 404, the holder is not leaked, nothing is written', async () => {
    const caller = tenantCaller('default', { tokenAgentId: 'agent-a', agentId: 'agent-a' })
    const free = await callCtx(caller, 'POST', '/api/kanban/card-x/claim')
    expect(free.status).toBe(404)
    expect(row('card-x').assignee).toBeNull()
    getDb().prepare("UPDATE kanban_cards SET assignee = 'holder-x' WHERE id = 'card-x'").run()
    const held = await callCtx(caller, 'POST', '/api/kanban/card-x/claim')
    expect(held.status).toBe(404)
    expect(JSON.stringify(held.body)).not.toContain('holder-x')
    expect(row('card-x').assignee).toBe('holder-x')
    expect(claimAudit('card-x')).toEqual([])
  })

  it('the same caller can claim a card of its OWN tenant (the 404 above is the tenant line, not a general refusal)', async () => {
    const out = await callCtx(tenantCaller('tenant-x', { tokenAgentId: 'agent-a', agentId: 'agent-a' }), 'POST', '/api/kanban/card-x/claim')
    expect(out.status).toBe(200)
    expect(row('card-x').assignee).toBe('agent-a')
  })
})

describe('POST /api/kanban/:id/claim -- identity, audit, body, archived', () => {
  it('the agent of the token wins over a different X-Agent-Id, and the audit row says token', async () => {
    const out = await callCtx({ role: 'admin', tokenAgentId: 'agent-a', agentId: 'agent-b' }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(out.status).toBe(200)
    expect(out.body.assignee).toBe('agent-a')
    expect(row(CARD).assignee).toBe('agent-a')
    expect(claimAudit(CARD)[0]).toMatchObject({ agent: 'agent-a', op: 'claim', actor_source: 'token' })
  })

  it('a signed-in user claims as that user (session); a bare X-Agent-Id claims as that agent (self_declared)', async () => {
    const session = await callCtx({ role: 'admin', auth: { kind: 'session', user: 'user-1' } }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(session.status).toBe(200)
    expect(row(CARD).assignee).toBe('user-1')
    expect(claimAudit(CARD)[0]).toMatchObject({ agent: 'user-1', actor_source: 'session' })
    await createKanbanCard({ id: 'card-2', title: 'Second', tenant_id: 'default' })
    const declared = await callCtx({ role: 'admin', agentId: 'agent-b' }, 'POST', '/api/kanban/card-2/claim')
    expect(declared.status).toBe(200)
    expect(claimAudit('card-2')[0]).toMatchObject({ agent: 'agent-b', actor_source: 'self_declared' })
  })

  it('a caller with no identity at all is a 400 required, not a crash, and nothing is written', async () => {
    const out = await callCtx({ role: 'admin' }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'agent' })
    expect(row(CARD).assignee).toBeNull()
  })

  it('a failing audit write does not abort the claim', async () => {
    getDb().exec('DROP TABLE agent_audit_log')
    const out = await callCtx({ role: 'admin', tokenAgentId: 'agent-a', agentId: 'agent-a' }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(out.status).toBe(200)
    expect(row(CARD).assignee).toBe('agent-a')
  })

  it.each([['null', 'null'], ['an empty array', '[]'], ['a number', '5'], ['a string', '"x"']])('%s as the body is a 400 and claims nothing', async (_label, raw) => {
    const out = await callCtx({ role: 'admin', tokenAgentId: 'agent-a', agentId: 'agent-a', raw }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'body' })
    expect(row(CARD).assignee).toBeNull()
  })

  it('an empty object body is a normal claim', async () => {
    const out = await callCtx({ role: 'admin', tokenAgentId: 'agent-a', agentId: 'agent-a', raw: '{}' }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(out.status).toBe(200)
    expect(row(CARD).assignee).toBe('agent-a')
  })

  it('an archived card is a 404 through the route, also with a holder set (never 409 or 200)', async () => {
    getDb().prepare("UPDATE kanban_cards SET archived_at = 1, assignee = 'agent-b' WHERE id = ?").run(CARD)
    const admin = await callCtx({ role: 'admin', tokenAgentId: 'agent-a', agentId: 'agent-a' }, 'POST', `/api/kanban/${CARD}/claim`)
    expect(admin.status).toBe(404)
    const bound = await callCtx(tenantCaller('default', { tokenAgentId: 'agent-a', agentId: 'agent-a' }), 'POST', `/api/kanban/${CARD}/claim`)
    expect(bound.status).toBe(404)
    expect(row(CARD).assignee).toBe('agent-b')
  })

  it('a card whose assignee is the empty string can be claimed', async () => {
    getDb().prepare("UPDATE kanban_cards SET assignee = '' WHERE id = ?").run(CARD)
    expect(await claimKanbanCard(CARD, 'agent-a')).toEqual({ status: 'claimed' })
    expect(row(CARD).assignee).toBe('agent-a')
  })

  it('a claim moves updated_at, so a PUT that read the card before the claim is stale (409)', async () => {
    getDb().prepare('UPDATE kanban_cards SET updated_at = 1000 WHERE id = ?').run(CARD)
    expect(await claimKanbanCard(CARD, 'agent-a')).toEqual({ status: 'claimed' })
    expect(row(CARD).updated_at).toBeGreaterThan(1000)
    const put = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'Late', expected_updated_at: 1000 })
    expect(put.status).toBe(409)
    expect(row(CARD).title).toBe('Unassigned card')
  })
})

describe('PUT /api/kanban/:id expected_updated_at -- parsing and refusals', () => {
  it('a fractional guard is a 400 and writes nothing; null means "no guard" and the PUT goes through', async () => {
    const fractional = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'x', expected_updated_at: 1.5 })
    expect(fractional.status).toBe(400)
    expect(fractional.body).toMatchObject({ error: 'invalid_value', field: 'expected_updated_at' })
    expect(row(CARD).title).toBe('Unassigned card')
    const none = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { title: 'y', expected_updated_at: null })
    expect(none.status).toBe(200)
    expect(row(CARD).title).toBe('y')
  })

  it('a write the update refuses for another reason (a parent change into the own subtree) with the CURRENT version is not a stale 409', async () => {
    await createKanbanCard({ id: 'child-1', title: 'Child', tenant_id: 'default', parent_id: CARD } as any)
    const before = row(CARD)
    const out = await callAs(await asAdmin(), 'PUT', `/api/kanban/${CARD}`, { parent_id: 'child-1', expected_updated_at: before.updated_at })
    expect(out.status).not.toBe(409)
    expect(out.body.error).not.toBe('stale_revision')
    expect(row(CARD)).toEqual(before)
  })
})

describe('POST /api/kanban -- the id redraw', () => {
  it('two clashes and then a free id: the card is created once and answered 200 (not a 409 for a card that exists)', async () => {
    const real = getDb().prepare.bind(getDb())
    let inserts = 0
    const spy = vi.spyOn(getDb(), 'prepare').mockImplementation(((text: string) => {
      if (/^INSERT INTO kanban_cards/.test(text.trim())) {
        inserts++
        if (inserts <= 2) throw Object.assign(new Error('UNIQUE constraint failed: kanban_cards.id'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
      }
      return real(text)
    }) as never)
    try {
      const out = await callAs(await asAdmin(), 'POST', '/api/kanban', { title: 'After clashes' })
      expect(out.status).toBe(200)
      expect(inserts).toBe(3)
    } finally { spy.mockRestore() }
    expect((getDb().prepare("SELECT COUNT(*) AS c FROM kanban_cards WHERE title = 'After clashes'").get() as { c: number }).c).toBe(1)
  })
})

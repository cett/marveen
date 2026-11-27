// POST /api/hooks/watchdog-facts on PostgreSQL, as the APP role (marveen_app: DML rights only, row-level security FORCEd), through
// the real request opener (runAsRequest). What the SQLite cells (src/__tests__/hooks-watchdog-facts-route.test.ts) cannot show:
//   - TENANT ISOLATION: the facts are read in the REQUEST tenant context, so another tenant's blackboard rows, cards, messages and
//     settings never come back, even when they carry the caller's own agent id (a shared agent). A route that ran as a system job
//     would read them all: the "oracle" cell shows the system context does see them, so the isolation cells are not vacuous.
//   - the card number is the identity column `seq` (PostgreSQL has no rowid), an integer in the answer
//   - the LIMITs and the bound parameters hold on this backend
// Rows are seeded through the admin pool (the oracle that a row exists whatever the policies say). Neutral fixtures only.
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { runAs } from '../../db/context.js'
import { runAsRequest } from '../../db/background-jobs.js'
import { getWatchdogHandoffFacts, getWatchdogThreshold } from '../../db/hook-tenant-reads.js'
import { tryHandleHooksTenant } from '../../web/routes/hooks-tenant.js'
import type { RouteContext } from '../../web/routes/types.js'

const made: PgTestDb[] = []
afterEach(async () => { await closePgBackend() })
afterAll(async () => { for (const d of made) await d.close() })

/** A backend booted as the app role over two tenants; agent-a is enabled for both (a shared agent), agent-b for tenant-t1. */
async function bootedDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-t1', 'Tenant 1', 1), ('tenant-t2', 'Tenant 2', 1) ON CONFLICT DO NOTHING")
  await db.pool.query("INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES ('tenant-t1', 'agent-a', 1), ('tenant-t2', 'agent-a', 1), ('tenant-t1', 'agent-b', 1)")
  await bootPgBackend({ url: db.appUrl })
  return db
}

/** The route context a hook request carries, enough for the hooks route (the response is captured). */
function routeCtx(body: unknown, tokenAgentId: string | undefined, tenantId: string): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const req = new EventEmitter() as unknown as RouteContext['req']
  Object.assign(req, { method: 'POST', headers: {}, destroy: () => {} })
  setImmediate(() => { (req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body))); (req as unknown as EventEmitter).emit('end') })
  const out: { status: number; body: unknown } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not json */ }
    },
  } as unknown as RouteContext['res']
  const url = new URL('http://localhost:3420/api/hooks/watchdog-facts')
  return { ctx: { req, res, path: url.pathname, method: 'POST', url, role: 'fleet_agent', tokenAgentId, tenantId } as unknown as RouteContext, out }
}

/** The route as the web server runs it: the request opener gives the agent context of the token's tenant. */
async function ask(want: string, agent: string, tenantId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { ctx, out } = routeCtx({ want }, agent, tenantId)
  await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: agent, tenantId }, () => tryHandleHooksTenant(ctx))
  return { status: out.status, body: out.body as Record<string, unknown> }
}

let seq = 0
const bb = (db: PgTestDb, tenant: string, agent: string, status: string, summary: string, updatedAt: number, taskRef: string | null = null) =>
  db.pool.query('INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [`bb-${++seq}`, agent, taskRef, status, summary, updatedAt, tenant])
const card = (db: PgTestDb, tenant: string, title: string, status: string, assignee: string, updatedAt: number, archivedAt: number | null = null) =>
  db.pool.query('INSERT INTO kanban_cards (id, title, status, assignee, created_at, updated_at, archived_at, tenant_id) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)', [`kc-${++seq}`, title, status, assignee, updatedAt, archivedAt, tenant])
const msg = (db: PgTestDb, tenant: string, from: string, content: string, createdAt: number) =>
  db.pool.query("INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES ($1, 'peer', $2, 'done', $3, $4)", [from, content, createdAt, tenant])
const setting = (db: PgTestDb, tenant: string, agent: string, value: string) =>
  db.pool.query("INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id, updated_at) VALUES ($1, 'context_restart_gate', $2, $3, 1)", [agent, value, tenant])

/** Two tenants' worth of rows, the second one NEWER everywhere and carrying the SAME agent id as the caller. */
async function seedTwoTenants(db: PgTestDb): Promise<void> {
  await bb(db, 'tenant-t1', 'agent-a', 'active', 'own t1 work', 100, 'ref-t1')
  await bb(db, 'tenant-t1', 'agent-b', 'active', 'peer t1', 150)
  await bb(db, 'tenant-t2', 'agent-x', 'active', 'peer t2 SECRET', 900)
  await card(db, 'tenant-t1', 'T1 card', 'in_progress', 'agent-a', 10)
  await card(db, 'tenant-t2', 'T2 card SECRET', 'in_progress', 'agent-a', 20)
  await msg(db, 'tenant-t1', 'agent-a', 'next step t1', 10)
  await msg(db, 'tenant-t2', 'agent-a', 'next step t2 SECRET', 20)
  await setting(db, 'tenant-t1', 'agent-a', JSON.stringify({ thresholdTokens: 111111 }))
  await setting(db, 'tenant-t2', 'agent-b', JSON.stringify({ thresholdTokens: 222222 }))
}

describe('the facts in the request tenant context, as the app role', () => {
  it('the caller sees its own tenant\'s rows: own row, latest rows, open card, last message, threshold', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const h = await ask('handoff', 'agent-a', 'tenant-t1')
    expect(h.status).toBe(200)
    expect(h.body['own']).toEqual({ task_ref: 'ref-t1', status: 'active', summary: 'own t1 work' })
    expect((h.body['recent'] as { agent_id: string }[]).map((r) => r.agent_id)).toEqual(['agent-b', 'agent-a'])
    expect((h.body['cards'] as { title: string }[]).map((c) => c.title)).toEqual(['T1 card'])
    expect(h.body['last_outgoing']).toBe('next step t1')
    expect((await ask('threshold', 'agent-a', 'tenant-t1')).body).toEqual({ threshold_tokens: 111111 })
  })

  it('another tenant\'s rows never come back, even newer ones and ones with the caller\'s own agent id', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const h = await ask('handoff', 'agent-a', 'tenant-t1')
    expect(JSON.stringify(h.body)).not.toContain('SECRET')
    expect(JSON.stringify(h.body)).not.toContain('agent-x')
    // and from the other side: tenant-t2 sees only its own
    const h2 = await ask('handoff', 'agent-a', 'tenant-t2')
    expect(h2.body['own']).toBeNull()
    expect((h2.body['recent'] as { agent_id: string }[]).map((r) => r.agent_id)).toEqual(['agent-x'])
    expect((h2.body['cards'] as { title: string }[]).map((c) => c.title)).toEqual(['T2 card SECRET'])
    expect(h2.body['last_outgoing']).toBe('next step t2 SECRET')
    expect(JSON.stringify(h2.body)).not.toContain('t1')
  })

  it('the threshold of another tenant\'s row is not read (null, the hook then takes its default)', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    // agent-b's only setting row is tenant-t2's: from tenant-t1 it does not exist
    expect((await ask('threshold', 'agent-b', 'tenant-t1')).body).toEqual({ threshold_tokens: null })
  })

  it('the ORACLE: under the system context the same reads DO see the other tenant (the isolation cells above are not vacuous)', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const facts = await runAs.system('test-oracle', () => getWatchdogHandoffFacts('agent-a'))
    expect(JSON.stringify(facts)).toContain('SECRET')
    expect(facts.recent[0]?.agent_id).toBe('agent-x') // the newest row of the whole fleet, another tenant's
    expect(await runAs.system('test-oracle', () => getWatchdogThreshold('agent-b'))).toBe(222222)
  })

  it('a call with no tenant context at all reads nothing (the silent-empty class stays empty, never the fleet)', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const facts = await runAs.public('test-bare', () => getWatchdogHandoffFacts('agent-a'))
    expect(facts).toEqual({ own: null, recent: [], cards: [], last_outgoing: null })
  })
})

describe('the card number and the bounds on this backend', () => {
  it('the number is the identity column seq, an integer (PostgreSQL has no rowid)', async () => {
    const db = await bootedDb()
    await card(db, 'tenant-t1', 'first', 'in_progress', 'agent-b', 1)
    await card(db, 'tenant-t1', 'second', 'waiting', 'agent-b', 2)
    const oracle = (await db.pool.query("SELECT title, seq FROM kanban_cards WHERE assignee = 'agent-b'")).rows as { title: string; seq: string | number }[]
    const h = await ask('handoff', 'agent-b', 'tenant-t1')
    const cards = h.body['cards'] as { number: number; title: string }[]
    expect(cards.map((c) => c.title)).toEqual(['second', 'first'])
    for (const c of cards) {
      expect(Number.isInteger(c.number)).toBe(true)
      expect(c.number).toBe(Number(oracle.find((o) => o.title === c.title)?.seq))
    }
  })

  it('LIMITs hold (three latest rows, five cards) and the filters match the SQLite reads (status, archived, assignee)', async () => {
    const db = await bootedDb()
    for (let i = 0; i < 6; i++) await bb(db, 'tenant-t1', `agent-${i}`, 'active', `row ${i}`, 10 + i)
    for (let i = 0; i < 8; i++) await card(db, 'tenant-t1', `c${i}`, 'in_progress', 'agent-b', i)
    await card(db, 'tenant-t1', 'planned', 'planned', 'agent-b', 99)
    await card(db, 'tenant-t1', 'archived', 'in_progress', 'agent-b', 98, 5)
    await card(db, 'tenant-t1', 'other', 'in_progress', 'agent-a', 97)
    const h = await ask('handoff', 'agent-b', 'tenant-t1')
    expect((h.body['recent'] as unknown[]).length).toBe(3)
    expect((h.body['recent'] as { summary: string }[]).map((r) => r.summary)).toEqual(['row 5', 'row 4', 'row 3'])
    expect((h.body['cards'] as { title: string }[]).map((c) => c.title)).toEqual(['c7', 'c6', 'c5', 'c4', 'c3'])
  })

  it('a token that names no agent is a 403 here too, and a bad want a 400', async () => {
    await bootedDb()
    const { ctx, out } = routeCtx({ want: 'handoff' }, undefined, 'tenant-t1')
    await runAsRequest({ authenticated: true, role: 'fleet_agent', tenantId: 'tenant-t1' }, () => tryHandleHooksTenant(ctx))
    expect(out.status).toBe(403)
    expect((await ask('everything', 'agent-b', 'tenant-t1')).status).toBe(400)
  })
})

beforeEach(() => { seq = 0 })

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
import { getWatchdogHandoffFacts } from '../../db/hook-tenant-reads.js'
import { recordWatchdogTelemetry } from '../../db/hook-watchdog-record.js'
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
function routeCtx(body: unknown, tokenAgentId: string | undefined, tenantId: string, route = '/api/hooks/watchdog-facts'): { ctx: RouteContext; out: { status: number; body: unknown } } {
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
  const url = new URL('http://localhost:3420' + route)
  return { ctx: { req, res, path: url.pathname, method: 'POST', url, role: 'fleet_agent', tokenAgentId, tenantId } as unknown as RouteContext, out }
}

/** The route as the web server runs it: the request opener gives the agent context of the token's tenant. */
async function ask(want: string, agent: string, tenantId: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { ctx, out } = routeCtx({ want, ...extra }, agent, tenantId)
  await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: agent, tenantId }, () => tryHandleHooksTenant(ctx))
  return { status: out.status, body: out.body as Record<string, unknown> }
}

/** The record route as the web server runs it (the request opener first, then the route, whose job lifts the context itself). */
async function record(body: unknown, agent: string, tenantId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { ctx, out } = routeCtx(body, agent, tenantId, '/api/hooks/watchdog-record')
  await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: agent, tenantId }, () => tryHandleHooksTenant(ctx))
  return { status: out.status, body: out.body as Record<string, unknown> }
}
const thresholdOf = async (agent: string, tenantId: string) => (await record({}, agent, tenantId)).body['threshold_tokens']

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
    expect(await thresholdOf('agent-a', 'tenant-t1')).toBe(111111)
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

  it('the threshold is the agent\'s OWN setting whatever tenant it is stamped for: a shared agent in a tenant context gets its configured value, never the default', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    // agent-b's only setting row is stamped tenant-t2, the request is tenant-t1: a request-tenant read would see nothing (null,
    // the silent fall back to the default); the named system job with the fixed agent filter returns the configured value
    expect(await thresholdOf('agent-b', 'tenant-t1')).toBe(222222)
  })

  it('the threshold filter is the token\'s agent: another agent\'s row (another tenant\'s too) is never returned', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    expect(await thresholdOf('agent-a', 'tenant-t1')).toBe(111111)
    expect(await thresholdOf('agent-a', 'tenant-t2')).toBe(111111)
    // an agent with no row of its own reads null, not a neighbour's value
    expect(await thresholdOf('agent-c', 'tenant-t1')).toBeNull()
  })

  it('the ORACLE: under the system context the same reads DO see the other tenant (the isolation cells above are not vacuous)', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const facts = await runAs.system('test-oracle', () => getWatchdogHandoffFacts('agent-a'))
    expect(JSON.stringify(facts)).toContain('SECRET')
    expect(facts.recent[0]?.agent_id).toBe('agent-x') // the newest row of the whole fleet, another tenant's
    // the threshold read is the system job's, so it sees agent-b's row stamped for the other tenant: that is the point of it
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

// ---------------------------------------------------------------------------------------------------------------------------
// H2a: the record route (the hook's writes + the threshold, ONE named system job) and the dedup baseline, as the app role.
// ---------------------------------------------------------------------------------------------------------------------------
const NOW = Date.now()
const T = Math.floor(NOW / 1000) - 60
const usage = (over: Record<string, unknown> = {}) => ({
  session_id: 's-1', timestamp: T, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40,
  model: 'm-1', content_preview: 'hello', tool_name: 'Bash', ...over,
})
const span = (over: Record<string, unknown> = {}) => ({
  operation: 'model.call', trace_id: 's-1', span_id: 'sp-1', parent_span_id: null, start_ms: NOW - 2000, end_ms: NOW - 1000,
  status: 'ok', attributes: '{"model":"m-1"}', ...over,
})
const usageOf = async (db: PgTestDb) => (await db.pool.query('SELECT agent, tenant_id, thinking_tokens, model FROM token_usage ORDER BY agent, id')).rows as { agent: string; tenant_id: string | null; thinking_tokens: number | string; model: string | null }[]
const spansOf = async (db: PgTestDb) => (await db.pool.query('SELECT span_id, agent_id, tenant_id, end_ms, status, attributes FROM otel_spans ORDER BY span_id')).rows as { span_id: string; agent_id: string; tenant_id: string | null; end_ms: string | number; status: string; attributes: string | null }[]

describe('the record route on PostgreSQL, as the app role', () => {
  it('stamps the tenants server-side with the two resolvers, and ignores a tenant or agent named in the body', async () => {
    const db = await bootedDb()
    // agent-a serves two tenants (shared), agent-b one, agent-c none
    for (const agent of ['agent-a', 'agent-b', 'agent-c']) {
      const out = await record({ agent_id: 'agent-x', tenant_id: 'tenant-t2', usage: usage({ session_id: `s-${agent}`, tenant_id: 'tenant-t2', agent: 'agent-x' }), spans: [span({ trace_id: `s-${agent}`, span_id: `sp-${agent}`, tenant_id: 'tenant-t2', agent_id: 'agent-x' })] }, agent, 'tenant-t1')
      expect(out.status, agent).toBe(200)
      expect(out.body, agent).toMatchObject({ usage: true, spans: 1, dropped: 0 })
    }
    expect((await usageOf(db)).map((r) => [r.agent, r.tenant_id])).toEqual([['agent-a', '_multi_'], ['agent-b', 'tenant-t1'], ['agent-c', 'default']])
    // a shared agent with no fresh tenant context: the span says unknown (NULL), not the request's tenant
    expect((await spansOf(db)).map((r) => [r.agent_id, r.tenant_id])).toEqual([['agent-a', null], ['agent-b', 'tenant-t1'], ['agent-c', 'default']])
  })

  it('the ORACLE: the same insert in the REQUEST tenant context is refused by the policy (so the system job is what makes the stamps writable, and the isolation is real)', async () => {
    const db = await bootedDb()
    const { dbx } = await import('../../db/facade.js')
    await expect(runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: 'tenant-t1' }, () =>
      dbx.run("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tenant_id) VALUES ('agent-a', 's', 1, 1, 1, '_multi_')"),
    )).rejects.toThrow()
    expect(await usageOf(db)).toEqual([])
  })

  it('is idempotent, and the collector and the hook on the SAME line leave ONE row in either order, the tenant unchanged', async () => {
    const db = await bootedDb()
    const { recordTokenUsageCalls } = await import('../../db/observability.js')
    const line = { agent: 'agent-a', sessionId: 's-1', timestamp: T, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, thinkingTokens: 7, model: null, contentPreview: 'hello', toolName: 'Bash' }
    const collect = () => runAs.system('test-collector', () => recordTokenUsageCalls([line], '_multi_', '/x.jsonl', 1, 1))
    await record({ usage: usage() }, 'agent-a', 'tenant-t1')
    await record({ usage: usage() }, 'agent-a', 'tenant-t1')
    expect(await usageOf(db)).toHaveLength(1)
    await collect()
    expect((await usageOf(db)).map((r) => [r.tenant_id, Number(r.thinking_tokens), r.model])).toEqual([['_multi_', 7, 'm-1']])
    await db.pool.query('DELETE FROM token_usage')
    await collect()
    await record({ usage: usage() }, 'agent-a', 'tenant-t1')
    expect((await usageOf(db)).map((r) => [r.tenant_id, Number(r.thinking_tokens), r.model])).toEqual([['_multi_', 7, 'm-1']])
  })

  it('another agent\'s span cannot be overwritten (the new WHERE) and close_stale closes the caller\'s own spans only', async () => {
    const db = await bootedDb()
    await record({ spans: [span({ end_ms: NOW - 1000, status: 'ok', attributes: '{"owner":"b"}' })] }, 'agent-b', 'tenant-t1')
    const out = await record({ spans: [span({ end_ms: NOW - 10, status: 'error', attributes: '{"owner":"a"}' })] }, 'agent-a', 'tenant-t1')
    expect(out.body).toMatchObject({ spans: 0, dropped: 1 })
    expect((await spansOf(db)).map((r) => [r.agent_id, Number(r.end_ms), r.status, r.attributes])).toEqual([['agent-b', NOW - 1000, 'ok', '{"owner":"b"}']])
    await db.pool.query('DELETE FROM otel_spans')
    const turn = (agent: string, id: string) => record({ spans: [span({ operation: 'agent.turn', trace_id: 'trace-x', span_id: id, status: 'running' })] }, agent, 'tenant-t1')
    await turn('agent-a', 'old-a'); await turn('agent-b', 'old-b'); await turn('agent-a', 'keep-a')
    await record({ close_stale: { trace_id: 'trace-x', keep_span_id: 'keep-a' } }, 'agent-a', 'tenant-t1')
    expect((await spansOf(db)).map((r) => [r.span_id, r.status])).toEqual([['keep-a', 'running'], ['old-a', 'ok'], ['old-b', 'running']])
  })

  it('an invalid item is dropped and counted, and a write that fails is a 200 with the flag false: the threshold is answered either way', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const bad = await record({ usage: usage({ input_tokens: -1 }), spans: [span({ operation: 'tool.call' }), span({ span_id: 'good' })] }, 'agent-a', 'tenant-t1')
    expect(bad.body).toEqual({ threshold_tokens: 111111, usage: false, spans: 1, dropped: 2 })
    const { dbx } = await import('../../db/facade.js')
    const { vi } = await import('vitest')
    const real = dbx.run.bind(dbx)
    const spy = vi.spyOn(dbx, 'run').mockImplementation(((sql: string, ...args: unknown[]) =>
      /INSERT INTO (token_usage|otel_spans)/.test(sql) ? Promise.reject(new Error('forced')) : real(sql, ...args)) as typeof dbx.run)
    try {
      const failed = await record({ usage: usage({ session_id: 's-2' }), spans: [span({ span_id: 'sp-2' })] }, 'agent-a', 'tenant-t1')
      expect(failed.status).toBe(200)
      expect(failed.body).toEqual({ threshold_tokens: 111111, usage: false, spans: 0, dropped: 2 })
    } finally {
      spy.mockRestore()
    }
    expect((await spansOf(db)).map((r) => r.span_id)).toEqual(['good'])
  })

  it('the usage timestamp window is [now - 7 days, now + 5 minutes]: an old or far-future line is dropped and counted, the threshold is still answered, no row is written', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const nowS = Math.floor(Date.now() / 1000)
    // a month that is already rolled up (30 days back), just past the window (8 days), and a bad clock (10 minutes ahead)
    for (const [i, ts] of [nowS - 30 * 86_400, nowS - 8 * 86_400, nowS + 10 * 60].entries()) {
      const r = await record({ usage: usage({ session_id: `s-out-${i}`, timestamp: ts }) }, 'agent-a', 'tenant-t1')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ threshold_tokens: 111111, usage: false, spans: 0, dropped: 1 })
    }
    expect(await usageOf(db)).toEqual([])
    // inside the window: a session resumed after six days of pause, and a clock a minute ahead
    for (const [i, ts] of [nowS - 6 * 86_400, nowS + 60].entries()) {
      const r = await record({ usage: usage({ session_id: `s-in-${i}`, timestamp: ts }) }, 'agent-a', 'tenant-t1')
      expect(r.body).toEqual({ threshold_tokens: 111111, usage: true, spans: 0, dropped: 0 })
    }
    expect(await usageOf(db)).toHaveLength(2)
  })

  it('the exported job is the sanctioned one: calling it outside a request still reads the caller\'s own threshold only', async () => {
    const db = await bootedDb()
    await seedTwoTenants(db)
    const out = await recordWatchdogTelemetry('agent-b', { usage: null, spans: [], close_stale: null })
    expect(out).toEqual({ threshold_tokens: 222222, usage: false, spans: 0, dropped: 0 })
  })

  it('the emit pair: the audit row lands through POST /api/hook-audit and the next call reads it back with prior_handoff (a one-tenant agent, and a shared agent with a fresh context)', async () => {
    const db = await bootedDb()
    const { tryHandleHookAudit } = await import('../../web/routes/hook-audit.js')
    await db.pool.query("INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES ('agent-a', 'tenant-t1', 'bound', 'test', 's', $1)", [Math.floor(Date.now() / 1000)])
    for (const [agent, tenant] of [['agent-b', 'tenant-t1'], ['agent-a', 'tenant-t1']] as const) {
      const body = { hook_type: 'PostToolUse', verdict: 'handoff', tool_name: 'Bash', content_hash: `hash-${agent}`, reason: 'ctx=62%', session_id: 's-pair', trigger_source: 'watchdog', trace_id: 's-pair' }
      const { ctx, out } = routeCtx(body, agent, tenant, '/api/hook-audit')
      await runAsRequest({ authenticated: true, role: 'fleet_agent', agentId: agent, tenantId: tenant }, () => tryHandleHookAudit(ctx))
      expect(out.status, agent).toBe(200)
      const back = await ask('prior_handoff', agent, tenant, { session_id: 's-pair' })
      expect(back.body, agent).toMatchObject({ reason: 'ctx=62%', content_hash: `hash-${agent}` })
    }
    const rows = (await db.pool.query("SELECT agent_id, tenant_id, trace_id FROM hook_audit_log WHERE verdict = 'handoff' ORDER BY agent_id")).rows
    expect(rows).toEqual([{ agent_id: 'agent-a', tenant_id: 'tenant-t1', trace_id: 's-pair' }, { agent_id: 'agent-b', tenant_id: 'tenant-t1', trace_id: 's-pair' }])
  })

  it('prior_handoff: the caller\'s own latest handoff row of the session, in the request tenant context (a row of another agent or another tenant is not returned)', async () => {
    const db = await bootedDb()
    const audit = (tenant: string, agent: string, ts: number, hash: string) => db.pool.query(
      "INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, reason, content_hash, session_id, trigger_source, tenant_id) VALUES ($1, $2, 'PostToolUse', 'handoff', 'ctx=61%', $3, 's-1', 'watchdog', $4)", [ts, agent, hash, tenant])
    await audit('tenant-t1', 'agent-a', 100, 'old')
    await audit('tenant-t1', 'agent-a', 200, 'new')
    await audit('tenant-t1', 'agent-b', 300, 'other-agent')
    await audit('tenant-t2', 'agent-a', 400, 'other-tenant')
    const t1 = await ask('prior_handoff', 'agent-a', 'tenant-t1', { session_id: 's-1' })
    expect(t1.body).toEqual({ ts: 200, reason: 'ctx=61%', content_hash: 'new' })
    const t2 = await ask('prior_handoff', 'agent-a', 'tenant-t2', { session_id: 's-1' })
    expect(t2.body).toEqual({ ts: 400, reason: 'ctx=61%', content_hash: 'other-tenant' })
    expect((await ask('prior_handoff', 'agent-a', 'tenant-t1', { session_id: 's-9' })).body).toBeNull()
  })
})

beforeEach(() => { seq = 0 })

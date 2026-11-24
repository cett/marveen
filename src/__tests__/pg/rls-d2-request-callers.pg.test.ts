// The D2 tables (global, privileged only) as the callers that run in a tenant, agent or viewer context reach them. Under the app
// role such a context reads ZERO rows of a D2 table and every write is refused (42501) or deletes nothing, so a caller that does
// not open its own named system job fails in the quiet way (an empty list, a 404, a counter that never moves) or, for an insert,
// loudly. Each cell runs the caller bare, in the context a request or an agent job gives it (runAs.tenant, runAs.agent, or the
// real request opener runAsRequest), on a backend booted as the app role, against rows seeded through the admin pool (the oracle
// that the row exists). A runAs in the test would hide the gap, so the only context is the one the caller is given.
//
// The wrapper never widens a caller's view: the scope the caller decided (a tenant, an agent id list, an id plus a tenant) goes
// into the SQL, and the cross-tenant cells below prove another tenant's row stays out of reach.
//
// Privacy: neutral fixtures only.
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { runAs } from '../../db/context.js'
import { runAsRequest } from '../../db/background-jobs.js'
import {
  deletePendingTaskRetryById, deletePendingTaskRetryByIdForTenant, insertPendingTaskRetryIfNew, listPendingTaskRetries,
  listPendingTaskRetriesForTenant,
} from '../../db/tasks.js'
import { activatePlanForAgent, deactivatePlanForAgent, getActivePlanForAgent, listActivePlansForAgents } from '../../db/claude-plans.js'
import { listPendingChannelRequests } from '../../db/misc.js'
import { recordTokenShadow, resetTokenShadowForTests } from '../../web/token-shadow.js'
import { tryHandleSchedules } from '../../web/routes/schedules.js'
import { inflightKey, persistInflightUpsert, SCHEDULED_INFLIGHT_KEY } from '../../web/schedule-inflight-store.js'
import { tryHandleOverview } from '../../web/routes/overview.js'
import type { RouteContext } from '../../web/routes/types.js'

const made: PgTestDb[] = []
afterEach(async () => { await closePgBackend() })
afterAll(async () => { for (const d of made) await d.close() })
beforeEach(() => { resetTokenShadowForTests() })

/** A booted backend as the app role over a database with two tenants, three schedules and the D2 rows seeded as the owner of the data. */
async function bootedDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-t1', 'Tenant 1', 1), ('tenant-t2', 'Tenant 2', 1) ON CONFLICT DO NOTHING")
  await db.pool.query(`INSERT INTO schedules (id, schedule, agent, type, prompt, tenant_id) VALUES
    ('task-t1', '0 8 * * *', 'agent-t1', 'task', 'p', 'tenant-t1'),
    ('task-t2', '0 8 * * *', 'agent-t2', 'task', 'p', 'tenant-t2')`)
  // one retry row per tenant, and one whose schedule is gone (belongs to no tenant)
  await db.pool.query(`INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason) VALUES
    ('task-t1', 'agent-t1', 1, 1, 1, 'busy'),
    ('task-t2', 'agent-t2', 2, 2, 1, 'busy'),
    ('task-gone', 'agent-t1', 3, 3, 1, 'busy')`)
  await bootPgBackend({ url: db.appUrl })
  return db
}
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e)
const retryNames = async (db: PgTestDb): Promise<string[]> =>
  (await db.pool.query('SELECT task_name FROM pending_task_retries ORDER BY first_attempt')).rows.map((r: { task_name: string }) => r.task_name)

/** The route context a request carries, enough for the schedules and overview routes (the response is captured). */
function routeCtx(method: string, rawPath: string, role: 'admin' | 'agent' | 'viewer', tenantId: string | null): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const req = new EventEmitter() as unknown as RouteContext['req']
  Object.assign(req, { method, headers: {}, destroy: () => {} })
  setImmediate(() => { (req as unknown as EventEmitter).emit('data', Buffer.alloc(0)); (req as unknown as EventEmitter).emit('end') })
  const out: { status: number; body: unknown } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not json */ }
    },
  } as unknown as RouteContext['res']
  const url = new URL(`http://localhost:3420${rawPath}`)
  return { ctx: { req, res, path: url.pathname, method, url, role, tenantId, auth: { kind: 'session' } } as unknown as RouteContext, out }
}
/** Runs a route in the context `runAsRequest` gives the principal, as the web server does. */
const asRequest = <T>(role: 'admin' | 'agent' | 'viewer', tenantId: string | null, fn: () => Promise<T>): Promise<T> =>
  runAsRequest({ authenticated: true, role, tenantId }, fn)

describe('U1: run-now inserts a pending retry as a tenant caller', () => {
  it('the insert lands (a tenant context is refused it without the named system job)', async () => {
    const db = await bootedDb()
    expect(await runAs.tenant('tenant-t1', () => insertPendingTaskRetryIfNew('task-new', 'agent-t1', 9, 'busy'))).toBe(true)
    expect(await retryNames(db)).toContain('task-new')
    // the same pair again is a no-op, not an error (ON CONFLICT DO NOTHING keeps working through the wrapper)
    expect(await runAs.tenant('tenant-t1', () => insertPendingTaskRetryIfNew('task-new', 'agent-t1', 10, 'busy'))).toBe(false)
  })
  it('the same from an agent context (a fleet agent token)', async () => {
    const db = await bootedDb()
    expect(await runAs.agent('agent-t1', 'tenant-t1', () => insertPendingTaskRetryIfNew('task-new', 'agent-t1', 9, 'starting'))).toBe(true)
    expect(await retryNames(db)).toContain('task-new')
  })
})

describe('U10: the durable in-flight mirror of a run-now by a tenant caller', () => {
  it('the entry lands in system_config when a tenant context persists it (refused without the named job, the mirror is lost)', async () => {
    const db = await bootedDb()
    const entry = { taskName: 'task-t1', agentName: 'agent-t1', session: 's', host: null, injectedAt: 5, alerted: false, sawTurn: false, timeoutMs: 1000, blackboardSnapshot: undefined }
    await runAs.tenant('tenant-t1', () => persistInflightUpsert(entry))
    const row = (await db.pool.query('SELECT value FROM system_config WHERE key = $1', [SCHEDULED_INFLIGHT_KEY])).rows[0]
    expect(Object.keys(JSON.parse(row.value as string))).toEqual([inflightKey('task-t1', 'agent-t1')])
  })
})

describe('run-now ownership: a tenant never runs the schedule of another tenant', () => {
  const runNow = (role: 'agent', tenant: string, name: string): { ctx: RouteContext; out: { status: number; body: unknown } } => routeCtx('POST', `/api/schedules/${name}/run`, role, tenant)
  it('as the app role the other tenant schedule is not even visible: 404 and no retry row, no in-flight mirror (end to end)', async () => {
    const db = await bootedDb()
    const { ctx, out } = runNow('agent', 'tenant-t1', 'task-t2')
    await asRequest('agent', 'tenant-t1', () => tryHandleSchedules(ctx))
    expect(out.status).toBe(404)
    expect(await retryNames(db)).toEqual(['task-t1', 'task-t2', 'task-gone'])
    expect((await db.pool.query('SELECT 1 FROM system_config WHERE key = $1', [SCHEDULED_INFLIGHT_KEY])).rowCount).toBe(0)
  })
  it('the route guard itself, with the row visible (a system context, as on a backend without row-level security): 404 and no retry row', async () => {
    // Under the app role the row-level policy hides the foreign schedule before the guard is reached, so the guard
    // (crossTenantBlocked in routes/schedules.ts) is pinned here with the row VISIBLE: it alone must answer 404, and the
    // pending retry row that the system insert of run-now would write must not appear.
    const db = await bootedDb()
    const { ctx, out } = runNow('agent', 'tenant-t1', 'task-t2')
    await runAs.system('probe', () => tryHandleSchedules(ctx))
    expect(out.status).toBe(404)
    expect(await retryNames(db)).toEqual(['task-t1', 'task-t2', 'task-gone'])
  })
})

describe('U2 / U4: the pending retries a tenant caller reads are those of its own schedules', () => {
  it('each tenant reads its own row; the other tenant row and the orphan row (schedule gone) stay out (function)', async () => {
    await bootedDb()
    const t1 = await runAs.tenant('tenant-t1', () => listPendingTaskRetriesForTenant('tenant-t1'))
    const t2 = await runAs.tenant('tenant-t2', () => listPendingTaskRetriesForTenant('tenant-t2'))
    expect(t1.map((r) => r.task_name)).toEqual(['task-t1'])
    expect(t2.map((r) => r.task_name)).toEqual(['task-t2'])
    expect(await runAs.tenant('tenant-t1', () => listPendingTaskRetriesForTenant('tenant-unknown'))).toEqual([])
  })
  it('the unscoped list stays the admin and runner view: all three rows, in the admin context only', async () => {
    await bootedDb()
    expect((await runAs.admin('probe', () => listPendingTaskRetries())).map((r) => r.task_name)).toEqual(['task-t1', 'task-t2', 'task-gone'])
    // the unscoped function is NOT widened by this work: a tenant context still reads nothing of it
    expect(await runAs.tenant('tenant-t1', () => listPendingTaskRetries())).toEqual([])
  })
  it('GET /api/schedules/pending: a tenant caller gets its own row, never the other tenant or the orphan (route)', async () => {
    await bootedDb()
    const { ctx, out } = routeCtx('GET', '/api/schedules/pending', 'agent', 'tenant-t1')
    expect(await asRequest('agent', 'tenant-t1', () => tryHandleSchedules(ctx))).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as Array<{ taskName?: string; task_name?: string }>).map((r) => r.taskName ?? r.task_name)).toEqual(['task-t1'])
  })
  it('GET /api/schedules/pending: the other tenant caller gets only its own row (route)', async () => {
    await bootedDb()
    const { ctx, out } = routeCtx('GET', '/api/schedules/pending', 'agent', 'tenant-t2')
    await asRequest('agent', 'tenant-t2', () => tryHandleSchedules(ctx))
    expect((out.body as Array<{ taskName?: string; task_name?: string }>).map((r) => r.taskName ?? r.task_name)).toEqual(['task-t2'])
  })
  it('GET /api/schedules/pending: an admin without a filter reads every row, with ?tenant= one tenant (route)', async () => {
    await bootedDb()
    const all = routeCtx('GET', '/api/schedules/pending', 'admin', null)
    await asRequest('admin', null, () => tryHandleSchedules(all.ctx))
    expect((all.out.body as unknown[]).length).toBe(3)
    const one = routeCtx('GET', '/api/schedules/pending?tenant=tenant-t2', 'admin', null)
    await asRequest('admin', null, () => tryHandleSchedules(one.ctx))
    expect((one.out.body as Array<{ taskName?: string; task_name?: string }>).map((r) => r.taskName ?? r.task_name)).toEqual(['task-t2'])
  })
  it('GET /api/schedules/dead-letter: the pending half is the caller tenant only (route)', async () => {
    await bootedDb()
    const { ctx, out } = routeCtx('GET', '/api/schedules/dead-letter', 'agent', 'tenant-t1')
    await asRequest('agent', 'tenant-t1', () => tryHandleSchedules(ctx))
    const items = (out.body as { items: Array<{ kind: string; task: string }> }).items.filter((i) => i.kind === 'pending')
    expect(items.map((i) => i.task)).toEqual(['task-t1'])
  })
})

describe('U3: cancelling a pending retry needs the id AND the tenant of its schedule', () => {
  it('a tenant cancels its own row (function), the row is gone', async () => {
    const db = await bootedDb()
    const id = (await db.pool.query("SELECT id FROM pending_task_retries WHERE task_name = 'task-t1'")).rows[0].id as number
    expect(await runAs.tenant('tenant-t1', () => deletePendingTaskRetryByIdForTenant(Number(id), 'tenant-t1'))).toBe(true)
    expect(await retryNames(db)).toEqual(['task-t2', 'task-gone'])
  })
  it('the other tenant id, an orphan row and an unknown id delete nothing (cross-tenant)', async () => {
    const db = await bootedDb()
    const ids = Object.fromEntries((await db.pool.query('SELECT id, task_name FROM pending_task_retries')).rows.map((r: { id: number; task_name: string }) => [r.task_name, Number(r.id)]))
    expect(await runAs.tenant('tenant-t2', () => deletePendingTaskRetryByIdForTenant(ids['task-t1'], 'tenant-t2'))).toBe(false)
    expect(await runAs.tenant('tenant-t1', () => deletePendingTaskRetryByIdForTenant(ids['task-gone'], 'tenant-t1'))).toBe(false)
    expect(await runAs.tenant('tenant-t1', () => deletePendingTaskRetryByIdForTenant(999999, 'tenant-t1'))).toBe(false)
    expect(await retryNames(db)).toEqual(['task-t1', 'task-t2', 'task-gone'])
  })
  it('DELETE /api/schedules/pending/:id: own row 200, the other tenant row 404 and still there (route)', async () => {
    const db = await bootedDb()
    const ids = Object.fromEntries((await db.pool.query('SELECT id, task_name FROM pending_task_retries')).rows.map((r: { id: number; task_name: string }) => [r.task_name, Number(r.id)]))
    const foreign = routeCtx('DELETE', `/api/schedules/pending/${ids['task-t2']}`, 'agent', 'tenant-t1')
    await asRequest('agent', 'tenant-t1', () => tryHandleSchedules(foreign.ctx))
    expect(foreign.out.status).toBe(404)
    expect(await retryNames(db)).toContain('task-t2')
    const own = routeCtx('DELETE', `/api/schedules/pending/${ids['task-t1']}`, 'agent', 'tenant-t1')
    await asRequest('agent', 'tenant-t1', () => tryHandleSchedules(own.ctx))
    expect(own.out.status).toBe(200)
    expect(await retryNames(db)).toEqual(['task-t2', 'task-gone'])
  })
  it('DELETE /api/schedules/pending/:id: an admin cancels any row, the orphan included (route)', async () => {
    const db = await bootedDb()
    const orphan = Number((await db.pool.query("SELECT id FROM pending_task_retries WHERE task_name = 'task-gone'")).rows[0].id)
    expect((await runAs.admin('probe', () => deletePendingTaskRetryById(orphan)))).toBe(true)
    expect(await retryNames(db)).toEqual(['task-t1', 'task-t2'])
  })
})

describe('U5 / U6: the active plan binding of an agent, read and released from a request or an agent job', () => {
  async function planDb(): Promise<PgTestDb> {
    const db = await bootedDb()
    await db.pool.query("INSERT INTO claude_plans_registry (id, label, config_dir, plan_type) VALUES ('plan-a', 'Plan A', '/p', 'personal')")
    await db.pool.query("INSERT INTO agent_active_plans (agent_id, plan_id, source) VALUES ('agent-t1', 'plan-a', 'manual'), ('agent-t2', 'plan-a', 'manual')")
    return db
  }
  it('the blackboard list reads the bindings of the agent ids it names, and only those (U5)', async () => {
    await planDb()
    const map = await runAs.tenant('tenant-t1', () => listActivePlansForAgents(['agent-t1']))
    expect([...map.keys()]).toEqual(['agent-t1'])
    expect(map.get('agent-t1')?.id).toBe('plan-a')
    expect((await runAs.tenant('tenant-t1', () => listActivePlansForAgents([]))).size).toBe(0)
  })
  it('an agent job (the context guard restart) reads the plan of its agent (U6 marker read)', async () => {
    await planDb()
    const plan = await runAs.agent('agent-t1', 'tenant-t1', () => getActivePlanForAgent('agent-t1'))
    expect(plan?.id).toBe('plan-a')
    expect(await runAs.agent('agent-t1', 'tenant-t1', () => getActivePlanForAgent('agent-none'))).toBeNull()
  })
  it('a done blackboard post or an agent stop releases the binding of THAT agent only (U6)', async () => {
    const db = await planDb()
    await runAs.agent('agent-t1', 'tenant-t1', () => deactivatePlanForAgent('agent-t1'))
    const left = (await db.pool.query('SELECT agent_id FROM agent_active_plans ORDER BY agent_id')).rows.map((r: { agent_id: string }) => r.agent_id)
    expect(left).toEqual(['agent-t2'])
  })
  it('the handoff recovery at an agent start binds the plan again (U6 activate)', async () => {
    const db = await planDb()
    await runAs.agent('agent-t1', 'tenant-t1', () => deactivatePlanForAgent('agent-t1'))
    await runAs.agent('agent-t1', 'tenant-t1', () => activatePlanForAgent('agent-t1', 'plan-a', 'handoff-recovery'))
    const row = (await db.pool.query("SELECT source FROM agent_active_plans WHERE agent_id = 'agent-t1'")).rows[0]
    expect(row?.source).toBe('handoff-recovery')
  })
})

describe('U7: the legacy scheduled_tasks counter on the overview is for the global admin only', () => {
  async function overviewStuck(role: 'admin' | 'agent' | 'viewer', tenantId: string | null): Promise<unknown> {
    const { ctx, out } = routeCtx('GET', '/api/overview', role, tenantId)
    await asRequest(role, tenantId, () => tryHandleOverview(ctx))
    expect(out.status).toBe(200)
    const body = out.body as Record<string, unknown>
    return (body.stuckTasks ?? (body.counts as Record<string, unknown> | undefined)?.stuckTasks ?? (body.stats as Record<string, unknown> | undefined)?.stuckTasks)
  }
  it('a global admin counts the stuck task, a tenant caller and a viewer get no figure (route)', async () => {
    const db = await bootedDb()
    await db.pool.query("INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES ('st-a', 'c', 'p', '* * * * *', 1, 1)")
    // the figure is an admin-only field of the response (the route spreads it in under isAdmin): a non-admin response carries no
    // figure at all, and the route does not run the query for it (a tenant context would read zero rows, silently)
    expect(await overviewStuck('admin', null)).toBe(1)
    expect(await overviewStuck('agent', 'tenant-t1')).toBeUndefined()
    expect(await overviewStuck('viewer', null)).toBeUndefined()
  })
})

describe('U8: the pending channel requests of an agent', () => {
  it('a tenant caller reads the requests of the agent name the route already scoped (the agent tenant guard answers 404 before this)', async () => {
    const db = await bootedDb()
    await db.pool.query("INSERT INTO pending_channel_requests (agent, channel_id, requested_at) VALUES ('agent-t1', 'chan-a', 1), ('agent-t2', 'chan-b', 2)")
    const rows = await runAs.tenant('tenant-t1', () => listPendingChannelRequests('agent-t1'))
    expect(rows.map((r) => r.channel_id)).toEqual(['chan-a'])
  })
})

describe('U9: the shadow counter written from a route handler of a fleet agent', () => {
  it('the counter row lands and a second record of the same shape moves it (an agent context is refused the write without the job)', async () => {
    const db = await bootedDb()
    const base = { method: 'POST', route: '/api/messages', client: 'other', caller: 'agent-t1', callerSource: 'none' } as const
    expect(await runAs.agent('agent-t1', 'tenant-t1', () => recordTokenShadow(base, { category: 'shared_token_use', target: '' }))).toBe(true)
    expect(await runAs.agent('agent-t1', 'tenant-t1', () => recordTokenShadow(base, { category: 'shared_token_use', target: '' }))).toBe(true)
    const rows = (await db.pool.query('SELECT category, count FROM token_usage_shadow')).rows
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].count)).toBe(2)
  })
  it('a failed write is reported as false, not thrown (the contract of the counter is kept)', async () => {
    await bootedDb()
    await closePgBackend()
    const base = { method: 'POST', route: '/api/messages', client: 'other', caller: 'agent-t1', callerSource: 'none' } as const
    const err = await failure(runAs.agent('agent-t1', 'tenant-t1', () => recordTokenShadow(base, { category: 'shared_token_use', target: '' })))
    expect(err).toBeUndefined() // never throws, whatever the backend does
  })
})

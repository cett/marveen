// Schedule PUT allowlist, (tenant, agent) pair validation and tenant-scoped
// /agents and /pending, through the REAL route + DB (no persistence mocks).
//
// Fleet: main-agent (main), shared-agent (enabled in default AND tenant-b), tenant-agent (main agent of
// tenant-b), fleet-agent (no tenant row -> a default-tenant agent). Each assertion is the
// negative half of a rule: the write that must NOT land, checked on the stored row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  currentBotName: () => 'Main',
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: vi.fn().mockReturnValue(['shared-agent', 'tenant-agent', 'fleet-agent']),
}))
vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn(),
  loadLastTickMs: vi.fn().mockReturnValue(null),
  computeTickStatus: vi.fn(),
}))

let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let route: typeof import('../web/routes/schedules.js')

type Caller = 'human' | 'agent-token' | { tenant: string }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-tenant-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')

  dbMod.createTenant('tenant-b', 'Tenant B')
  dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  dbMod.setTenantAgentAvailability('default', 'shared-agent', true)

  const base = { description: 'd', prompt: 'p', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
  dbMod.upsertSchedule('t-default', { ...base, agent: 'fleet-agent', type: 'task', tenant_id: 'default', status: 'live' })
  dbMod.upsertSchedule('t-tenant-b', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'live' })
  dbMod.upsertSchedule('t-legacy', { ...base, agent: 'fleet-agent', type: 'task', tenant_id: null, status: 'live' })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: object, caller: Caller = 'human') {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = method
  req.headers = {}
  req.destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: unknown } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const principal = typeof caller === 'string'
    ? { role: 'admin', tenantId: null, auth: { kind: caller === 'human' ? 'session' : 'token' } }
    : { role: 'agent', tenantId: caller.tenant, auth: { kind: 'token' } }
  const ctx = { req, res, path: url.pathname, method, url, ...principal } as unknown as RouteContext
  await route.tryHandleSchedules(ctx)
  return out as { status: number; body: Record<string, unknown> & unknown[] }
}

const row = (name: string) => {
  const r = dbMod.getScheduleFromDb(name)
  if (!r) return undefined
  const { updated_at: _u, ...rest } = r as unknown as Record<string, unknown>
  return rest
}

describe('PUT body allowlist', () => {
  it('drops status, tenantId and the runner-script keys for every caller', async () => {
    dbMod.upsertSchedule('t-draft', {
      description: 'd', prompt: 'p', schedule: '0 9 * * *', agent: 'fleet-agent', type: 'task',
      enabled: true, skip_if_busy: false, force_send: false, tenant_id: 'default', status: 'draft',
    })
    const before = row('t-draft')
    const out = await call('PUT', '/api/schedules/t-draft', {
      status: 'live', tenantId: 'tenant-b', preCheck: '/tmp/evil.sh', catchUpMaxAgeMinutes: 9, stuckAfterMinutes: 9,
      requires: { mcp_servers: ['x'] }, description: 'edited',
    }, 'agent-token')
    expect(out.status).toBe(200)
    // Only the allowed field moved: a draft stays a draft, the tenant stays.
    expect(row('t-draft')).toEqual({ ...before, description: 'edited' })
  })

  it('a tenant caller cannot re-point a task at another agent', async () => {
    const before = row('t-default')
    await call('PUT', '/api/schedules/t-default', { agent: 'shared-agent', description: 'x' }, { tenant: 'default' })
    // (t-default has tenant_id 'default', so the tenant caller reaches it.)
    expect(row('t-default')).toEqual({ ...before, description: 'x' })
  })

  const everyField = {
    description: 'a', prompt: 'b', schedule: '5 4 * * *', agent: 'shared-agent', skipIfBusy: true, forceSend: true, enabled: false,
  }

  it('a human admin may edit every allowed field and the agent, and the task stays live', async () => {
    const out = await call('PUT', '/api/schedules/t-default', everyField, 'human')
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
    expect(row('t-default')).toMatchObject({
      description: 'a', prompt: 'b', schedule: '5 4 * * *', agent: 'shared-agent', skip_if_busy: 1, force_send: 1, enabled: 0,
      status: 'live', tenant_id: 'default',
    })
  })

  it('an agent on the shared token may write the same fields, but the task goes back to review', async () => {
    const out = await call('PUT', '/api/schedules/t-default', everyField, 'agent-token')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, status: 'pending_review', review_required: true })
    expect(row('t-default')).toMatchObject({
      description: 'a', prompt: 'b', schedule: '5 4 * * *', agent: 'shared-agent', skip_if_busy: 1, force_send: 1, enabled: 0,
      status: 'pending_review', tenant_id: 'default',
    })
  })
})

describe('PUT agent change keeps the (tenant, agent) pair valid', () => {
  it.each([
    ['an tenant-b-only agent on a default task', 't-default', 'tenant-agent'],
    ['the fleet main agent on an tenant-b task', 't-tenant-b', 'main-agent'],
    ['"all" on an tenant-b task', 't-tenant-b', 'all'],
    ['an agent that does not exist', 't-default', 'nobody'],
    ['a default-only agent on an tenant-b task', 't-tenant-b', 'fleet-agent'],
  ])('rejects %s', async (_label, task, agent) => {
    const before = row(task)
    const out = await call('PUT', `/api/schedules/${task}`, { agent })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'agent' })
    expect(row(task)).toEqual(before)
  })

  it('accepts a shared agent on both tenants, and "all" on the default tenant', async () => {
    expect((await call('PUT', '/api/schedules/t-tenant-b', { agent: 'shared-agent' })).status).toBe(200)
    expect(row('t-tenant-b')).toMatchObject({ agent: 'shared-agent' })
    expect((await call('PUT', '/api/schedules/t-default', { agent: 'shared-agent' })).status).toBe(200)
    expect((await call('PUT', '/api/schedules/t-default', { agent: 'all' })).status).toBe(200)
    expect(row('t-default')).toMatchObject({ agent: 'all' })
  })

  it('re-sending the stored agent never trips the check (a legacy pair stays editable)', async () => {
    const out = await call('PUT', '/api/schedules/t-tenant-b', { agent: 'tenant-agent', description: 'x' })
    expect(out.status).toBe(200)
  })

  it('a task with no tenant (pre-migration) is validated as the default tenant', async () => {
    expect((await call('PUT', '/api/schedules/t-legacy', { agent: 'tenant-agent' })).status).toBe(400)
    expect((await call('PUT', '/api/schedules/t-legacy', { agent: 'shared-agent' })).status).toBe(200)
  })
})

describe('PUT tenant move', () => {
  it('a human admin moves the task, the pair is re-checked, and it goes back to draft', async () => {
    const out = await call('PUT', '/api/schedules/t-default', { tenant_id: 'tenant-b', agent: 'shared-agent' })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, tenant_id: 'tenant-b', status: 'draft' })
    expect(row('t-default')).toMatchObject({ tenant_id: 'tenant-b', status: 'draft', agent: 'shared-agent' })
  })

  it('refuses the move when the stored agent does not serve the target tenant', async () => {
    const before = row('t-default')
    const out = await call('PUT', '/api/schedules/t-default', { tenant_id: 'tenant-b' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'tenant_id' })
    expect(row('t-default')).toEqual(before)
  })

  it('refuses a move to a missing or disabled tenant', async () => {
    dbMod.updateTenant('tenant-b', { disabled: true })
    const before = row('t-tenant-b')
    for (const tenant_id of ['nope', 'tenant-b']) {
      const out = await call('PUT', '/api/schedules/t-default', { tenant_id, agent: 'shared-agent' })
      expect(out.status).toBe(400)
    }
    expect(row('t-default')).toMatchObject({ tenant_id: 'default' })
    expect(row('t-tenant-b')).toEqual(before)
  })

  it.each([
    ['an agent-token admin', 'agent-token' as Caller],
    ['a tenant caller', { tenant: 'default' } as Caller],
  ])('is refused for %s and changes nothing', async (_label, caller) => {
    const before = row('t-default')
    const out = await call('PUT', '/api/schedules/t-default', { tenant_id: 'tenant-b', agent: 'shared-agent' }, caller)
    expect(out.status).toBe(403)
    expect(row('t-default')).toEqual(before)
  })

  it('moving to the tenant it is already in is a no-op, not a draft reset', async () => {
    const out = await call('PUT', '/api/schedules/t-default', { tenant_id: 'default' }, 'agent-token')
    expect(out.status).toBe(200)
    expect(row('t-default')).toMatchObject({ status: 'live', tenant_id: 'default' })
  })
})

describe('GET /api/schedules/agents', () => {
  const names = (b: unknown) => (b as { name: string }[]).map(a => a.name).sort()

  it('an admin sees every agent, or the agents of the tenant picked', async () => {
    expect(names((await call('GET', '/api/schedules/agents')).body)).toEqual(['fleet-agent', 'main-agent', 'shared-agent', 'tenant-agent'])
    expect(names((await call('GET', '/api/schedules/agents?tenant=tenant-b')).body)).toEqual(['shared-agent', 'tenant-agent'])
    expect(names((await call('GET', '/api/schedules/agents?tenant=default')).body)).toEqual(['fleet-agent', 'main-agent', 'shared-agent'])
  })

  it('a tenant caller only sees the agents serving their own tenant, whatever ?tenant= says', async () => {
    expect(names((await call('GET', '/api/schedules/agents', undefined, { tenant: 'tenant-b' })).body)).toEqual(['shared-agent', 'tenant-agent'])
    expect(names((await call('GET', '/api/schedules/agents?tenant=default', undefined, { tenant: 'tenant-b' })).body)).toEqual(['shared-agent', 'tenant-agent'])
    expect(names((await call('GET', '/api/schedules/agents', undefined, { tenant: 'default' })).body)).toEqual(['fleet-agent', 'main-agent', 'shared-agent'])
  })
})

describe('pending retries are scoped to the schedule\'s tenant', () => {
  beforeEach(() => {
    dbMod.upsertPendingTaskRetry('t-default', 'fleet-agent', 1000, 'busy')
    dbMod.upsertPendingTaskRetry('t-tenant-b', 'tenant-agent', 1000, 'busy')
    dbMod.upsertPendingTaskRetry('gone-task', 'fleet-agent', 1000, 'busy')
  })
  const tasks = (b: unknown) => (b as { task_name?: string; taskName?: string; name?: string }[]).map(r => r.task_name ?? r.taskName ?? r.name).sort()

  it('an admin sees all, a tenant caller only their tenant\'s', async () => {
    expect(tasks((await call('GET', '/api/schedules/pending')).body)).toEqual(['gone-task', 't-default', 't-tenant-b'])
    expect(tasks((await call('GET', '/api/schedules/pending', undefined, { tenant: 'tenant-b' })).body)).toEqual(['t-tenant-b'])
    expect(tasks((await call('GET', '/api/schedules/pending', undefined, { tenant: 'default' })).body)).toEqual(['t-default'])
  })

  it('a tenant caller cannot cancel another tenant\'s retry (or one whose schedule is gone)', async () => {
    const all = dbMod.listPendingTaskRetries()
    for (const r of all.filter(x => x.task_name !== 't-tenant-b')) {
      const out = await call('DELETE', `/api/schedules/pending/${r.id}`, undefined, { tenant: 'tenant-b' })
      expect(out.status).toBe(404)
    }
    expect(dbMod.listPendingTaskRetries().map(r => r.task_name).sort()).toEqual(['gone-task', 't-default', 't-tenant-b'])
    const own = all.find(x => x.task_name === 't-tenant-b')!
    expect((await call('DELETE', `/api/schedules/pending/${own.id}`, undefined, { tenant: 'tenant-b' })).status).toBe(200)
    expect(dbMod.listPendingTaskRetries().map(r => r.task_name).sort()).toEqual(['gone-task', 't-default'])
  })
})

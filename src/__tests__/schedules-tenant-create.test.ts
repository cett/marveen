// Every schedule belongs to a tenant: migration 0066, the tenant sources of POST /api/schedules,
// the (tenant, agent) pair rule at creation, and the file mirror / reseed path never producing a
// tenant-less task. Real route + DB + a tmp HOME, no persistence mocks.
//
// Fleet: main-agent (fleet main), shared-agent (enabled in default AND tenant-b), tenant-agent
// (main agent of tenant-b), fleet-agent (enabled nowhere -> default).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const ROOT = join(__dirname, '..', '..')
let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let io: typeof import('../web/scheduled-tasks-io.js')
let route: typeof import('../web/routes/schedules.js')

type Caller = 'human' | 'agent-token' | { tenant: string }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-tenant-create-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  delete process.env['TENANT_CONTEXT_MAX_AGE_SECONDS']
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  io = await import('../web/scheduled-tasks-io.js')
  route = await import('../web/routes/schedules.js')

  dbMod.createTenant('tenant-b', 'Tenant B')
  dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  dbMod.setTenantAgentAvailability('default', 'shared-agent', true)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: object, caller: Caller = 'human', headers: Record<string, string> = {}) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = method
  req.headers = headers
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
  return out as { status: number; body: Record<string, unknown> }
}

const base = { description: 'd', prompt: 'p', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
const create = (name: string, extra: object = {}) => ({ name, prompt: 'p', schedule: '0 9 * * *', ...extra })
const tenantOf = (name: string) => dbMod.getScheduleFromDb(name)?.tenant_id
const setContext = (agent: string, tenant: string, status: string, ageSeconds = 0) =>
  dbMod.getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)')
    .run(agent, tenant, status, Math.floor(Date.now() / 1000) - ageSeconds)

describe('migration 0066', () => {
  const sql = readFileSync(join(ROOT, 'src', 'migrations', '0066_schedules_tenant_default.sql'), 'utf-8')
  const rows = () => dbMod.getDb().prepare('SELECT id, tenant_id FROM schedules ORDER BY id').all()

  it('gives every tenant-less schedule the default tenant, leaves the others, and is idempotent', () => {
    dbMod.upsertSchedule('a-null', { ...base, agent: 'main-agent', type: 'task', tenant_id: null })
    dbMod.upsertSchedule('b-null', { ...base, agent: 'fleet-agent', type: 'task', tenant_id: null })
    dbMod.upsertSchedule('c-tenant', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b' })
    dbMod.upsertSchedule('d-default', { ...base, agent: 'main-agent', type: 'task', tenant_id: 'default' })

    dbMod.getDb().exec(sql)
    const once = rows()
    expect(once).toEqual([
      { id: 'a-null', tenant_id: 'default' }, { id: 'b-null', tenant_id: 'default' },
      { id: 'c-tenant', tenant_id: 'tenant-b' }, { id: 'd-default', tenant_id: 'default' },
    ])
    dbMod.getDb().exec(sql)
    expect(rows()).toEqual(once)
  })
})

describe('a stored NULL tenant (before the migration) reads as the default tenant', () => {
  it('rowToTask, the default tenant list and the item routes all agree', async () => {
    dbMod.upsertSchedule('legacy', { ...base, agent: 'main-agent', type: 'task', tenant_id: null, status: 'live' })
    expect(io.rowToTask(dbMod.getScheduleFromDb('legacy')!).tenantId).toBe('default')
    expect(dbMod.listSchedulesFromDb({ tenantId: 'default' }).map(r => r.id)).toEqual(['legacy'])
    expect(dbMod.listSchedulesFromDb({ tenantId: 'tenant-b' })).toEqual([])
    expect((await call('PUT', '/api/schedules/legacy', { description: 'x' }, { tenant: 'default' })).status).toBe(200)
    expect((await call('PUT', '/api/schedules/legacy', { description: 'y' }, { tenant: 'tenant-b' })).status).toBe(404)
  })

  it('any write, even a toggle, stores the tenant as default instead of NULL', () => {
    dbMod.upsertSchedule('legacy', { ...base, agent: 'main-agent', type: 'task', tenant_id: null, status: 'live' })
    io.writeScheduledTask('legacy', { enabled: false })
    expect(tenantOf('legacy')).toBe('default')
    // and an explicit null cannot un-tenant a task either
    io.writeScheduledTask('legacy', { tenantId: null })
    expect(tenantOf('legacy')).toBe('default')
  })

  it('the list endpoint exposes each task\'s tenant', async () => {
    dbMod.upsertSchedule('t1', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b' })
    const out = await call('GET', '/api/schedules')
    expect((out.body as unknown as { name: string; tenantId: string }[]).find(r => r.name === 't1')?.tenantId).toBe('tenant-b')
  })
})

describe('POST: which tenant owns the task', () => {
  it('1. an admin names the tenant (human or token)', async () => {
    expect((await call('POST', '/api/schedules', create('p1', { tenant_id: 'tenant-b', agent: 'tenant-agent' }), 'human')).status).toBe(200)
    expect(tenantOf('p1')).toBe('tenant-b')
    expect((await call('POST', '/api/schedules', create('p2', { tenant_id: 'tenant-b', agent: 'shared-agent' }), 'agent-token')).status).toBe(200)
    expect(tenantOf('p2')).toBe('tenant-b')
  })

  it('2. a non-admin caller always gets its own tenant, whatever it sends', async () => {
    const out = await call('POST', '/api/schedules', create('p3', { tenant_id: 'default', agent: 'tenant-agent' }), { tenant: 'tenant-b' })
    expect(out.status).toBe(200)
    expect(tenantOf('p3')).toBe('tenant-b')
  })

  it('4. a human who names none gets the default tenant, never NULL', async () => {
    expect((await call('POST', '/api/schedules', create('p4'), 'human')).status).toBe(200)
    expect(tenantOf('p4')).toBe('default')
  })

  describe('3. an agent on the shared token (X-Agent-Id) gets the tenant of the request it is serving', () => {
    const post = (name: string, agentId: string | null, extra: object = {}) =>
      call('POST', '/api/schedules', create(name, extra), 'agent-token', agentId ? { 'x-agent-id': agentId } : {})

    it('a bound context: that tenant', async () => {
      setContext('shared-agent', 'tenant-b', 'bound')
      const out = await post('s1', 'shared-agent', { agent: 'shared-agent' })
      expect(out.status).toBe(200)
      expect(out.body).toMatchObject({ status: 'draft' })
      expect(tenantOf('s1')).toBe('tenant-b')
    })

    it('a default context (a request from the local operator): the default tenant', async () => {
      setContext('shared-agent', 'default', 'default')
      expect((await post('s2', 'shared-agent', { agent: 'shared-agent' })).status).toBe(200)
      expect(tenantOf('s2')).toBe('default')
    })

    it.each([
      ['no context at all', () => undefined],
      ['an unknown context', () => setContext('shared-agent', '', 'unknown')],
      ['a conflicting context', () => setContext('shared-agent', '', 'conflict')],
      ['a stale context', () => setContext('shared-agent', 'tenant-b', 'bound', 13 * 3600)],
      ['a bound tenant the agent no longer serves (and it still serves two others)', () => {
        dbMod.createTenant('tenant-c', 'Tenant C')
        dbMod.setTenantAgentAvailability('tenant-c', 'shared-agent', true)
        dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', false)
        setContext('shared-agent', 'tenant-b', 'bound')
      }],
    ])('a shared agent with %s: 400 tenant_required, nothing is written', async (_label, arrange) => {
      arrange()
      const out = await post('s3', 'shared-agent', { agent: 'shared-agent' })
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'tenant_required', field: 'tenant_id' })
      expect(dbMod.getScheduleFromDb('s3')).toBeUndefined()
    })

    it('a single-tenant agent without context falls back to its own tenant', async () => {
      const out = await post('s4', 'tenant-agent', { agent: 'tenant-agent' })
      expect(out.status).toBe(200)
      expect(tenantOf('s4')).toBe('tenant-b')
      expect((await post('s5', 'fleet-agent', { agent: 'fleet-agent' })).status).toBe(200)
      expect(tenantOf('s5')).toBe('default')
    })

    it('an explicit tenant_id wins over the claimed agent\'s context', async () => {
      setContext('shared-agent', 'tenant-b', 'bound')
      expect((await post('s6', 'shared-agent', { agent: 'shared-agent', tenant_id: 'default' })).status).toBe(200)
      expect(tenantOf('s6')).toBe('default')
    })

    it('the token with no X-Agent-Id and no tenant_id is refused, not filed under a guess', async () => {
      const out = await post('s7', null)
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'tenant_required' })
      expect(dbMod.getScheduleFromDb('s7')).toBeUndefined()
    })
  })
})

describe('POST: the (tenant, agent) pair', () => {
  const rejected = async (extra: object, field: string) => {
    const out = await call('POST', '/api/schedules', create('x1', extra), 'human')
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ field })
    expect(dbMod.getScheduleFromDb('x1')).toBeUndefined()
    return out
  }

  it('refuses an agent that does not serve the tenant', async () => {
    await rejected({ tenant_id: 'tenant-b', agent: 'fleet-agent' }, 'agent')
    await rejected({ tenant_id: 'default', agent: 'tenant-agent' }, 'agent')
  })

  it('refuses the fleet main agent, and "all", on a non-default tenant', async () => {
    await rejected({ tenant_id: 'tenant-b', agent: 'main-agent' }, 'agent')
    await rejected({ tenant_id: 'tenant-b', agent: 'all' }, 'agent')
  })

  it('refuses an unknown agent', async () => {
    await rejected({ agent: 'nobody' }, 'agent')
  })

  it('a non-default tenant needs an agent named (the fleet main agent is not a default there)', async () => {
    const out = await rejected({ tenant_id: 'tenant-b' }, 'agent')
    expect(out.body).toMatchObject({ error: 'required' })
  })

  it('refuses an unknown or disabled tenant', async () => {
    await rejected({ tenant_id: 'nope', agent: 'shared-agent' }, 'tenant_id')
    dbMod.updateTenant('tenant-b', { disabled: true })
    await rejected({ tenant_id: 'tenant-b', agent: 'tenant-agent' }, 'tenant_id')
  })

  it('accepts a shared agent on both tenants, and "all" and the main agent on the default tenant', async () => {
    for (const [name, extra] of [
      ['ok1', { tenant_id: 'tenant-b', agent: 'shared-agent' }],
      ['ok2', { tenant_id: 'default', agent: 'shared-agent' }],
      ['ok3', { tenant_id: 'default', agent: 'all' }],
      ['ok4', {}],
    ] as const) {
      expect((await call('POST', '/api/schedules', create(name, extra), 'human')).status).toBe(200)
    }
    expect(dbMod.getScheduleFromDb('ok4')).toMatchObject({ agent: 'main-agent', tenant_id: 'default' })
  })
})

describe('file mirror and reseed never produce a tenant-less task', () => {
  const cfgPath = (name: string) => join(tmp, '.claude', 'scheduled-tasks', name, 'task-config.json')

  it('the mirror records the tenant and reads it back', async () => {
    await call('POST', '/api/schedules', create('m1', { tenant_id: 'tenant-b', agent: 'tenant-agent' }), 'human')
    expect(JSON.parse(readFileSync(cfgPath('m1'), 'utf-8'))).toMatchObject({ tenantId: 'tenant-b', agent: 'tenant-agent' })
    expect(io.readScheduledTask('m1')?.tenantId).toBe('tenant-b')
    await call('POST', '/api/schedules', create('m2'), 'human')
    expect(JSON.parse(readFileSync(cfgPath('m2'), 'utf-8'))).toMatchObject({ tenantId: 'default' })
  })

  it('an empty table reseeded from the files keeps each task\'s tenant and defaults the rest', () => {
    const put = (name: string, cfg: object) => {
      mkdirSync(join(tmp, '.claude', 'scheduled-tasks', name), { recursive: true })
      writeFileSync(cfgPath(name), JSON.stringify({ schedule: '0 9 * * *', agent: 'main-agent', enabled: true, type: 'command', command: 'true', ...cfg }))
    }
    put('f-named', { tenantId: 'tenant-b', agent: 'tenant-agent' })
    put('f-plain', {})      // a seed task-config without tenantId
    put('f-blank', { tenantId: '  ' })
    expect(io.seedSchedulesFromFilesIfEmpty()).toBe(3)
    expect(tenantOf('f-named')).toBe('tenant-b')
    expect(tenantOf('f-plain')).toBe('default')
    expect(tenantOf('f-blank')).toBe('default')
  })
})

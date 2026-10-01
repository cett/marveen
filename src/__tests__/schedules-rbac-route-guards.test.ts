// Route-level rules for non-admin callers of /api/schedules*, and the per-tenant cap on tasks
// waiting for review, through the REAL route + DB (no persistence mocks). They hold whatever
// RBAC_MODE is, so each test names the request that must be refused and checks the stored row.
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
let io: typeof import('../web/scheduled-tasks-io.js')

type Principal = { role: string; tenantId: string | null; auth: Record<string, unknown>; agentId?: string }
const human: Principal = { role: 'admin', tenantId: null, auth: { kind: 'session', user: 'owner' } }
const sharedToken: Principal = { role: 'admin', tenantId: null, auth: { kind: 'token' } }
const session = (role: string, tenantId: string | null): Principal => ({ role, tenantId, auth: { kind: 'session', user: 'u' } })
const token = (tenantId: string): Principal => ({ role: 'agent', tenantId, auth: { kind: 'token', tokenName: 'ci-key' } })
const device: Principal = { role: 'agent', tenantId: 'default', auth: { kind: 'device', device: 'phone', deviceId: 1 } }
const federation: Principal = { role: 'agent', tenantId: 'tenant-b', auth: { kind: 'federation', peer: 'p' } }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-guards-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')
  io = await import('../web/scheduled-tasks-io.js')

  dbMod.createTenant('tenant-b', 'Tenant B')
  dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  dbMod.setTenantAgentAvailability('default', 'shared-agent', true)

  const base = { description: 'Daily', prompt: 'Summarise the day', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
  dbMod.upsertSchedule('t-live', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'live' })
  dbMod.upsertSchedule('t-draft', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'draft' })
  dbMod.upsertSchedule('t-other', { ...base, agent: 'fleet-agent', type: 'task', tenant_id: 'default', status: 'live' })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(method: string, pathAndQuery: string, body: object | undefined, who: Principal) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = method
  req.headers = {}
  req.destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  await route.tryHandleSchedules({ req, res, path: url.pathname, method, url, ...who } as unknown as RouteContext)
  return out
}
const put = (name: string, body: object, who: Principal) => call('PUT', `/api/schedules/${name}`, body, who)

const stored = (name: string) => dbMod.getScheduleFromDb(name)!
const newTask = (name: string, extra: object = {}) => ({
  name, prompt: 'do it', schedule: '0 9 * * *', agent: 'tenant-agent', type: 'task', ...extra,
})

describe('a non-admin account with no tenant', () => {
  it('is refused for reads too, so it cannot see the default tenant tasks through the fallback', async () => {
    for (const role of ['viewer', 'read_only', 'agent']) {
      const out = await call('GET', '/api/schedules', undefined, session(role, null))
      expect(out.status, role).toBe(403)
      expect(out.body).toMatchObject({ error: 'forbidden' })
    }
  })

  it('cannot write', async () => {
    const before = stored('t-other')
    expect((await call('PUT', '/api/schedules/t-other', { prompt: 'x' }, session('agent', null))).status).toBe(403)
    expect((await call('POST', '/api/schedules/t-other/toggle', undefined, session('agent', null))).status).toBe(403)
    expect(stored('t-other')).toEqual(before)
  })
})

describe('writes on the default tenant stay with the admins', () => {
  it.each([
    ['a tenant session', session('agent', 'default')],
    ['a scoped token', token('default')],
  ])('%s is refused, in every verb, and the row does not move', async (_n, who) => {
    const before = stored('t-other')
    expect((await put('t-other', { prompt: 'x' }, who)).status).toBe(403)
    expect((await call('POST', '/api/schedules/t-other/toggle', undefined, who)).status).toBe(403)
    expect((await call('DELETE', '/api/schedules/t-other', undefined, who)).status).toBe(403)
    expect((await call('POST', '/api/schedules', newTask('mine', { agent: 'fleet-agent' }), who)).status).toBe(403)
    expect(stored('t-other')).toEqual(before)
    expect(dbMod.getScheduleFromDb('mine')).toBeUndefined()
  })

  it('but it can still read its tenant, and a human admin or the shared token can still write', async () => {
    expect((await call('GET', '/api/schedules', undefined, session('agent', 'default'))).status).toBe(200)
    expect((await put('t-other', { description: 'a' }, human)).status).toBe(200)
    expect((await put('t-other', { description: 'b' }, sharedToken)).status).toBe(200)
  })
})

describe('a device key', () => {
  it('can read but never write', async () => {
    expect((await call('GET', '/api/schedules', undefined, device)).status).toBe(200)
    const before = stored('t-live')
    expect((await put('t-live', { prompt: 'x' }, device)).status).toBe(403)
    expect((await call('POST', '/api/schedules/t-live/toggle', undefined, device)).status).toBe(403)
    expect((await call('POST', '/api/schedules', newTask('dev-made'), device)).status).toBe(403)
    expect(stored('t-live')).toEqual(before)
  })
})

describe('only a signed-in user or an API token writes', () => {
  it('a federation principal is refused even with a tenant', async () => {
    const before = stored('t-live')
    expect((await put('t-live', { prompt: 'x' }, federation)).status).toBe(403)
    expect(stored('t-live')).toEqual(before)
  })

  it.each([
    ['a session', session('agent', 'tenant-b')],
    ['a scoped token', token('tenant-b')],
  ])('%s on its own non-default tenant is let through to the route (and held for review)', async (_n, who) => {
    const out = await put('t-live', { prompt: 'changed' }, who)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ review_required: true })
  })

  it("another tenant's task is still a 404 for them, not a 403", async () => {
    expect((await put('t-other', { prompt: 'x' }, session('agent', 'tenant-b'))).status).toBe(404)
  })
})

describe('cap on tasks waiting for review per tenant', () => {
  const cap = 20
  const seedDrafts = (n: number, status: 'draft' | 'pending_review' | 'live' = 'draft') => {
    const base = { description: 'd', prompt: 'p', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
    for (let i = 0; i < n; i++) dbMod.upsertSchedule(`bulk-${status}-${i}`, { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status })
  }
  const tenantUser = session('agent', 'tenant-b')

  it('the 21st draft is refused with 400 limit_exceeded and nothing is written', async () => {
    seedDrafts(cap - 1) // + the t-draft seeded in beforeEach = 20
    expect((await call('POST', '/api/schedules', newTask('one-more'), tenantUser)).status).toBe(400)
    expect(dbMod.getScheduleFromDb('one-more')).toBeUndefined()
  })

  it('the refusal names the limit, and a task deleted frees a slot', async () => {
    seedDrafts(cap - 1)
    const refused = await call('POST', '/api/schedules', newTask('one-more'), tenantUser)
    expect(refused.body).toMatchObject({ error: 'limit_exceeded' })
    expect(String(refused.body['hint'])).toContain(String(cap))
    expect((await call('DELETE', '/api/schedules/bulk-draft-0', undefined, tenantUser)).status).toBe(200)
    expect((await call('POST', '/api/schedules', newTask('one-more'), tenantUser)).status).toBe(200)
  })

  it('a held (pending_review) task counts the same as a draft', async () => {
    seedDrafts(cap, 'pending_review')
    expect((await call('POST', '/api/schedules', newTask('one-more'), tenantUser)).status).toBe(400)
  })

  it('live tasks do not count', async () => {
    seedDrafts(cap + 5, 'live')
    expect((await call('POST', '/api/schedules', newTask('fits'), tenantUser)).status).toBe(200)
  })

  it('it is per tenant: another tenant is not blocked by this one', async () => {
    dbMod.createTenant('tenant-c', 'Tenant C')
    dbMod.updateTenant('tenant-c', { main_agent_id: 'tenant-agent' })
    dbMod.setTenantAgentAvailability('tenant-c', 'tenant-agent', true)
    seedDrafts(cap)
    expect((await call('POST', '/api/schedules', newTask('other-tenant'), session('agent', 'tenant-c'))).status).toBe(200)
  })

  it('a human admin creating a live task is not subject to it', async () => {
    seedDrafts(cap)
    const out = await call('POST', '/api/schedules', newTask('by-admin', { tenant_id: 'tenant-b' }), human)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ status: 'live' })
  })

  it('an agent on the shared token creating a draft for the tenant is', async () => {
    seedDrafts(cap)
    const out = await call('POST', '/api/schedules', newTask('by-agent', { tenant_id: 'tenant-b' }), sharedToken)
    expect(out.status).toBe(400)
  })

  it('editing a task the tenant already has is never blocked by the cap', async () => {
    seedDrafts(cap)
    expect((await put('t-live', { prompt: 'edited' }, tenantUser)).status).toBe(200)
  })
})

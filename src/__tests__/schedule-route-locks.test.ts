// The schedule routes and the schedule lock: every write route waits for the lock of its schedule, and PUT, toggle
// and DELETE judge the tenant again under it (a row that moved to another tenant while the call waited is left alone).
// Orchestration: hold the schedule lock, fire the call as a tenant-b caller (it passes the pre-lock tenant check,
// then waits for the lock), move the row to the default tenant while the lock is held, release.
// Adopted from the QA probe of the W3-4 review.
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
let lockMod: typeof import('../web/schedule-lock.js')

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'schedule-route-locks-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')
  lockMod = await import('../web/schedule-lock.js')
  dbMod.createTenant('tenant-b', 'Tenant B')
  dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  dbMod.setTenantAgentAvailability('default', 'shared-agent', true)
  const base = { description: 'd', prompt: 'p', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
  await dbMod.upsertSchedule('t-tenant-b', { ...base, agent: 'shared-agent', type: 'task', tenant_id: 'tenant-b', status: 'live' })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: object, human = false) {
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
  const principal = human
    ? { role: 'admin', tenantId: null, auth: { kind: 'session' } }
    : { role: 'agent', tenantId: 'tenant-b', auth: { kind: 'token' } }
  const ctx = { req, res, path: url.pathname, method, url, ...principal } as unknown as RouteContext
  await route.tryHandleSchedules(ctx)
  return out
}

/** Hold the lock, run `start` (the call under test), move the row to the default tenant, release, return the response. */
async function raceWithTenantMove(start: () => Promise<{ status: number; body: unknown }>) {
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const holder = lockMod.withScheduleLock('t-tenant-b', () => held)
  const pending = start()
  await new Promise(r => setTimeout(r, 30))   // the call has passed its pre-lock checks and waits
  await dbMod.patchSchedule('t-tenant-b', { tenant_id: 'default' } as never)
  release()
  await holder
  return pending
}

describe('a tenant move that lands while the call waits for the lock', () => {
  it('PUT: 404 and the row untouched', async () => {
    const out = await raceWithTenantMove(() => call('PUT', '/api/schedules/t-tenant-b', { description: 'tenant-b edit' }))
    const row = await dbMod.getScheduleFromDb('t-tenant-b')
    expect(out.status).toBe(404)
    expect(row?.description).toBe('d')
  })

  it('toggle: 404 and the row untouched', async () => {
    const out = await raceWithTenantMove(() => call('POST', '/api/schedules/t-tenant-b/toggle'))
    const row = await dbMod.getScheduleFromDb('t-tenant-b')
    expect(out.status).toBe(404)
    expect(row?.enabled).toBe(1)
  })

  it('DELETE: the row of another tenant must survive and the call answers 404', async () => {
    const out = await raceWithTenantMove(() => call('DELETE', '/api/schedules/t-tenant-b'))
    const row = await dbMod.getScheduleFromDb('t-tenant-b')
    expect({ status: out.status, rowSurvives: !!row, tenant: row?.tenant_id }).toEqual({ status: 404, rowSurvives: true, tenant: 'default' })
  })

  it('DELETE of a row that is gone by the time the lock is free answers 404 and writes no audit entry', async () => {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const holder = lockMod.withScheduleLock('t-tenant-b', () => held)
    const pending = call('DELETE', '/api/schedules/t-tenant-b')
    await new Promise(r => setTimeout(r, 30))
    await dbMod.deleteSchedule('t-tenant-b')
    release()
    await holder
    const out = await pending
    expect(out.status).toBe(404)
    const audits = dbMod.getDb().prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'schedule' AND action = 'delete'").get() as { n: number }
    expect(audits.n).toBe(0)
  })
})

describe('every schedule route waits for the schedule lock', () => {
  it.each([
    ['PUT', 'PUT', '/api/schedules/t-tenant-b', { description: 'x' }, false],
    ['toggle', 'POST', '/api/schedules/t-tenant-b/toggle', undefined, false],
    ['delete', 'DELETE', '/api/schedules/t-tenant-b', undefined, false],
    ['activate', 'POST', '/api/schedules/t-tenant-b/activate', undefined, true],
  ])('%s does not finish while another writer holds the lock', async (_label, method, path, body, human) => {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const holder = lockMod.withScheduleLock('t-tenant-b', () => held)
    let done = false
    const pending = call(method, path, body as object | undefined, human).then(o => { done = true; return o })
    await new Promise(r => setTimeout(r, 80))
    const finishedWhileHeld = done
    release()
    await holder
    await pending
    expect(finishedWhileHeld).toBe(false)
  })
})

describe('activate decides under the lock', () => {
  it('a prompt change that lands after the call started is seen by the hash check (409), not approved unseen', async () => {
    const { scheduleContentHash, REVIEWED_FIELDS } = await import('../web/schedule-review.js')
    const { rowToTask } = await import('../web/scheduled-tasks-io.js')
    const base = { description: 'd', prompt: 'p', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
    await dbMod.upsertSchedule('t-draft', { ...base, agent: 'shared-agent', type: 'task', tenant_id: 'tenant-b', status: 'draft' })
    const seen = await dbMod.getScheduleFromDb('t-draft')
    const hash = scheduleContentHash({ ...rowToTask(seen!) }, REVIEWED_FIELDS)

    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const holder = lockMod.withScheduleLock('t-draft', () => held)
    const pending = call('POST', `/api/schedules/t-draft/activate?expected_hash=${hash}`, undefined, true)
    await new Promise(r => setTimeout(r, 60))
    await dbMod.patchSchedule('t-draft', { prompt: 'EVIL changed after the admin looked' } as never)
    release()
    await holder
    const out = await pending
    const row = await dbMod.getScheduleFromDb('t-draft')
    expect({ status: out.status, rowStatus: row?.status }).toEqual({ status: 409, rowStatus: 'draft' })
  })
})

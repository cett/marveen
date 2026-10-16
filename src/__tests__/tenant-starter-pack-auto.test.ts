// A tenant created from now on gets its starter task without anyone asking: made at creation when an agent can be
// chosen, otherwise when one is enabled for it. Tenants that existed before (no pending marker) and a task an admin
// deleted stay as they are. Real routes + DB + a tmp HOME and store, no persistence mocks.
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
  listAgentNames: vi.fn().mockReturnValue(['solo-one', 'solo-two', 'old-one']),
  isKnownAgent: (n: string) => ['solo-one', 'solo-two', 'old-one'].includes(n),
}))
vi.mock('../web/skill-regen.js', () => ({ regenTenantSkillFilesForAgentChange: vi.fn() }))
vi.mock('../web/mcp-risk-policy.js', () => ({ getHighRiskMcpServersForAgent: () => [] }))
vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn(),
  loadLastTickMs: vi.fn().mockReturnValue(null),
  computeTickStatus: vi.fn(),
}))

let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let admin: typeof import('../web/routes/admin-b2b.js')
let pack: typeof import('../web/tenant-starter-pack.js')

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'starter-auto-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  admin = await import('../web/routes/admin-b2b.js')
  pack = await import('../web/tenant-starter-pack.js')
  // A tenant that existed before this feature: it has an agent and no marker.
  dbMod.createTenant('old', 'Old')
  dbMod.setTenantAgentAvailability('old', 'old-one', true)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function request(method: string, path: string, body: object) {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = method; req.headers = {}; req.destroy = () => {}
  const buf = Buffer.from(JSON.stringify(body))
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number } = { status: 200 }
  const res = { writeHead(s: number) { out.status = s }, setHeader() {}, end() {} }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null, auth: { kind: 'session', user: 'root' } } as unknown as RouteContext
  await admin.tryHandleAdminB2b(ctx)
  return out
}
const createTenant = (id: string) => request('POST', '/api/admin/tenants', { id, display_name: id.toUpperCase() })
const setAvailability = (tenant: string, agent: string, enabled: boolean) =>
  request('PUT', '/api/admin/agent-availability', { tenant_id: tenant, agent_id: agent, enabled })
const starter = (tenant: string) => dbMod.getScheduleFromDb(`${tenant}-starter-daily-summary`)
const marker = (tenant: string) => pack.starterPackIsPending(tenant)

describe('starter task for a new tenant', () => {
  it('a tenant created without an agent has no task yet and is marked pending', async () => {
    expect((await createTenant('fresh')).status).toBe(201)
    expect(starter('fresh')).toBeUndefined()
    expect(marker('fresh')).toBe(true)
  })

  it('the first usable agent that is enabled brings the draft + disabled task, and the marker goes', async () => {
    await createTenant('fresh')
    expect((await setAvailability('fresh', 'solo-one', true)).status).toBe(200)
    expect(starter('fresh')).toMatchObject({ tenant_id: 'fresh', agent: 'solo-one', status: 'draft', enabled: 0, type: 'task' })
    expect(marker('fresh')).toBe(false)
  })

  it('a task an admin deleted afterwards is not brought back by a later availability change', async () => {
    await createTenant('fresh')
    await setAvailability('fresh', 'solo-one', true)
    expect(starter('fresh')).toBeDefined()
    dbMod.deleteSchedule('fresh-starter-daily-summary')
    // The first success settled the marker: the deleted task is not brought back by the next change.
    await setAvailability('fresh', 'solo-two', true)
    expect(starter('fresh')).toBeUndefined()
  })

  it('does not decide between two agents enabled before any task existed: it waits', async () => {
    await createTenant('duo')
    dbMod.setTenantAgentAvailability('duo', 'solo-one', true)
    dbMod.setTenantAgentAvailability('duo', 'solo-two', true)
    await setAvailability('duo', 'solo-one', true)
    expect(starter('duo')).toBeUndefined()
    expect(marker('duo')).toBe(true)
  })

  it('a tenant from before (no marker) is never given a task by an availability change', async () => {
    expect(marker('old')).toBe(false)
    await setAvailability('old', 'old-one', true)
    expect(starter('old')).toBeUndefined()
  })

  it('a refused availability change creates nothing and keeps the tenant pending', async () => {
    await createTenant('fresh')
    const r = await request('PUT', '/api/admin/agent-availability', { tenant_id: 'fresh', agent_id: 'no-such-agent', enabled: true })
    expect(r.status).not.toBe(200)
    expect(starter('fresh')).toBeUndefined()
    expect(marker('fresh')).toBe(true)
  })
})

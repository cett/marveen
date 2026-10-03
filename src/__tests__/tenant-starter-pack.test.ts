// Tenant starter pack: POST/GET /api/admin/tenants/:id/starter-pack, the agent resolver, the
// draft cap, name collisions and tenant deletion. Real route + DB + a tmp HOME, no persistence mocks.
//
// Fleet: acme (main agent acme-lead, plus acme-aux enabled), beta (the only enabled agent beta-one), gamma (two enabled
// agents, so ambiguous), shared-agent (enabled for acme AND default), fleet-agent (enabled nowhere).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  listAgentNames: vi.fn().mockReturnValue(['acme-lead', 'acme-aux', 'beta-one', 'g-one', 'g-two', 'co-a', 'co-b', 'shared-agent', 'fleet-agent']),
  isKnownAgent: (n: string) => ['acme-lead', 'acme-aux', 'beta-one', 'g-one', 'g-two', 'co-a', 'co-b', 'shared-agent', 'fleet-agent'].includes(n),
}))
vi.mock('../web/skill-regen.js', () => ({ regenTenantSkillFilesForAgentChange: vi.fn() }))
vi.mock('../web/mcp-risk-policy.js', () => ({ getHighRiskMcpServersForAgent: () => [] }))
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
let admin: typeof import('../web/routes/admin-b2b.js')
let schedules: typeof import('../web/routes/schedules.js')
let ledger: typeof import('../web/schedule-skip-ledger.js')

type Caller = 'human' | 'agent-token' | 'tenant-user'

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'starter-pack-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  io = await import('../web/scheduled-tasks-io.js')
  admin = await import('../web/routes/admin-b2b.js')
  schedules = await import('../web/routes/schedules.js')
  ledger = await import('../web/schedule-skip-ledger.js')

  dbMod.createTenant('acme', 'Acme')
  dbMod.updateTenant('acme', { main_agent_id: 'acme-lead' })
  dbMod.setTenantAgentAvailability('acme', 'acme-lead', true)
  dbMod.setTenantAgentAvailability('acme', 'acme-aux', true)
  dbMod.createTenant('beta', 'Beta')
  dbMod.setTenantAgentAvailability('beta', 'beta-one', true)
  dbMod.createTenant('gamma', 'Gamma')
  dbMod.setTenantAgentAvailability('gamma', 'g-one', true)
  dbMod.setTenantAgentAvailability('gamma', 'g-two', true)
  dbMod.setTenantAgentAvailability('acme', 'shared-agent', true)
  dbMod.setTenantAgentAvailability('default', 'shared-agent', true)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(handler: 'admin' | 'schedules', method: string, path: string, body?: object, caller: Caller = 'human') {
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
  const principal = caller === 'human'
    ? { role: 'admin', tenantId: null, auth: { kind: 'session', user: 'root' } }
    : caller === 'agent-token'
      ? { role: 'admin', tenantId: null, auth: { kind: 'token' } }
      : { role: 'agent', tenantId: 'acme', auth: { kind: 'session', user: 'acme-user' } }
  const ctx = { req, res, path: url.pathname, method, url, ...principal } as unknown as RouteContext
  await (handler === 'admin' ? admin.tryHandleAdminB2b(ctx) : schedules.tryHandleSchedules(ctx))
  return out as { status: number; body: Record<string, unknown> }
}

const post = (tenant: string, body?: object, caller: Caller = 'human') =>
  call('admin', 'POST', `/api/admin/tenants/${tenant}/starter-pack`, body, caller)
const get = (tenant: string, caller: Caller = 'human') =>
  call('admin', 'GET', `/api/admin/tenants/${tenant}/starter-pack`, undefined, caller)
const row = (name: string) => dbMod.getScheduleFromDb(name)
const mirror = (name: string) => JSON.parse(readFileSync(join(tmp, '.claude', 'scheduled-tasks', name, 'task-config.json'), 'utf-8')) as Record<string, unknown>
const auditCount = (action: string) =>
  (dbMod.getDb().prepare('SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = ?').get(action) as { n: number }).n

describe('creating the starter task', () => {
  it('writes exactly one draft + disabled row for the tenant, with its file mirror', async () => {
    const r = await post('acme')
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ ok: true, tenant_id: 'acme', agent: 'acme-lead', state: 'created', created: ['acme-starter-daily-summary'], skipped: [], retargeted: [] })
    const rows = dbMod.listSchedulesFromDb({ tenantId: 'acme' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'acme-starter-daily-summary', tenant_id: 'acme', agent: 'acme-lead', status: 'draft', enabled: 0, type: 'task', schedule: '30 21 * * *' })
    expect(mirror('acme-starter-daily-summary')).toMatchObject({ status: 'draft', enabled: false, agent: 'acme-lead', tenantId: 'acme' })
    expect(auditCount('create')).toBe(1)
  })

  it('the pack ships exactly one template', () => {
    expect(readdirSync(join(ROOT, 'templates', 'tenant-starter-pack'))).toEqual(['daily-summary'])
  })

  it('the stored prompt is rendered for the tenant and its agent, with no placeholder left', async () => {
    await post('acme')
    const prompt = row('acme-starter-daily-summary')!.prompt
    expect(prompt).not.toContain('{{')
    expect(prompt).toContain('tenant=acme')
    expect(prompt).toContain('agent=acme-lead')
  })

  it('is not an upsert: a second POST creates nothing and leaves hand edits alone', async () => {
    await post('acme')
    io.writeScheduledTask('acme-starter-daily-summary', { prompt: 'edited by hand', schedule: '5 4 * * *', enabled: true, status: 'live' })
    const again = await post('acme')
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: [], skipped: [{ name: 'acme-starter-daily-summary', reason: 'exists' }], retargeted: [] })
    expect(row('acme-starter-daily-summary')).toMatchObject({ prompt: 'edited by hand', schedule: '5 4 * * *', enabled: 1, status: 'live' })
    expect(auditCount('create')).toBe(1)
  })

  it('a row the admin deleted comes back on the next explicit POST', async () => {
    await post('acme')
    dbMod.getDb().prepare('DELETE FROM schedules WHERE id = ?').run('acme-starter-daily-summary')
    const r = await post('acme')
    expect(r.body).toMatchObject({ created: ['acme-starter-daily-summary'] })
  })
})

describe('agent resolution', () => {
  it('uses the tenant main agent, else the only enabled agent', async () => {
    expect((await post('acme')).body['agent']).toBe('acme-lead')
    expect((await post('beta')).body['agent']).toBe('beta-one')
  })

  it('an explicit agent that serves the tenant wins over the main agent', async () => {
    const r = await post('acme', { agent_id: 'acme-aux' })
    expect(r.status).toBe(201)
    expect(r.body['agent']).toBe('acme-aux')
    expect(row('acme-starter-daily-summary')!.agent).toBe('acme-aux')
  })

  it('two enabled agents and no main agent: 400 required agent_id, nothing written', async () => {
    const r = await post('gamma')
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'required', field: 'agent_id' })
    expect(dbMod.listSchedulesFromDb({ tenantId: 'gamma' })).toHaveLength(0)
    const ok = await post('gamma', { agent_id: 'g-two' })
    expect(ok.status).toBe(201)
    expect(ok.body['agent']).toBe('g-two')
  })

  it('an agent shared with another tenant is refused with 409, even when it serves this one', async () => {
    const r = await post('acme', { agent_id: 'shared-agent' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'conflict', field: 'agent_id' })
    expect(dbMod.listSchedulesFromDb({ tenantId: 'acme' })).toHaveLength(0)
  })

  it('refuses the fleet main agent, an unknown agent and an agent of no tenant', async () => {
    for (const agent_id of ['main-agent', 'nobody', 'fleet-agent']) {
      const r = await post('acme', { agent_id })
      expect(r.status).toBe(400)
    }
    expect(dbMod.listSchedulesFromDb({ tenantId: 'acme' })).toHaveLength(0)
  })

  it('refuses the default tenant, a missing tenant and a disabled tenant', async () => {
    expect((await post('default')).status).toBe(400)
    expect((await post('nope')).status).toBe(404)
    dbMod.updateTenant('beta', { disabled: true })
    expect((await post('beta')).status).toBe(404)
    expect(dbMod.listSchedulesFromDb().filter(r => r.id.endsWith('starter-daily-summary'))).toHaveLength(0)
  })
})

describe('draft cap and the skip ledger', () => {
  it('the draft cap does not stop the starter task: it is written with 20 open drafts already there', async () => {
    for (let i = 0; i < 20; i++) io.writeScheduledTask(`acme-d${i}`, { prompt: 'p', schedule: '0 9 * * *', agent: 'acme-lead', tenantId: 'acme', status: 'draft', enabled: false })
    const r = await post('acme')
    expect(r.status).toBe(201)
  })

  it('it does count against the cap: with 19 drafts plus the starter task, a 20th create is refused', async () => {
    await post('acme')
    for (let i = 0; i < 19; i++) io.writeScheduledTask(`acme-d${i}`, { prompt: 'p', schedule: '0 9 * * *', agent: 'acme-lead', tenantId: 'acme', status: 'draft', enabled: false })
    const created = await call('schedules', 'POST', '/api/schedules', { name: 'acme-extra', prompt: 'p', schedule: '0 9 * * *', agent: 'acme-lead', tenant_id: 'acme' }, 'agent-token')
    expect(created.status).toBe(400)
  })

  it('a draft + disabled starter task is classified disabled: no skipped_not_live row, not part of a mass skip', async () => {
    await post('acme')
    const r = row('acme-starter-daily-summary')!
    expect(ledger.classifyTask({ enabled: r.enabled === 1, status: r.status })).toBe('disabled')
  })
})

describe('name collisions and tenant deletion', () => {
  it('two tenant ids that sanitize to the same name: the second is refused, the first row stays', async () => {
    dbMod.createTenant('co-x', 'Co X')
    dbMod.createTenant('co--x', 'Co XX')
    dbMod.setTenantAgentAvailability('co-x', 'co-a', true)
    dbMod.setTenantAgentAvailability('co--x', 'co-b', true)
    const first = await post('co-x')
    expect(first.status).toBe(201)
    const second = await post('co--x')
    expect(second.status).toBe(409)
    expect(row('co-x-starter-daily-summary')).toMatchObject({ tenant_id: 'co-x', agent: 'co-a' })
    expect(row('co-x-starter-daily-summary')).toBeDefined()
  })

  it('deleting the tenant removes its starter row, its file mirror and nobody else\'s', async () => {
    await post('acme')
    await post('beta')
    expect(existsSync(join(tmp, '.claude', 'scheduled-tasks', 'acme-starter-daily-summary'))).toBe(true)
    const del = await call('admin', 'DELETE', '/api/admin/tenants/acme')
    expect(del.status).toBe(200)
    expect(row('acme-starter-daily-summary')).toBeUndefined()
    expect(existsSync(join(tmp, '.claude', 'scheduled-tasks', 'acme-starter-daily-summary'))).toBe(false)
    expect(row('beta-starter-daily-summary')).toBeDefined()
  })
})

describe('who can reach it', () => {
  it('a tenant user gets 403 on POST and GET, and nothing is written', async () => {
    expect((await post('acme', undefined, 'tenant-user')).status).toBe(403)
    expect((await get('acme', 'tenant-user')).status).toBe(403)
    expect(dbMod.listSchedulesFromDb({ tenantId: 'acme' })).toHaveLength(0)
  })

  it('GET only reads: it reports the row and what a create would pick, and writes nothing', async () => {
    const before = await get('acme')
    expect(before.body).toMatchObject({ exists: false, state: 'absent', task: null, resolution: { agent: 'acme-lead', reason: 'main_agent' } })
    expect(dbMod.listSchedulesFromDb({ tenantId: 'acme' })).toHaveLength(0)
    await post('acme')
    const after = await get('acme')
    expect(after.body).toMatchObject({ exists: true, state: 'ok', task: { agent: 'acme-lead', status: 'draft', enabled: false } })
    expect(auditCount('create')).toBe(1)
  })

  it('POST is audited', async () => {
    await post('acme')
    const n = (dbMod.getDb().prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'admin.tenant.starter_pack'").get() as { n: number }).n
    expect(n).toBe(1)
  })
})

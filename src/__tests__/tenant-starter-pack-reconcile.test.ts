// Re-aiming the tenant starter task when the agent behind it changes (reconcileStarterPack), and the
// hook on PUT /api/admin/agent-availability. Real DB + file mirror in a tmp HOME.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  listAgentNames: vi.fn().mockReturnValue(['acme-lead', 'acme-aux', 'g-one', 'g-two', 'beta-one', 'shared-agent']),
  isKnownAgent: (n: string) => ['acme-lead', 'acme-aux', 'g-one', 'g-two', 'beta-one', 'shared-agent'].includes(n),
}))
vi.mock('../web/skill-regen.js', () => ({ regenTenantSkillFiles: vi.fn() }))
vi.mock('../web/mcp-risk-policy.js', () => ({ getHighRiskMcpServersForAgent: () => [] }))

const NAME = 'acme-starter-daily-summary'
let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let io: typeof import('../web/scheduled-tasks-io.js')
let pack: typeof import('../web/tenant-starter-pack.js')
let admin: typeof import('../web/routes/admin-b2b.js')

const human = () => ({ role: 'admin', auth: { kind: 'session', user: 'root' } }) as unknown as RouteContext
const agentToken = () => ({ role: 'admin', auth: { kind: 'token' } }) as unknown as RouteContext

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'starter-reconcile-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  io = await import('../web/scheduled-tasks-io.js')
  pack = await import('../web/tenant-starter-pack.js')
  admin = await import('../web/routes/admin-b2b.js')

  dbMod.createTenant('acme', 'Acme')
  dbMod.updateTenant('acme', { main_agent_id: 'acme-lead' })
  dbMod.setTenantAgentAvailability('acme', 'acme-lead', true)
  dbMod.setTenantAgentAvailability('acme', 'acme-aux', true)
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

const row = (name = NAME) => dbMod.getScheduleFromDb(name)
const mirror = (name = NAME) => JSON.parse(readFileSync(join(tmp, '.claude', 'scheduled-tasks', name, 'task-config.json'), 'utf-8')) as Record<string, unknown>
const count = (sql: string) => (dbMod.getDb().prepare(sql).get() as { n: number }).n
const retargetAudits = () => count("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'retarget'")
const reviewMessages = () => (dbMod.getDb().prepare("SELECT content FROM agent_messages WHERE content LIKE '[SCHEDULE_REVIEW]%'").all() as { content: string }[]).map(r => r.content)

/** A live, enabled starter task on acme-lead that a person has already approved. */
function approvedStarter() {
  pack.createStarterPack(human(), 'acme')
  io.writeScheduledTask(NAME, { status: 'live', enabled: true })
  expect(row()).toMatchObject({ status: 'live', enabled: 1, agent: 'acme-lead' })
}

describe('main agent change', () => {
  it('re-aims to the new agent and returns the task to draft + disabled (each field on its own)', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    const r = pack.reconcileStarterPack(human(), 'acme')
    expect(r.state).toBe('retargeted')
    expect(r.retargeted).toEqual([{ name: NAME, from: 'acme-lead', to: 'acme-aux' }])
    const after = row()!
    expect(after.agent).toBe('acme-aux')
    expect(after.status).toBe('draft')
    expect(after.enabled).toBe(0)
  })

  it('keeps what a person edited: prompt and schedule', () => {
    approvedStarter()
    io.writeScheduledTask(NAME, { prompt: 'my own prompt', schedule: '7 7 * * *' })
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    pack.reconcileStarterPack(human(), 'acme')
    expect(row()).toMatchObject({ prompt: 'my own prompt', schedule: '7 7 * * *' })
  })

  it('writes the file mirror with the new agent and draft', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    pack.reconcileStarterPack(human(), 'acme')
    expect(mirror()).toMatchObject({ agent: 'acme-aux', status: 'draft', enabled: false })
  })

  it('a second run writes, audits and notifies nothing', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    pack.reconcileStarterPack(agentToken(), 'acme')
    const stamp = row()!.updated_at
    const again = pack.reconcileStarterPack(agentToken(), 'acme')
    expect(again.state).toBe('ok')
    expect(again.retargeted).toEqual([])
    expect(row()!.updated_at).toBe(stamp)
    expect(retargetAudits()).toBe(1)
    expect(reviewMessages()).toHaveLength(1)
  })

  it('never moves to an agent that is shared with another tenant', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'shared-agent' })
    const r = pack.reconcileStarterPack(human(), 'acme')
    expect(r.state).toBe('ok')
    expect(row()).toMatchObject({ agent: 'acme-lead', status: 'live', enabled: 1 })
  })
})

describe('no definite agent', () => {
  function gammaApproved() {
    pack.createStarterPack(human(), 'gamma', { agentId: 'g-two' })
    io.writeScheduledTask('gamma-starter-daily-summary', { status: 'live', enabled: true })
  }

  it('two candidates and the current agent still serves: left alone, not demoted', () => {
    gammaApproved()
    const r = pack.reconcileStarterPack(human(), 'gamma')
    expect(r.state).toBe('ok')
    expect(row('gamma-starter-daily-summary')).toMatchObject({ agent: 'g-two', status: 'live', enabled: 1 })
  })

  it('the current agent no longer serves and none can be chosen: parked as draft + disabled, agent unchanged, needs_agent', () => {
    gammaApproved()
    dbMod.setTenantAgentAvailability('gamma', 'g-one', false)
    dbMod.setTenantAgentAvailability('gamma', 'g-two', false)
    const r = pack.reconcileStarterPack(human(), 'gamma')
    expect(r.state).toBe('needs_agent')
    expect(r.reason).toBe('ambiguous')
    expect(row('gamma-starter-daily-summary')).toMatchObject({ agent: 'g-two', status: 'draft', enabled: 0 })
    expect(pack.describeStarterPack('gamma').state).toBe('needs_agent')
    const stamp = row('gamma-starter-daily-summary')!.updated_at
    pack.reconcileStarterPack(human(), 'gamma')
    expect(row('gamma-starter-daily-summary')!.updated_at).toBe(stamp)
  })
})

describe('only the tenant\'s own starter task is touched', () => {
  it('a user task with a starter-like name and another tenant\'s row are left alone', () => {
    approvedStarter()
    io.writeScheduledTask('acme-starter-extra', { prompt: 'p', agent: 'acme-lead', tenantId: 'acme', status: 'live', enabled: true })
    pack.createStarterPack(human(), 'gamma', { agentId: 'g-one' })
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    pack.reconcileStarterPack(human(), 'acme')
    expect(row('acme-starter-extra')).toMatchObject({ agent: 'acme-lead', status: 'live', enabled: 1 })
    expect(row('gamma-starter-daily-summary')).toMatchObject({ agent: 'g-one', status: 'draft', enabled: 0 })
  })

  it('a row with the starter name that belongs to another tenant is not ours: absent, untouched', () => {
    io.writeScheduledTask(NAME, { prompt: 'p', agent: 'g-one', tenantId: 'gamma', status: 'live', enabled: true })
    const r = pack.reconcileStarterPack(human(), 'acme')
    expect(r.state).toBe('absent')
    expect(row()).toMatchObject({ tenant_id: 'gamma', agent: 'g-one', status: 'live', enabled: 1 })
  })

  it('with no starter task nothing is created', () => {
    const r = pack.reconcileStarterPack(human(), 'acme')
    expect(r.state).toBe('absent')
    expect(row()).toBeUndefined()
  })
})

describe('who is told', () => {
  it('a non-human actor sends exactly one retargeted review message; a human sends none', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    pack.reconcileStarterPack(human(), 'acme')
    expect(reviewMessages()).toEqual([])

    io.writeScheduledTask(NAME, { status: 'live', enabled: true })
    dbMod.updateTenant('acme', { main_agent_id: 'acme-lead' })
    pack.reconcileStarterPack(agentToken(), 'acme')
    const msgs = reviewMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain(`task=${NAME}`)
    expect(msgs[0]).toContain('reason=retargeted')
  })

  it('the one-hour throttle holds for a second retarget of the same task', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    pack.reconcileStarterPack(agentToken(), 'acme')
    dbMod.updateTenant('acme', { main_agent_id: 'acme-lead' })
    pack.reconcileStarterPack(agentToken(), 'acme')
    expect(retargetAudits()).toBe(2)
    expect(reviewMessages()).toHaveLength(1)
  })
})

describe('the create button repairs', () => {
  it('POSTing again after a main agent change re-aims the task and reports it', () => {
    approvedStarter()
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })
    const out = pack.createStarterPack(human(), 'acme')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.state).toBe('retargeted')
      expect(out.result.skipped).toEqual([{ name: NAME, reason: 'exists' }])
    }
    expect(row()).toMatchObject({ agent: 'acme-aux', status: 'draft', enabled: 0 })
  })
})

describe('hook on PUT /api/admin/agent-availability', () => {
  async function putAvailability(tenant: string, agent: string, enabled: boolean) {
    const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
    req.method = 'PUT'; req.headers = {}; req.destroy = () => {}
    const buf = Buffer.from(JSON.stringify({ tenant_id: tenant, agent_id: agent, enabled }))
    setImmediate(() => { req.emit('data', buf); req.emit('end') })
    const out: { status: number } = { status: 200 }
    const res = { writeHead(s: number) { out.status = s }, setHeader() {}, end() {} }
    const url = new URL('http://localhost:3420/api/admin/agent-availability')
    const ctx = { req, res, path: url.pathname, method: 'PUT', url, role: 'admin', tenantId: null, auth: { kind: 'session', user: 'root' } } as unknown as RouteContext
    await admin.tryHandleAdminB2b(ctx)
    return out
  }

  it('switching the only usable agent off parks the starter task', async () => {
    dbMod.createTenant('solo', 'Solo')
    dbMod.setTenantAgentAvailability('solo', 'beta-one', true)
    pack.createStarterPack(human(), 'solo')
    io.writeScheduledTask('solo-starter-daily-summary', { status: 'live', enabled: true })
    const r = await putAvailability('solo', 'beta-one', false)
    expect(r.status).toBe(200)
    expect(row('solo-starter-daily-summary')).toMatchObject({ agent: 'beta-one', status: 'draft', enabled: 0 })
  })

  it('enabling another agent for a tenant that has no starter task creates nothing', async () => {
    await putAvailability('gamma', 'acme-lead', true)
    expect(dbMod.listSchedulesFromDb().filter(r => r.id.endsWith('starter-daily-summary'))).toHaveLength(0)
  })
})

// Two callers of the starter pack for one tenant (a double click on the create button, the button racing the
// agent-availability hook): the check for an existing row and the create are one step, so exactly one of them
// creates and the other reconciles. Real DB + file mirror in a tmp HOME.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

// The home directory stays pinned to the test's temp dir even after a test ended, so a write that a dropped await
// delays past the test lands in that leftover dir and never in the real ~/.claude.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => tmp || '/nonexistent-starter-test-home' }
})
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  currentBotName: () => 'Main',
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: vi.fn().mockReturnValue(['acme-lead', 'acme-aux', 'beta-one']),
  isKnownAgent: (n: string) => ['acme-lead', 'acme-aux', 'beta-one'].includes(n),
}))
vi.mock('../web/skill-regen.js', () => ({ regenTenantSkillFilesForAgentChange: vi.fn() }))
vi.mock('../web/mcp-risk-policy.js', () => ({ getHighRiskMcpServersForAgent: () => [] }))

const NAME = 'acme-starter-daily-summary'
let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let pack: typeof import('../web/tenant-starter-pack.js')

const human = () => ({ role: 'admin', auth: { kind: 'session', user: 'root' } }) as unknown as RouteContext

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'starter-concurrency-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  pack = await import('../web/tenant-starter-pack.js')

  dbMod.createTenant('acme', 'Acme')
  dbMod.updateTenant('acme', { main_agent_id: 'acme-lead' })
  await dbMod.setTenantAgentAvailability('acme', 'acme-lead', true)
  await dbMod.setTenantAgentAvailability('acme', 'acme-aux', true)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

const count = (sql: string) => (dbMod.getDb().prepare(sql).get() as { n: number }).n
const starterRows = () => count(`SELECT COUNT(*) AS n FROM schedules WHERE id = '${NAME}'`)
const createAudits = () => count(`SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'schedule' AND action = 'create' AND entity_id = '${NAME}'`)
const mirror = () => JSON.parse(readFileSync(join(tmp, '.claude', 'scheduled-tasks', NAME, 'task-config.json'), 'utf-8')) as Record<string, unknown>

describe('two concurrent createStarterPack calls', () => {
  it('create once and reconcile once: one row, one create audit, the second call reports the existing task', async () => {
    const [a, b] = await Promise.all([pack.createStarterPack(human(), 'acme'), pack.createStarterPack(human(), 'acme')])

    expect(a.ok && b.ok).toBe(true)
    const states = [a, b].map((o) => (o.ok ? o.result.state : 'error')).sort()
    expect(states).toEqual(['created', 'ok'])
    const second = [a, b].find((o) => o.ok && o.result.state === 'ok')
    expect(second?.ok && second.result.skipped).toEqual([{ name: NAME, reason: 'exists' }])
    expect(starterRows()).toBe(1)
    expect(createAudits()).toBe(1)
    expect(mirror()).toMatchObject({ agent: 'acme-lead', status: 'draft', enabled: false })
  })

  it('a refused first call (agent that does not serve the tenant) does not block the second, which creates', async () => {
    const [refused, created] = await Promise.all([
      pack.createStarterPack(human(), 'acme', { agentId: 'beta-one' }),
      pack.createStarterPack(human(), 'acme'),
    ])

    expect(refused).toMatchObject({ ok: false, error: 'not_serving' })
    expect(created.ok && created.result.state).toBe('created')
    expect(starterRows()).toBe(1)
    expect(createAudits()).toBe(1)
  })

  it('a create racing a reconcile after a main agent change ends on the new agent, with one row', async () => {
    await pack.createStarterPack(human(), 'acme')
    dbMod.updateTenant('acme', { main_agent_id: 'acme-aux' })

    const [create, reconcile] = await Promise.all([pack.createStarterPack(human(), 'acme'), pack.reconcileStarterPack(human(), 'acme')])

    expect(create.ok).toBe(true)
    expect(reconcile.state === 'retargeted' || reconcile.state === 'ok').toBe(true)
    expect(starterRows()).toBe(1)
    expect(await dbMod.getScheduleFromDb(NAME)).toMatchObject({ agent: 'acme-aux', status: 'draft', enabled: 0 })
    expect(mirror()).toMatchObject({ agent: 'acme-aux', status: 'draft', enabled: false })
    expect(count("SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'schedule' AND action = 'retarget'")).toBe(1)
  })
})

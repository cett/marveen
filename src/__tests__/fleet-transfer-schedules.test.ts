// Round-trip coverage for the DB-based `schedules` table (dashboard-schedule-crud
// API) in fleet export/import. Previously the fleet snapshot only captured the
// file-based scheduledTasks[] -- any schedule created through the DB-backed API
// silently vanished on export, so a fleet migration lost every such schedule.
//
// Uses the REAL db.ts (in-memory SQLite) so exportFleet()/importFleet() exercise
// real SQL against the real schedules schema, and the REAL node:fs (pointed at a
// throwaway temp dir via PROJECT_ROOT/STORE_DIR) rather than a mocked fs -- a
// mocked readdirSync would also break db-migrations.ts's real migration-file
// loading, since it isn't scoped to only fleet-transfer.ts's own fs calls.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, getDb } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-schedules-test-'))
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store'), TASKS_DIR: join(root, 'tasks') }
})

afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [] }))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: TASKS_DIR }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'TestBot',
  BRAND_NAME: 'TestBot',
  OWNER_NAME: 'test',
  CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))

const MINIMAL_FLEET_FIELDS = {
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sourceHost: 'test-host',
  agents: [],
  skills: [],
  scheduledTasks: [],
  memories: [],
  dailyLogs: [],
  kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
  ideaBox: { ideas: [], comments: [], statusLog: [] },
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
}

function insertSchedule(overrides: Partial<{ id: string; enabled: number; agent: string; type: string; schedule: string; tenant_id: string | null }> = {}) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    `INSERT INTO schedules (id, prompt, description, schedule, agent, type, enabled, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.id ?? 'morning-chain',
    'Run the morning chain',
    'desc',
    overrides.schedule ?? '0 7 * * *',
    overrides.agent ?? 'agent-a',
    overrides.type ?? 'task',
    overrides.enabled ?? 1,
    overrides.tenant_id ?? null,
    now, now,
  )
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

describe('exportFleet -- schedules', () => {
  it('exports every schedules row, forced disabled regardless of the source state', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    insertSchedule({ id: 'morning-chain', enabled: 1 })
    insertSchedule({ id: 'nightly-cleanup', enabled: 0, type: 'command' })

    const result = exportFleet()
    const fleet = JSON.parse(result.data)
    expect(fleet.schedules).toHaveLength(2)
    expect(fleet.schedules.every((s: any) => s.enabled === 0)).toBe(true)
    expect(fleet.schedules.map((s: any) => s.id).sort()).toEqual(['morning-chain', 'nightly-cleanup'])
  })
})

describe('importFleet -- schedules', () => {
  it('dry-run reports the schedule as new and warns it will land disabled', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertSchedule({ id: 'heartbeat-1', type: 'heartbeat' })
    const exported = exportFleet()

    initDatabase(':memory:') // fresh target -- no schedules yet

    const dry = importFleet(exported.data, { apply: false }) as any
    expect(dry.wouldCreate.schedules).toBe(1)
    expect(dry.warnings.some((w: string) => w.includes('ütemezés'))).toBe(true)
  })

  it('apply inserts the schedule disabled, preserving its other fields', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertSchedule({ id: 'heartbeat-1', type: 'heartbeat', schedule: '*/15 * * * *', enabled: 1 })
    const exported = exportFleet()

    initDatabase(':memory:') // fresh target

    const applied = importFleet(exported.data, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(applied.imported.schedules).toBe(1)

    const row = getDb().prepare('SELECT * FROM schedules WHERE id = ?').get('heartbeat-1') as any
    expect(row).toBeTruthy()
    expect(row.enabled).toBe(0)
    expect(row.agent).toBe('agent-a')
    expect(row.type).toBe('heartbeat')
    expect(row.schedule).toBe('*/15 * * * *')
  })

  it('is idempotent on id -- re-applying the same export does not duplicate the row', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertSchedule({ id: 'daily-digest' })
    const exported = exportFleet()

    initDatabase(':memory:')
    importFleet(exported.data, { apply: true })
    importFleet(exported.data, { apply: true })

    const rows = getDb().prepare('SELECT * FROM schedules WHERE id = ?').all('daily-digest') as any[]
    expect(rows).toHaveLength(1)
  })

  it('skips a malformed schedule row (missing required fields) without failing the whole import', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const fleetJson = JSON.stringify({
      ...MINIMAL_FLEET_FIELDS,
      schedules: [{ id: 'bad-row' }, { id: 'good-row', schedule: '0 * * * *', agent: 'agent-a', type: 'task', prompt: 'p', description: 'd', enabled: 1, created_at: 1, updated_at: 1 }],
    })
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(getDb().prepare('SELECT * FROM schedules WHERE id = ?').get('bad-row')).toBeUndefined()
    expect(getDb().prepare('SELECT * FROM schedules WHERE id = ?').get('good-row')).toBeTruthy()
  })
})

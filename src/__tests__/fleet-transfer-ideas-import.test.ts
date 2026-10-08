// Fleet import of idea_box rows. idea_box.id is a TEXT PRIMARY KEY without NOT NULL, and
// SQLite lets any number of NULL keys in, so a row without an id must be skipped by the
// import itself (like the other imported tables), or ON CONFLICT DO NOTHING cannot dedupe it.
// Real db.ts (in-memory SQLite) and real node:fs in a throwaway temp dir, as in
// fleet-transfer-import-sources.test.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, getDb } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-import-ideas-test-'))
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store'), TASKS_DIR: join(root, 'tasks') }
})

afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [], invalidateModelProfileMapCache: () => {} }))
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
  schedules: [],
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

const idea = (over: Record<string, unknown> = {}) => ({
  id: 'idea-1', title: 'An idea', description: null, category: 'Egyéb', status: 'new',
  source: '', kanban_id: null, impact: null, effort: null, created_at: 1, updated_at: 1, ...over,
})

describe('importFleet -- ideaBox', () => {
  it('skips an idea without an id and writes no NULL-id row, even when re-applied', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const fleetJson = JSON.stringify({
      ...MINIMAL_FLEET_FIELDS,
      ideaBox: { ideas: [idea({ id: undefined, title: 'no id' }), idea({ id: null, title: 'null id' }), idea({ id: '', title: 'empty id' }), idea()], comments: [], statusLog: [] },
    })
    for (let i = 0; i < 2; i++) {
      const applied = importFleet(fleetJson, { apply: true }) as any
      expect(applied.ok).toBe(true)
    }
    const db = getDb()
    expect((db.prepare('SELECT COUNT(*) AS n FROM idea_box WHERE id IS NULL OR id = ?').get('') as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM idea_box').get() as { n: number }).n).toBe(1)
  })

  it('still skips a row with a missing NOT NULL column or an unknown status, and imports a good one once', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const fleetJson = JSON.stringify({
      ...MINIMAL_FLEET_FIELDS,
      ideaBox: { ideas: [idea({ id: 'no-title', title: null }), idea({ id: 'bad-status', status: 'bogus' }), idea({ id: 'good' }), idea({ id: 'good' })], comments: [], statusLog: [] },
    })
    expect((importFleet(fleetJson, { apply: true }) as any).ok).toBe(true)
    const ids = (getDb().prepare('SELECT id FROM idea_box ORDER BY id').all() as { id: string }[]).map((r) => r.id)
    expect(ids).toEqual(['good'])
  })
})

// Round-trip coverage for the `import_sources` table (import-memories crawler
// pipeline config: local/gdrive/sharepoint/confluence) in fleet export/import.
// Previously dropped outright -- a fleet migration lost every configured
// import source, silently, with no warning.
//
// Uses the REAL db.ts (in-memory SQLite) so exportFleet()/importFleet() exercise
// real SQL against the real import_sources schema, and the REAL node:fs (pointed
// at a throwaway temp dir via PROJECT_ROOT/STORE_DIR) rather than a mocked fs --
// see fleet-transfer-schedules.test.ts for why a mocked fs is unsafe here (it
// would also break db-migrations.ts's real migration-file loading).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, getDb } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-import-sources-test-'))
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
  schedules: [],
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
}

function insertImportSource(overrides: Partial<{
  id: string; type: string; path: string; enabled: number; last_run_at: number | null
  vault_token_ref: string | null; confluence_email: string | null; base_url: string | null; tenant_id: string
}> = {}) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    `INSERT INTO import_sources
     (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at,
      tenant_id, vault_token_ref, confluence_email, base_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.id ?? 'local-docs',
    overrides.type ?? 'local',
    overrides.path ?? '/home/user/docs',
    'Local docs',
    4,
    overrides.enabled ?? 1,
    overrides.last_run_at ?? now,
    now, now,
    overrides.tenant_id ?? 'default',
    overrides.vault_token_ref ?? null,
    overrides.confluence_email ?? null,
    overrides.base_url ?? null,
  )
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

describe('exportFleet -- importSources', () => {
  it('exports every import_sources row, force-disabled with last_run_at cleared', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    insertImportSource({ id: 'local-docs', enabled: 1 })
    insertImportSource({
      id: 'conf-space', type: 'confluence', path: 'MYSPACE', enabled: 1,
      vault_token_ref: 'conf-token-1', confluence_email: 'user@example.com', base_url: 'https://example.atlassian.net',
    })

    const result = exportFleet()
    const fleet = JSON.parse(result.data)
    expect(fleet.importSources).toHaveLength(2)
    expect(fleet.importSources.every((s: any) => s.enabled === 0 && s.last_run_at === null)).toBe(true)
    const conf = fleet.importSources.find((s: any) => s.id === 'conf-space')
    expect(conf.vault_token_ref).toBe('conf-token-1')
    expect(conf.confluence_email).toBe('user@example.com')
    expect(conf.base_url).toBe('https://example.atlassian.net')
  })
})

describe('importFleet -- importSources', () => {
  it('dry-run reports the source as new and warns about disabled/vault-dependent re-enable', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertImportSource({ id: 'local-docs' })
    const exported = exportFleet()

    initDatabase(':memory:') // fresh target -- no sources yet

    const dry = importFleet(exported.data, { apply: false }) as any
    expect(dry.wouldCreate.importSources).toBe(1)
    expect(dry.warnings.some((w: string) => w.includes('import-forrás'))).toBe(true)
  })

  it('apply inserts the source disabled with last_run_at cleared, preserving config fields', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertImportSource({
      id: 'conf-space', type: 'confluence', path: 'MYSPACE', enabled: 1, last_run_at: 1700000000,
      vault_token_ref: 'conf-token-1', confluence_email: 'user@example.com', base_url: 'https://example.atlassian.net',
    })
    const exported = exportFleet()

    initDatabase(':memory:') // fresh target

    const applied = importFleet(exported.data, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(applied.imported.importSources).toBe(1)

    const row = getDb().prepare('SELECT * FROM import_sources WHERE id = ?').get('conf-space') as any
    expect(row).toBeTruthy()
    expect(row.enabled).toBe(0)
    expect(row.last_run_at).toBeNull()
    expect(row.type).toBe('confluence')
    expect(row.path).toBe('MYSPACE')
    expect(row.vault_token_ref).toBe('conf-token-1')
    expect(row.confluence_email).toBe('user@example.com')
    expect(row.base_url).toBe('https://example.atlassian.net')
  })

  it('is idempotent on id -- re-applying the same export does not duplicate the row', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertImportSource({ id: 'local-docs' })
    const exported = exportFleet()

    initDatabase(':memory:')
    importFleet(exported.data, { apply: true })
    importFleet(exported.data, { apply: true })

    const rows = getDb().prepare('SELECT * FROM import_sources WHERE id = ?').all('local-docs') as any[]
    expect(rows).toHaveLength(1)
  })

  it('skips a malformed source row (missing required fields) without failing the whole import', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const fleetJson = JSON.stringify({
      ...MINIMAL_FLEET_FIELDS,
      importSources: [
        { id: 'bad-row' },
        { id: 'good-row', type: 'local', path: '/tmp/x', created_at: 1, updated_at: 1 },
      ],
    })
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(getDb().prepare('SELECT * FROM import_sources WHERE id = ?').get('bad-row')).toBeUndefined()
    expect(getDb().prepare('SELECT * FROM import_sources WHERE id = ?').get('good-row')).toBeTruthy()
  })

  it('does not migrate import_memories content along with the source', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertImportSource({ id: 'local-docs' })
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      `INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, last_seen_at, created_at, updated_at)
       VALUES ('mem-1', 'local-docs', '/home/user/docs/a.md', 'a.md', 'hash1', 'content', ?, ?, ?)`
    ).run(now, now, now)

    const exported = exportFleet()
    const fleet = JSON.parse(exported.data)
    expect(fleet.importMemories).toBeUndefined()

    initDatabase(':memory:')
    importFleet(exported.data, { apply: true })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM import_memories').get() as any).toEqual({ n: 0 })
  })
})

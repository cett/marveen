// Round-trip coverage for the four new store/*.json fields in fleet export/import
// (P3): modelFallback/federation/costopsConfig use OVERWRITE semantics (same as
// the pre-existing autonomy/autoRestart/agentsDesired/norbertPersonal fields --
// fleet operational policy, consistent with the identity-takeover model).
//
// egressAllowlist moved from a store/*.json file to the egress_allowlist DB
// table (migration 0056, #985/#984) -- like autonomy below, it is now
// round-tripped as a row array via INSERT OR IGNORE (still MERGE/union
// semantics: a security allowlist should only ever grow via import, never
// silently narrow a target's own approved domains), not through the file
// helpers the rest of this suite exercises.
//
// Uses the REAL node:fs (pointed at a throwaway temp dir via PROJECT_ROOT/STORE_DIR)
// so writeFileSync/readFileSync/existsSync behave exactly as in production -- see
// fleet-transfer-schedules.test.ts for why a mocked fs is unsafe here (it would
// also break db-migrations.ts's real migration-file loading). db.js is real too
// (in-memory SQLite), but unused by this file's assertions directly.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-store-configs-test-'))
  const store = join(root, 'store')
  mkdirSync(store, { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: store, TASKS_DIR: join(root, 'tasks') }
})

afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [], invalidateModelProfileMapCache: () => {} }))
vi.mock('../web/atomic-write.js', async (importOriginal) => {
  const { writeFileSync } = await import('node:fs')
  return {
    atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
  }
})
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

import { readFileSync, writeFileSync, existsSync, rmSync as rmSyncReal } from 'node:fs'
import { join } from 'node:path'

function writeStoreJson(name: string, obj: unknown) {
  writeFileSync(join(STORE_DIR, name), JSON.stringify(obj, null, 2), 'utf-8')
}

function readStoreJson(name: string): any {
  return JSON.parse(readFileSync(join(STORE_DIR, name), 'utf-8'))
}

function clearStoreFile(name: string) {
  const p = join(STORE_DIR, name)
  if (existsSync(p)) rmSyncReal(p)
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
  for (const f of ['model-fallback.json', 'federation.json', 'costops-config.json']) {
    clearStoreFile(f)
  }
})

describe('exportFleet -- store/*.json config fields', () => {
  it('reads all three file-backed fields from disk', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('model-fallback.json', { enabled: true, chain: ['a', 'b'], revertAfterMinutes: 60 })
    writeStoreJson('federation.json', { enabled: true, systemId: 'source-system' })
    writeStoreJson('costops-config.json', { version: 1, currency: 'USD', budgets: [] })

    const result = exportFleet()
    const fleet = JSON.parse(result.data)
    expect(fleet.dashboardSettings.modelFallback).toEqual({ enabled: true, chain: ['a', 'b'], revertAfterMinutes: 60 })
    expect(fleet.dashboardSettings.federation).toEqual({ enabled: true, systemId: 'source-system' })
    expect(fleet.dashboardSettings.costopsConfig.currency).toBe('USD')
  })

  it('returns empty objects when the files do not exist', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const result = exportFleet()
    const fleet = JSON.parse(result.data)
    expect(fleet.dashboardSettings.modelFallback).toEqual({})
    expect(fleet.dashboardSettings.federation).toEqual({})
    expect(fleet.dashboardSettings.costopsConfig).toEqual({})
  })
})

describe('importFleet apply -- overwrite fields (modelFallback/federation/costopsConfig)', () => {
  it('overwrites an existing target file wholesale with the source value', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('model-fallback.json', { enabled: true, chain: ['source-chain'], revertAfterMinutes: 999 })
    const exported = exportFleet()

    clearStoreFile('model-fallback.json')
    writeStoreJson('model-fallback.json', { enabled: false, chain: ['target-own-chain'], revertAfterMinutes: 5 })

    const applied = importFleet(exported.data, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(readStoreJson('model-fallback.json')).toEqual({ enabled: true, chain: ['source-chain'], revertAfterMinutes: 999 })
  })

  it('does not touch the target file when the source value is empty', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('federation.json', { enabled: true, systemId: 'target-keeps-this' })
    const fleetJson = JSON.stringify(baseFleetWith({ federation: {} }))
    importFleet(fleetJson, { apply: true })
    expect(readStoreJson('federation.json')).toEqual({ enabled: true, systemId: 'target-keeps-this' })
  })
})

// egressAllowlist moved from a store/*.json file to the egress_allowlist DB
// table (migration 0056) -- round-tripped as a row array, like autonomy
// below, not through the file helpers the rest of this suite exercises.
// Every fresh initDatabase(':memory:') seeds the 206 domains migrations 0056
// + 0059 bake in (199 + a 7-host quarantine-seed supplement), so assertions
// build on top of that baseline rather than assuming an empty table.
describe('exportFleet/importFleet -- egressAllowlist (DB-backed)', () => {
  it('exports egress_allowlist rows as an array, including the 206 migration-seeded domains', async () => {
    const { insertEgressAllowlistEntry } = await import('../db.js')
    insertEgressAllowlistEntry({ value: 'source.example.com', type: 'domain', tenant_id: 'default' })
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const fleet = JSON.parse(exportFleet().data)
    expect(fleet.dashboardSettings.egressAllowlist).toHaveLength(207)
    expect(fleet.dashboardSettings.egressAllowlist).toContainEqual(
      expect.objectContaining({ value: 'source.example.com', type: 'domain', tenant_id: 'default' }),
    )
  })

  it('unions source rows into the target, keeping target-only entries and never overwriting an existing one', async () => {
    const { insertEgressAllowlistEntry, listEgressAllowlistRows } = await import('../db.js')
    insertEgressAllowlistEntry({ value: 'source.example.com', type: 'domain', tenant_id: 'default', added_by: 'source-op' })
    insertEgressAllowlistEntry({ value: 'shared.example.com', type: 'domain', tenant_id: 'default', added_by: 'source-op' })
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const exported = exportFleet()

    // Fresh "target" DB: re-init wipes the in-memory DB and re-seeds the 206 defaults.
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
    insertEgressAllowlistEntry({ value: 'target-only.example.com', type: 'domain', tenant_id: 'default', added_by: 'target-op' })
    insertEgressAllowlistEntry({ value: 'shared.example.com', type: 'domain', tenant_id: 'default', added_by: 'target-op' })

    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(exported.data, { apply: true }) as any
    expect(applied.ok).toBe(true)

    const rows = listEgressAllowlistRows(null)
    expect(rows.some((r) => r.value === 'source.example.com')).toBe(true)
    expect(rows.some((r) => r.value === 'target-only.example.com')).toBe(true)
    // Target's own row for a value both sides had must survive untouched --
    // INSERT OR IGNORE never fires an UPDATE.
    expect(rows.find((r) => r.value === 'shared.example.com')?.added_by).toBe('target-op')
  })

  it('import does nothing when the source has no egress rows (the 206 seeded defaults are untouched)', async () => {
    const fleetJson = JSON.stringify(baseFleetWith({ egressAllowlist: [] }))
    const { importFleet, exportFleet } = await import('../web/fleet-transfer.js')
    importFleet(fleetJson, { apply: true })
    expect(JSON.parse(exportFleet().data).dashboardSettings.egressAllowlist).toHaveLength(206)
  })
})

// autonomy moved from a store/*.json file to the autonomy_categories DB
// table -- round-tripped as a row array, not read/written through the file
// helpers the rest of this suite exercises.
describe('exportFleet/importFleet -- autonomy (DB-backed)', () => {
  it('exports autonomy_categories rows as an array', async () => {
    const { upsertAutonomyCategory } = await import('../db.js')
    upsertAutonomyCategory({ key: 'custom_category', label: 'Custom', level: 2, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const fleet = JSON.parse(exportFleet().data)
    // 15 defaults (migration 0053) + the one upserted above.
    expect(fleet.dashboardSettings.autonomy).toHaveLength(16)
    expect(fleet.dashboardSettings.autonomy).toContainEqual(
      expect.objectContaining({ key: 'custom_category', label: 'Custom', level: 2, max_level: 3 }),
    )
  })

  it('exports the 15 default categories that migration 0053 seeds on a fresh DB', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const fleet = JSON.parse(exportFleet().data)
    expect(fleet.dashboardSettings.autonomy).toHaveLength(15)
  })

  it('import upserts each row into autonomy_categories without touching categories absent from the snapshot', async () => {
    const { upsertAutonomyCategory, getAutonomyCategory } = await import('../db.js')
    // Target-only category, not present in the imported snapshot.
    upsertAutonomyCategory({ key: 'target_only', label: 'Target only', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })

    const fleetJson = JSON.stringify(baseFleetWith({
      autonomy: [{ key: 'deploy_retry', label: 'Deploy retry (source)', level: 3, locked: 0, max_level: 3, timeout_minutes: 15, updated_at: 1, updated_by: 'migrated_from_json' }],
    }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)

    expect(getAutonomyCategory('deploy_retry')).toEqual(expect.objectContaining({ label: 'Deploy retry (source)', level: 3, timeout_minutes: 15 }))
    expect(getAutonomyCategory('target_only')).toEqual(expect.objectContaining({ label: 'Target only' }))
  })

  it('import does nothing when the source has no autonomy rows (the 15 seeded defaults are untouched)', async () => {
    const fleetJson = JSON.stringify(baseFleetWith({ autonomy: [] }))
    const { importFleet, exportFleet } = await import('../web/fleet-transfer.js')
    importFleet(fleetJson, { apply: true })
    expect(JSON.parse(exportFleet().data).dashboardSettings.autonomy).toHaveLength(15)
  })
})

function baseFleetWith(dashboardSettingsOverrides: Record<string, unknown>) {
  return {
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
    importSources: [],
    dashboardSettings: {
      autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {},
      modelFallback: {}, federation: {}, costopsConfig: {}, egressAllowlist: {},
      ...dashboardSettingsOverrides,
    },
  }
}

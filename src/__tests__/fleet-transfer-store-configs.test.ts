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
// agentsDesired/modelFallback/terminalInputEnabled moved from
// store/agents-desired.json, store/model-fallback.json, and
// store/terminal-input.json to system_config rows (#985 group 5/8) -- like
// autonomy below, they round-trip through their own store modules'
// raw-field getters/setters now, not the file helpers. See the doc comments on
// readModelFallbackFieldsRaw()/writeModelFallbackFieldsRaw() and
// readTerminalInputEnabledRaw() in the respective store modules for why an
// unset field is left ABSENT on export (never filled with a code-level
// default) and left UNTOUCHED on import (never reset) when absent.
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
  for (const f of ['federation.json', 'costops-config.json']) {
    clearStoreFile(f)
  }
})

describe('exportFleet -- store/*.json config fields', () => {
  it('reads the remaining file-backed fields (federation/costopsConfig) from disk', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('federation.json', { enabled: true, systemId: 'source-system' })
    writeStoreJson('costops-config.json', { version: 1, currency: 'USD', budgets: [] })

    const result = exportFleet()
    const fleet = JSON.parse(result.data)
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

describe('importFleet apply -- overwrite fields (federation/costopsConfig)', () => {
  it('overwrites an existing target file wholesale with the source value', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('federation.json', { enabled: true, systemId: 'source-system' })
    const exported = exportFleet()

    clearStoreFile('federation.json')
    writeStoreJson('federation.json', { enabled: false, systemId: 'target-own-system' })

    const applied = importFleet(exported.data, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(readStoreJson('federation.json')).toEqual({ enabled: true, systemId: 'source-system' })
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

// agentsDesired/modelFallback/terminalInputEnabled moved from store/*.json
// files to system_config rows (#985 group 5/8) -- round-tripped through their
// own store modules' getters/setters, not the file helpers above.
describe('exportFleet/importFleet -- agentsDesired/modelFallback/terminalInputEnabled (DB-backed)', () => {
  it('exports agentsDesired as a sorted name array', async () => {
    const { setDesiredAgents } = await import('../web/agent-desired-state.js')
    setDesiredAgents(['agent-b', 'agent-a'])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(JSON.parse(exportFleet().data).dashboardSettings.agentsDesired).toEqual(['agent-a', 'agent-b'])
  })

  it('import replaces the target agentsDesired set wholesale', async () => {
    const { setDesiredAgents, getDesiredAgents } = await import('../web/agent-desired-state.js')
    setDesiredAgents(['target-only'])
    const fleetJson = JSON.stringify(baseFleetWith({ agentsDesired: ['agent-a', 'agent-b'] }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect([...getDesiredAgents()].sort()).toEqual(['agent-a', 'agent-b'])
  })

  it('exports only the modelFallback fields an operator actually set, no code-level defaults', async () => {
    const { setSystemConfig } = await import('../db.js')
    setSystemConfig('model_fallback_enabled', '1')
    setSystemConfig('model_fallback_chain', JSON.stringify(['a', 'b']))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(JSON.parse(exportFleet().data).dashboardSettings.modelFallback).toEqual({ enabled: true, chain: ['a', 'b'] })
  })

  it('import sets only the fields the source snapshot carries, leaving the rest of the target untouched', async () => {
    const { writeModelFallbackFieldsRaw, readModelFallbackFieldsRaw } = await import('../web/model-fallback-store.js')
    writeModelFallbackFieldsRaw({ enabled: false, chain: ['target-own-chain-a', 'target-own-chain-b'], revertAfterMinutes: 5 })
    const fleetJson = JSON.stringify(baseFleetWith({ modelFallback: { enabled: true, revertAfterMinutes: 999 } }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    // enabled/revertAfterMinutes came from the source; chain was absent from
    // the source snapshot, so the target's own chain must survive untouched.
    expect(readModelFallbackFieldsRaw()).toEqual({
      enabled: true,
      chain: ['target-own-chain-a', 'target-own-chain-b'],
      revertAfterMinutes: 999,
    })
  })

  it('omits terminalInputEnabled from the export when never explicitly set', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect('terminalInputEnabled' in JSON.parse(exportFleet().data).dashboardSettings).toBe(false)
  })

  it('exports terminalInputEnabled once explicitly set, and import applies it', async () => {
    const { writeTerminalInputEnabled } = await import('../web/terminal-input-store.js')
    writeTerminalInputEnabled(true)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(JSON.parse(exportFleet().data).dashboardSettings.terminalInputEnabled).toBe(true)

    const { initDatabase: reinit } = await import('../db.js')
    reinit(':memory:') // fresh target, toggle defaults back to OFF
    const fleetJson = JSON.stringify(baseFleetWith({ terminalInputEnabled: true }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    const { readTerminalInputEnabled } = await import('../web/terminal-input-store.js')
    expect(readTerminalInputEnabled()).toBe(true)
  })

  it('import leaves the target toggle untouched when the source snapshot omits it', async () => {
    const { writeTerminalInputEnabled, readTerminalInputEnabled } = await import('../web/terminal-input-store.js')
    writeTerminalInputEnabled(true)
    const fleetJson = JSON.stringify(baseFleetWith({}))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(readTerminalInputEnabled()).toBe(true)
  })
})

// costBudgets moved from the `budgets` field inside store/costops-config.json
// to the cost_budgets DB table (#985 group 6/8) -- round-tripped through
// listCostBudgets()/replaceCostBudgets(), not the file helpers above.
describe('exportFleet/importFleet -- costBudgets (DB-backed)', () => {
  it('exports cost_budgets rows as an array', async () => {
    const { replaceCostBudgets } = await import('../db/cost-budgets.js')
    replaceCostBudgets('default', [{ id: 'global-monthly', amount: 5_000_000 }])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const fleet = JSON.parse(exportFleet().data)
    expect(fleet.dashboardSettings.costBudgets).toHaveLength(1)
    expect(fleet.dashboardSettings.costBudgets[0]).toMatchObject({ id: 'global-monthly', amount: 5_000_000 })
  })

  it('import replaces the target budget set wholesale', async () => {
    const { replaceCostBudgets, listCostBudgets } = await import('../db/cost-budgets.js')
    replaceCostBudgets('default', [{ id: 'target-only', amount: 1 }])
    const fleetJson = JSON.stringify(baseFleetWith({
      costBudgets: [{ id: 'global-monthly', amount: 5_000_000 }],
    }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    const rows = listCostBudgets('default')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('global-monthly')
  })

  it('import does nothing when the source has no costBudgets array', async () => {
    const { replaceCostBudgets, listCostBudgets } = await import('../db/cost-budgets.js')
    replaceCostBudgets('default', [{ id: 'target-only', amount: 1 }])
    const fleetJson = JSON.stringify(baseFleetWith({ costBudgets: undefined }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    importFleet(fleetJson, { apply: true })
    expect(listCostBudgets('default')).toHaveLength(1)
  })

  // PR #524 merge-előtti javítás: an EMPTY costBudgets array must not wipe
  // the target's own budgets -- an empty array can mean "old-format export,
  // this field genuinely absent" or "source fleet has zero budgets
  // configured", neither of which justifies deleting what the target already
  // has (same Object.keys(...).length guard idiom as costopsConfig).
  it('import does NOT wipe the target budgets when the source costBudgets array is empty', async () => {
    const { replaceCostBudgets, listCostBudgets } = await import('../db/cost-budgets.js')
    replaceCostBudgets('default', [{ id: 'target-only', amount: 1 }])
    const fleetJson = JSON.stringify(baseFleetWith({ costBudgets: [] }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(listCostBudgets('default')).toHaveLength(1)
    expect(listCostBudgets('default')[0].id).toBe('target-only')
    expect(applied.warnings?.some((w: string) => w.includes('costBudgets üres volt'))).toBe(true)
  })

  // PR #524 merge-előtti javítás: a malformed entry (missing id, non-number
  // amount) must be dropped via validateConfig() before the DB write, not
  // crash the whole import against cost_budgets' NOT NULL columns -- the
  // valid entries in the same snapshot still land.
  it('import drops an invalid costBudgets entry instead of throwing, and still imports the valid ones', async () => {
    const { listCostBudgets } = await import('../db/cost-budgets.js')
    const fleetJson = JSON.stringify(baseFleetWith({
      costBudgets: [
        { amount: 100 }, // missing id
        { id: 'bad-amount', amount: 'not-a-number' }, // non-number amount
        { id: 'good', amount: 50 },
      ],
    }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    const rows = listCostBudgets('default')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('good')
    expect(applied.warnings?.some((w: string) => w.includes('costBudgets') && w.includes('érvénytelen'))).toBe(true)
  })

  // Boo re-QA (2nd round before merge): every entry invalid -> validatedConfig.budgets
  // is empty even though the SOURCE array was non-empty. The "don't wipe on
  // empty" guard must apply to the VALIDATED/deduped result, not the raw
  // source length -- otherwise replaceCostBudgets('default', []) still runs
  // and wipes the target.
  it('import does NOT wipe the target when every source entry is invalid', async () => {
    const { replaceCostBudgets, listCostBudgets } = await import('../db/cost-budgets.js')
    replaceCostBudgets('default', [{ id: 'target-only', amount: 1 }])
    const fleetJson = JSON.stringify(baseFleetWith({
      costBudgets: [
        { amount: 100 }, // missing id
        { id: 'bad-amount', amount: 'not-a-number' }, // non-number amount
      ],
    }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    const rows = listCostBudgets('default')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('target-only')
    expect(applied.warnings?.some((w: string) => w.includes('egyetlen érvényes bejegyzés sem maradt'))).toBe(true)
  })

  // Boo re-QA (2nd round before merge): a duplicated id in the source used
  // to hit cost_budgets' PRIMARY KEY(id, tenant_id) mid-write and throw.
  // First occurrence wins, same as migrateCostBudgetsFromFile()'s
  // INSERT OR IGNORE.
  it('import de-dupes a repeated id in the source instead of throwing, first entry wins', async () => {
    const { listCostBudgets } = await import('../db/cost-budgets.js')
    const fleetJson = JSON.stringify(baseFleetWith({
      costBudgets: [
        { id: 'dup', amount: 111 },
        { id: 'dup', amount: 222 },
        { id: 'unique', amount: 50 },
      ],
    }))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    const rows = listCostBudgets('default')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 'dup')?.amount).toBe(111)
    expect(applied.warnings?.some((w: string) => w.includes('costBudgets') && w.includes('duplikált id'))).toBe(true)
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

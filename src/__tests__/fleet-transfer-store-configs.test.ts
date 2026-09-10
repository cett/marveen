// Round-trip coverage for the four new store/*.json fields in fleet export/import
// (P3): modelFallback/federation/costopsConfig use OVERWRITE semantics (same as
// the pre-existing autonomy/autoRestart/agentsDesired/norbertPersonal fields --
// fleet operational policy, consistent with the identity-takeover model), while
// egressAllowlist uses MERGE/union semantics -- a security allowlist should only
// ever grow via migration, never silently narrow a target's own approved domains.
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
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [] }))
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
  for (const f of ['model-fallback.json', 'federation.json', 'costops-config.json', 'egress-allowlist.json']) {
    clearStoreFile(f)
  }
})

describe('exportFleet -- store/*.json config fields', () => {
  it('reads all four new fields from disk', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('model-fallback.json', { enabled: true, chain: ['a', 'b'], revertAfterMinutes: 60 })
    writeStoreJson('federation.json', { enabled: true, systemId: 'source-system' })
    writeStoreJson('costops-config.json', { version: 1, currency: 'USD', budgets: [] })
    writeStoreJson('egress-allowlist.json', { domains: ['source.example.com', 'shared.example.com'] })

    const result = exportFleet()
    const fleet = JSON.parse(result.data)
    expect(fleet.dashboardSettings.modelFallback).toEqual({ enabled: true, chain: ['a', 'b'], revertAfterMinutes: 60 })
    expect(fleet.dashboardSettings.federation).toEqual({ enabled: true, systemId: 'source-system' })
    expect(fleet.dashboardSettings.costopsConfig.currency).toBe('USD')
    expect(fleet.dashboardSettings.egressAllowlist.domains).toEqual(['source.example.com', 'shared.example.com'])
  })

  it('returns empty objects when the files do not exist', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const result = exportFleet()
    const fleet = JSON.parse(result.data)
    expect(fleet.dashboardSettings.modelFallback).toEqual({})
    expect(fleet.dashboardSettings.federation).toEqual({})
    expect(fleet.dashboardSettings.costopsConfig).toEqual({})
    expect(fleet.dashboardSettings.egressAllowlist).toEqual({})
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

describe('importFleet apply -- merge field (egressAllowlist)', () => {
  it('unions source domains into the target existing list, keeping target-only entries', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('egress-allowlist.json', { domains: ['source.example.com', 'shared.example.com'] })
    const exported = exportFleet()

    clearStoreFile('egress-allowlist.json')
    writeStoreJson('egress-allowlist.json', { domains: ['target-only.example.com', 'shared.example.com'] })

    const applied = importFleet(exported.data, { apply: true }) as any
    expect(applied.ok).toBe(true)
    const merged = readStoreJson('egress-allowlist.json').domains as string[]
    expect(merged.sort()).toEqual(['shared.example.com', 'source.example.com', 'target-only.example.com'])
  })

  it('creates the target file from the source list when the target has none yet', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('egress-allowlist.json', { domains: ['source-only.example.com'] })
    const exported = exportFleet()

    // no clearStoreFile needed -- beforeEach already ensured a clean target

    importFleet(exported.data, { apply: true })
    expect(readStoreJson('egress-allowlist.json').domains).toEqual(['source-only.example.com'])
  })

  it('does not touch the target file when the source has no domains', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    writeStoreJson('egress-allowlist.json', { domains: ['target-only.example.com'] })
    const fleetJson = JSON.stringify(baseFleetWith({ egressAllowlist: {} }))
    importFleet(fleetJson, { apply: true })
    expect(readStoreJson('egress-allowlist.json').domains).toEqual(['target-only.example.com'])
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

// The whole fleet import (importFleet with apply) from a small snapshot, on both engines (SQLite in the default suite,
// PostgreSQL in the module run: the file is in the ported list). The body of the import transaction runs only calls on
// its handle, so on PostgreSQL the apply does not hit the strict rule; and one failure injected in the MIDDLE of the body
// (a kanban comment the table refuses, after the autonomy, model map, settings, federation, budgets, egress, skill and
// kanban card writes went in) leaves nothing behind: not the rows of any family, not the audit row, not a staged file in
// its final place, and the process-local caches show the old values again.
//
// fleet-transfer-two-phase.test.ts is the SQLite-only cousin that also watches the file and network side of the phases.
//
// Privacy: neutral fixtures only (agent-a, agent-b, host-a, actor-a).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { dbx, upsertModelProfileMapEntry, setAgentSetting, insertEgressAllowlistEntry } from '../db.js'
import { setDesiredAgents } from '../web/agent-desired-state.js'
import { writeModelFallbackFieldsRaw } from '../web/model-fallback-store.js'
import { writeTerminalInputEnabled } from '../web/terminal-input-store.js'
import { setFederationConfigRaw } from '../db/federation.js'
import { replaceCostBudgets } from '../db/cost-budgets.js'
import { loadSystemConfigCacheAsync, cachedSystemConfig } from '../db/config-cache.js'
import { loadModelProfileMapCacheAsync, cachedModelProfileMapEntry } from '../db/model-profile-map-cache.js'
import { loadAgentSettingsCacheAsync, cachedAgentSetting } from '../db/agent-settings-cache.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'

const { ROOT, PROJECT, STORE, HOME, AGENTS, TASKS } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root: string = mkdtempSync(join(tmpdir(), 'fleet-apply-engines-test-'))
  return {
    ROOT: root,
    PROJECT: join(root, 'project'),
    STORE: join(root, 'store'),
    HOME: join(root, 'home'),
    AGENTS: join(root, 'agents'),
    TASKS: join(root, 'tasks'),
  }
})

afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(ROOT, { recursive: true, force: true })
})

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: AGENTS, listAgentNames: () => [], invalidateModelProfileMapCache: () => {} }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: TASKS }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: PROJECT,
  STORE_DIR: STORE,
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'TestBot',
  BRAND_NAME: 'TestBot',
  OWNER_NAME: 'test',
  CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => HOME }))

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { importFleet, type FleetJson } from '../web/fleet-transfer.js'
import { listModelProfileMap } from '../db/model-profile-map.js'

useTestDb()

const SKILL_MD = '---\nname: skill-g\ndescription: A global skill\n---\nbody\n'

function bundle(extra: { comments?: Record<string, unknown>[] } = {}): FleetJson {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sourceHost: 'host-a',
    mainAgent: {
      agentId: 'agent-a',
      identity: { MAIN_AGENT_ID: 'agent-a', BOT_NAME: 'Bot A', BRAND_NAME: 'Brand A', OWNER_NAME: 'Owner A', CHANNEL_PROVIDER: 'telegram' },
      claudeMd: 'new claude\n',
      soulMd: 'new soul\n',
      config: {},
      mcp: { mcpServers: {} },
      settings: {},
      channelsAccess: {},
    },
    agents: [],
    skills: [{ name: 'skill-g', skillMd: SKILL_MD }],
    scheduledTasks: [],
    memories: [{
      agent_id: 'agent-a', content: 'memory-a', sector: 'semantic', salience: 1, created_at: 1, accessed_at: 1,
      category: 'warm', auto_generated: 0, keywords: null,
    }] as never,
    dailyLogs: [],
    kanban: {
      labels: [],
      cards: [{
        id: 'card-a', title: 'Card A', description: '', status: 'planned', priority: 'normal', sort_order: 1,
        created_at: 1, updated_at: 1,
      }],
      comments: extra.comments ?? [],
      cardEvents: [],
      cardLabels: [],
    },
    ideaBox: { ideas: [], comments: [], statusLog: [] },
    schedules: [],
    importSources: [],
    vaultSshKeys: [],
    vaultSshServers: [],
    dashboardSettings: {
      autonomy: [{ key: 'category-new', label: 'Category New', level: 2, locked: 0, max_level: 3, timeout_minutes: 30, updated_by: 'import', updated_at: 0 }],
      modelProfileMap: [{ profile_id: 'build_strong', model_id: 'model-new', updated_by: 'import', updated_at: 0 }],
      autoRestart: { 'agent-b': { enabled: true } },
      agentsDesired: ['agent-new'],
      norbertPersonal: {},
      modelFallback: { enabled: true, chain: ['model-new-1', 'model-new-2'], revertAfterMinutes: 45 },
      federation: { enabled: false, systemId: 'system-new' },
      costopsConfig: {},
      costBudgets: [{ id: 'budget-new', name: 'Budget New', scope: 'global', amount: 200, currency: 'USD' }],
      terminalInputEnabled: true,
      egressAllowlist: [{ value: 'imported.example.com', type: 'domain' }] as never,
    },
  }
}

/** A comment with no author: it passes the row filter and breaks NOT NULL inside the transaction. */
const BROKEN_COMMENT = { card_id: 'card-a', content: 'a comment without an author', created_at: 1 }

async function seedTarget(): Promise<void> {
  await upsertModelProfileMapEntry({ profile_id: 'build_strong', model_id: 'model-old', updated_by: 'target' })
  await setAgentSetting('agent-b', 'auto_restart', { enabled: false })
  await setDesiredAgents(['agent-old'])
  await writeModelFallbackFieldsRaw({ enabled: false, chain: ['model-old'], revertAfterMinutes: 5 })
  await writeTerminalInputEnabled(false)
  await setFederationConfigRaw(JSON.stringify({ enabled: false, systemId: 'system-old' }))
  await replaceCostBudgets('default', [{ id: 'budget-old', name: 'Budget Old', scope: 'global', amount: 1, currency: 'HUF' }])
  await insertEgressAllowlistEntry({ value: 'target-only.example.com', type: 'domain' })
}

/** Every family the import writes, as plain data (the audit rows of the test actor included). */
async function state(): Promise<Record<string, unknown>> {
  const all = (sql: string) => dbx.all(sql)
  return {
    autonomy: await all('SELECT key, label, level FROM autonomy_categories ORDER BY key'),
    modelMap: await all('SELECT profile_id, model_id FROM model_profile_map ORDER BY profile_id'),
    autoRestart: await all("SELECT agent_id, setting_value FROM agent_settings WHERE setting_key = 'auto_restart' ORDER BY agent_id"),
    systemConfig: await all("SELECT key, value FROM system_config WHERE key IN ('agents_desired', 'terminal_input_enabled', 'federation_config_json') OR key LIKE 'model_fallback_%' ORDER BY key"),
    budgets: await all('SELECT id, amount FROM cost_budgets ORDER BY id'),
    egress: await all("SELECT value FROM egress_allowlist WHERE value LIKE '%.example.com' ORDER BY value"),
    cards: await all('SELECT id FROM kanban_cards ORDER BY id'),
    memories: await all("SELECT content FROM memories WHERE agent_id = 'agent-a' ORDER BY content"),
    skills: await all("SELECT id FROM skills WHERE name = 'skill-g'"),
    audit: await all("SELECT entity_id FROM agent_audit_log WHERE agent_id = 'actor-a'"),
  }
}

const apply = (fleet: FleetJson) => importFleet(JSON.stringify(fleet), { apply: true, humanSession: true, actor: 'actor-a' })

beforeEach(async () => {
  // a clean file side per test: what one apply put in place must not look like a leftover of the next
  for (const dir of [PROJECT, STORE, HOME, AGENTS, TASKS]) rmSync(dir, { recursive: true, force: true })
  await seedTarget()
  await loadSystemConfigCacheAsync()
  await loadModelProfileMapCacheAsync()
  await loadAgentSettingsCacheAsync()
})

describe('importFleet apply on both engines', () => {
  it('applies the snapshot: every family lands (the body holds no call on the outer dbx, which Postgres would refuse)', async () => {
    const before = await state()
    await apply(bundle())
    const after = await state()
    expect(after).not.toEqual(before)
    expect(after['autonomy']).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'category-new', level: 2 })]))
    expect(after['modelMap']).toEqual(expect.arrayContaining([{ profile_id: 'build_strong', model_id: 'model-new' }]))
    expect(after['autoRestart']).toEqual([{ agent_id: 'agent-b', setting_value: JSON.stringify({ enabled: true }) }])
    expect(JSON.stringify(after['systemConfig'])).toContain('agent-new')
    expect(after['budgets']).toEqual([{ id: 'budget-new', amount: 200 }])
    expect(after['egress']).toEqual([{ value: 'imported.example.com' }, { value: 'target-only.example.com' }])
    expect(after['cards']).toEqual([{ id: 'card-a' }])
    expect(after['memories']).toEqual([{ content: 'memory-a' }])
    expect(after['skills']).toHaveLength(1)
    expect(after['audit']).toEqual([{ entity_id: 'category-new' }])
    expect(existsSync(join(PROJECT, 'CLAUDE.md'))).toBe(true)
  })

  it('a refusal in the middle of the body leaves nothing behind: rows, audit row, files and caches are as before', async () => {
    const before = await state()
    await expect(apply(bundle({ comments: [BROKEN_COMMENT] }))).rejects.toThrow()
    expect(await state()).toEqual(before)
    expect(existsSync(join(PROJECT, 'CLAUDE.md'))).toBe(false) // a staged file never reached its final place
    // the write-through caches showed the new values inside the transaction: the failure branch re-reads them
    expect(listModelProfileMap().find((r) => r.profile_id === 'build_strong')?.model_id).toBe('model-old')
    expect(cachedModelProfileMapEntry('build_strong')?.model_id).toBe('model-old')
    expect(cachedAgentSetting('agent-b', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: false }))
    expect(cachedSystemConfig('terminal_input_enabled')?.value).toBe('0')
  })

  it('a refused audit row does not fail the import, the change it describes still lands', async () => {
    // only the autonomy audit rows (entity 'approval'): the skill revision's audit row is part of the import and is not swallowed
    await refuseWrite(dbx, { name: 'no_audit_row', table: 'agent_audit_log', message: 'audit refused', when: { column: 'entity', equals: 'approval' } })
    await apply(bundle())
    const after = await state()
    expect(after['autonomy']).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'category-new' })]))
    expect(after['audit']).toEqual([])
    expect(testDbMode()).toMatch(/sqlite|pg/)
  })
})

// The fleet import is applied in two phases: the files are staged, ONE transaction holds every database
// write, and only after the commit the files are renamed into place, the caches re-read, the vault step and the
// .env mirror run. These tests use the real db (in-memory SQLite) and the real fs in a throwaway root, and watch
// the fs and the transaction boundary through the mocks below.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  initDatabase, getDb, upsertModelProfileMapEntry, setAgentSetting, listAutonomyCategories, insertEgressAllowlistEntry,
  listEgressAllowlistRows,
} from '../db.js'
import { setDesiredAgents, getDesiredAgents } from '../web/agent-desired-state.js'
import { writeModelFallbackFieldsRaw, readModelFallbackFieldsRaw } from '../web/model-fallback-store.js'
import { writeTerminalInputEnabled, readTerminalInputEnabledRaw } from '../web/terminal-input-store.js'
import { getFederationConfigRaw, setFederationConfigRaw } from '../db/federation.js'
import { getFederationConfig } from '../web/federation/config.js'
import { replaceCostBudgets, listCostBudgets } from '../db/cost-budgets.js'
import { listVaultBindings } from '../db/vault-bindings.js'
import { cachedSystemConfigList } from '../db/config-cache.js'
import { cachedModelProfileMapList } from '../db/model-profile-map-cache.js'
import { cachedAgentSettingsByKey } from '../db/agent-settings-cache.js'
import { listModelProfileMap } from '../db/model-profile-map.js'
import { listAgentSettingsByKey } from '../db/agent-settings.js'
import { updateEnvFile } from '../env.js'
import { scanImportLeftovers } from '../web/fleet-import-leftovers.js'

const { ROOT, PROJECT, STORE, HOME, AGENTS, TASKS, probe } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root: string = mkdtempSync(join(tmpdir(), 'fleet-two-phase-test-'))
  return {
    ROOT: root,
    PROJECT: join(root, 'project'),
    STORE: join(root, 'store'),
    HOME: join(root, 'home'),
    AGENTS: join(root, 'agents'),
    TASKS: join(root, 'tasks'),
    probe: {
      /** True while the import transaction body runs. */
      inTx: false,
      /** fs and network calls made while the transaction body ran. */
      ioInTx: [] as string[],
      /** Ordered log: begin / commit / rollback, final:<file> for a rename onto a final path, env. */
      events: [] as string[],
      /** A rename onto exactly this path throws. */
      failRenameTo: null as string | null,
      /** A copy onto exactly this path ends with other content than the source: a restore that "succeeds" wrongly. */
      corruptCopyTo: null as string | null,
      /** Removing a `.import-new` / `.import-bak` file is a no-op: what a crash before the cleanup would leave behind. */
      keepLeftovers: false,
    },
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
vi.mock('../env.js', () => ({
  updateEnvFile: vi.fn(() => { probe.events.push('env') }),
}))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => HOME }))

// The real fs, watched: a rename can be made to fail, and any call made while the transaction body runs is logged.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const watch = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => {
    if (probe.inTx) probe.ioInTx.push(`${name} ${String(a[0])}`)
    return fn(...a)
  }
  return {
    ...real,
    existsSync: watch('existsSync', real.existsSync),
    mkdirSync: watch('mkdirSync', real.mkdirSync),
    writeFileSync: watch('writeFileSync', real.writeFileSync),
    readFileSync: watch('readFileSync', real.readFileSync),
    copyFileSync: (from: string, to: string) => {
      if (probe.inTx) probe.ioInTx.push(`copyFileSync ${String(from)}`)
      real.copyFileSync(from, to)
      if (probe.corruptCopyTo !== null && String(to) === probe.corruptCopyTo) real.writeFileSync(to, 'not the previous content')
    },
    unlinkSync: (path: string) => {
      if (probe.keepLeftovers && /\.import-(new|bak)$/.test(String(path))) return
      watch('unlinkSync', real.unlinkSync)(path)
    },
    rmSync: (...a: Parameters<typeof real.rmSync>) => {
      if (probe.keepLeftovers) return // the directories the import created, with their staged files, stay too
      watch('rmSync', real.rmSync)(...a)
    },
    renameSync: (from: string, to: string) => {
      if (probe.inTx) probe.ioInTx.push(`renameSync ${from}`)
      if (probe.failRenameTo !== null && String(to) === probe.failRenameTo) throw new Error(`rename refused: ${to}`)
      real.renameSync(from, to)
      if (String(from).endsWith('.import-new')) probe.events.push(`final:${String(to).slice(ROOT.length + 1)}`)
    },
  }
})

// The transaction boundary, as seen by the tests.
vi.mock('../db/fleet-transfer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/fleet-transfer.js')>()
  return {
    ...real,
    inFleetImportTransaction: async (fn: () => Promise<void>) => {
      probe.events.push('begin')
      probe.inTx = true
      try {
        await real.inFleetImportTransaction(fn)
      } catch (err) {
        probe.events.push('rollback')
        throw err
      } finally {
        probe.inTx = false
      }
      probe.events.push('commit')
    },
  }
})

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ImportInProgressError, importFleet, StaleBackupError, type FleetJson } from '../web/fleet-transfer.js'

// ---------------------------------------------------------------------------
// Fixture: a target that already has its own values, and a bundle that would replace every one of them.
// ---------------------------------------------------------------------------

const OLD = {
  claude: 'old claude\n',
  soul: 'old soul\n',
  mcp: '{"old":true}',
  agentClaude: 'old agent claude\n',
  skill: 'old global skill\n',
  costops: '{"old":true}',
  vaultKey: 'old-vault-key',
  vaultJson: '{"entries":[]}',
}

const SKILL_MD = '---\nname: skill-g\ndescription: A global skill\n---\nbody\n'
const AGENT_SKILL_MD = '---\nname: skill-a\ndescription: An agent skill\n---\nbody\n'

function bundle(extra: { comments?: Record<string, unknown>[]; memories?: FleetJson['memories'] } = {}): FleetJson {
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
      settings: { new: true },
      channelsAccess: {},
    },
    agents: [{
      name: 'agent-b',
      config: { model: 'model-a' },
      claudeMd: 'new agent claude\n',
      soulMd: '',
      mcp: { mcpServers: {} },
      settings: {},
      channelsAccess: {},
      avatar: null,
      avatarExt: 'png',
      agentSkills: [{ name: 'skill-a', skillMd: AGENT_SKILL_MD }],
    }],
    skills: [{ name: 'skill-g', skillMd: SKILL_MD }],
    scheduledTasks: [{ dirName: 'task-a', skillMd: 'task body\n', config: { schedule: '0 7 * * *' } }],
    memories: extra.memories ?? [],
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
      costopsConfig: { version: 1, currency: 'USD' },
      costBudgets: [{ id: 'budget-new', name: 'Budget New', scope: 'global', amount: 200, currency: 'USD' }],
      terminalInputEnabled: true,
      egressAllowlist: [{ value: 'imported.example.com', type: 'domain' }] as never,
    },
    vault: { vaultKey: 'new-vault-key', entries: [], bindings: [{ vaultSecretId: 'secret-new', envVar: 'VAR_NEW', targets: [] }] },
  }
}

/** A comment with no author: it passes the row filter and breaks NOT NULL inside the transaction. */
const BROKEN_COMMENT = { card_id: 'card-a', content: 'a comment without an author', created_at: 1 }

function put(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

async function seedTarget(): Promise<void> {
  put(join(PROJECT, 'CLAUDE.md'), OLD.claude)
  put(join(PROJECT, 'SOUL.md'), OLD.soul)
  put(join(PROJECT, '.mcp.json'), OLD.mcp)
  put(join(AGENTS, 'agent-b', 'CLAUDE.md'), OLD.agentClaude)
  put(join(HOME, '.claude', 'skills', 'skill-g', 'SKILL.md'), OLD.skill)
  put(join(STORE, 'costops-config.json'), OLD.costops)
  put(join(STORE, '.vault-key'), OLD.vaultKey)
  put(join(STORE, 'vault.json'), OLD.vaultJson)

  await upsertModelProfileMapEntryOld()
  await setAgentSetting('agent-b', 'auto_restart', { enabled: false })
  await setDesiredAgents(['agent-old'])
  await writeModelFallbackFieldsRaw({ enabled: false, chain: ['model-old'], revertAfterMinutes: 5 })
  await writeTerminalInputEnabled(false)
  await setFederationConfigRaw(JSON.stringify({ enabled: false, systemId: 'system-old' }))
  getFederationConfig() // prime the federation cache with the old document
  await replaceCostBudgets('default', [{ id: 'budget-old', name: 'Budget Old', scope: 'global', amount: 1, currency: 'HUF' }])
  await insertEgressAllowlistEntry({ value: 'target-only.example.com', type: 'domain' })
}

async function upsertModelProfileMapEntryOld(): Promise<void> {
  await upsertModelProfileMapEntry({ profile_id: 'build_strong', model_id: 'model-old', updated_by: 'target' })
}

// ---------------------------------------------------------------------------
// What the tests compare
// ---------------------------------------------------------------------------

interface Probe {
  name: string
  /** The value in the table. */
  db: () => Promise<unknown> | unknown
  /** The value a reader serves from the process-local cache (absent for a table nothing caches). */
  cache?: () => unknown
}

const rows = (sql: string, ...args: unknown[]) => getDb().prepare(sql).all(...args)

const PROBES: Probe[] = [
  {
    name: 'autonomy categories',
    db: async () => (await listAutonomyCategories()).map((r) => ({ ...r, updated_at: 0 })),
  },
  {
    name: 'model profile map',
    db: () => rows('SELECT profile_id, model_id, updated_by FROM model_profile_map ORDER BY profile_id'),
    cache: () => listModelProfileMap().map((r) => ({ profile_id: r.profile_id, model_id: r.model_id, updated_by: r.updated_by })),
  },
  {
    name: 'auto_restart setting',
    db: () => rows("SELECT agent_id, setting_value FROM agent_settings WHERE setting_key = 'auto_restart' ORDER BY agent_id"),
    cache: () => listAgentSettingsByKey('auto_restart'),
  },
  {
    name: 'desired agents',
    db: () => rows("SELECT value FROM system_config WHERE key = 'agents_desired'"),
    cache: () => [...getDesiredAgents()].sort(),
  },
  {
    name: 'model fallback',
    db: () => rows("SELECT key, value FROM system_config WHERE key LIKE 'model_fallback_%' ORDER BY key"),
    cache: () => readModelFallbackFieldsRaw(),
  },
  {
    name: 'terminal input',
    db: () => rows("SELECT value FROM system_config WHERE key = 'terminal_input_enabled'"),
    cache: () => readTerminalInputEnabledRaw(),
  },
  {
    name: 'federation config',
    db: () => rows("SELECT value FROM system_config WHERE key = 'federation_config_json'"),
    cache: () => [getFederationConfigRaw(), getFederationConfig().systemId],
  },
  {
    name: 'cost budgets',
    db: async () => (await listCostBudgets('default')).map((b) => ({ id: b.id, name: b.name, amount: b.amount })),
  },
  {
    name: 'egress allowlist',
    db: async () => (await listEgressAllowlistRows(null)).map((r) => `${r.type}:${r.value}`).sort(),
  },
]

async function snapshotProbes(): Promise<{ db: unknown[]; cache: unknown[] }> {
  const db: unknown[] = []
  const cache: unknown[] = []
  for (const p of PROBES) {
    db.push(await p.db())
    cache.push(p.cache ? p.cache() : null)
  }
  return { db, cache }
}

/** Every file and directory under the root, with the content of each file. */
function tree(dir = ROOT, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = relative(ROOT, full)
    if (statSync(full).isDirectory()) { out[`${rel}/`] = 'dir'; tree(full, out) } else out[rel] = readFileSync(full, 'utf-8')
  }
  return out
}

const strays = () => Object.keys(tree()).filter((p) => p.endsWith('.import-new') || p.endsWith('.import-bak') || p.endsWith('.tmp'))

/** The three write-through caches hold exactly what the tables hold. */
function expectCachesMatchTables(): void {
  expect(cachedSystemConfigList()).toEqual(rows('SELECT key, value, updated_at, source FROM system_config ORDER BY key'))
  expect(cachedModelProfileMapList()).toEqual(rows('SELECT profile_id, model_id, updated_at, updated_by FROM model_profile_map ORDER BY profile_id'))
  const fromTable: Record<string, unknown> = {}
  for (const r of rows("SELECT agent_id, setting_value FROM agent_settings WHERE setting_key = 'auto_restart'") as { agent_id: string; setting_value: string }[]) {
    fromTable[r.agent_id] = JSON.parse(r.setting_value)
  }
  expect(cachedAgentSettingsByKey('auto_restart')).toEqual(fromTable)
}

beforeEach(async () => {
  initDatabase(':memory:')
  probe.keepLeftovers = false // first: the cleanup below must really run
  rmSync(ROOT, { recursive: true, force: true })
  for (const d of [PROJECT, STORE, HOME, AGENTS, TASKS]) mkdirSync(d, { recursive: true })
  probe.inTx = false
  probe.ioInTx = []
  probe.events = []
  probe.failRenameTo = null
  probe.corruptCopyTo = null
  vi.mocked(updateEnvFile).mockClear()
  vi.mocked(updateEnvFile).mockImplementation(() => { probe.events.push('env') })
  await seedTarget()
})

const apply = (fleet: FleetJson) => importFleet(JSON.stringify(fleet), { apply: true })

// ---------------------------------------------------------------------------

describe('a row that fails inside the transaction leaves nothing applied', () => {
  let before: { db: unknown[]; cache: unknown[] }
  let filesBefore: Record<string, string>
  let error: unknown

  beforeEach(async () => {
    before = await snapshotProbes()
    filesBefore = tree()
    error = await apply(bundle({ comments: [BROKEN_COMMENT] })).then(() => undefined, (e: unknown) => e)
  })

  it('fails the import with the row error, after the transaction began and rolled back', () => {
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toMatch(/NOT NULL/)
    expect(probe.events).toEqual(['begin', 'rollback'])
  })

  it.each(PROBES.map((p, i) => [p.name, i] as const))('%s: the table and the cache are unchanged', async (_name, i) => {
    const p = PROBES[i]
    expect(await p.db()).toEqual(before.db[i])
    if (p.cache) expect(p.cache()).toEqual(before.cache[i])
  })

  it('the caches hold exactly what the tables hold', () => {
    expectCachesMatchTables()
  })

  it('rolls back the rows imported before the failing one, and the skill rows', () => {
    expect(rows("SELECT id FROM kanban_cards WHERE id = 'card-a'")).toEqual([])
    expect(rows("SELECT id FROM skills WHERE id IN ('global/skill-g', 'agent/agent-b/skill-a')")).toEqual([])
  })

  it('every file is byte-identical, and no staged file, backup, directory or other file is left', () => {
    expect(tree()).toEqual(filesBefore)
    expect(strays()).toEqual([])
  })

  it('does not touch the vault (files and bindings) and does not write .env', async () => {
    expect(readFileSync(join(STORE, '.vault-key'), 'utf-8')).toBe(OLD.vaultKey)
    expect(readFileSync(join(STORE, 'vault.json'), 'utf-8')).toBe(OLD.vaultJson)
    expect(await listVaultBindings('default')).toEqual([])
    expect(updateEnvFile).not.toHaveBeenCalled()
    expect(probe.events.some((e) => e.startsWith('final:') || e === 'env')).toBe(false)
  })
})

describe('a skills SQL failure is not swallowed', () => {
  it('fails the import and rolls the transaction back, files and settings included', async () => {
    getDb().exec("CREATE TRIGGER refuse_skill_rows BEFORE INSERT ON skills BEGIN SELECT RAISE(ABORT, 'skill row refused'); END")
    const before = await snapshotProbes()
    const filesBefore = tree()

    await expect(apply(bundle())).rejects.toThrow(/skill row refused/)

    expect(probe.events).toEqual(['begin', 'rollback'])
    const after = await snapshotProbes()
    expect(after).toEqual(before)
    expect(tree()).toEqual(filesBefore)
    expectCachesMatchTables()
  })
})

describe('a memory row with no visible text in the bundle', () => {
  const memory = (content: string) => ({
    agent_id: 'agent-a', content, sector: 'semantic', salience: 1, created_at: 1, accessed_at: 1,
    category: 'warm', auto_generated: 0, keywords: '',
  })
  const ZWSP = String.fromCodePoint(0x200b)

  it('is left out with a warning, and the other rows and every other table are imported', async () => {
    const result = await apply(bundle({ memories: [memory('first memory'), memory(ZWSP), memory('   '), memory('second memory')] })) as {
      ok: boolean; imported: { memories: number }; warnings?: string[]
    }

    expect(result.ok).toBe(true)
    expect(rows("SELECT content FROM memories ORDER BY content")).toEqual([{ content: 'first memory' }, { content: 'second memory' }])
    expect(result.imported.memories).toBe(2)
    expect(result.warnings?.some((w) => w.includes('2 sor'))).toBe(true)
    // the import was not rolled back: another table of the same bundle is in place
    expect(rows("SELECT id FROM kanban_cards WHERE id = 'card-a'")).toEqual([{ id: 'card-a' }])
    expect(probe.events).not.toContain('rollback')
  })

  it('does not count in the dry run either', async () => {
    const report = await importFleet(JSON.stringify(bundle({ memories: [memory('first memory'), memory(ZWSP)] })), { apply: false }) as {
      wouldCreate: { memories: number }; warnings: string[]
    }

    expect(report.wouldCreate.memories).toBe(1)
    expect(report.warnings.some((w) => w.includes('1 memória-sor'))).toBe(true)
  })
})

describe('a successful import', () => {
  it('puts every value in place, the caches equal the tables, and nothing is left behind', async () => {
    const result = await apply(bundle({ comments: [{ card_id: 'card-a', author: 'author-a', content: 'a comment', created_at: 1 }] }))

    expect((result as { ok: boolean }).ok).toBe(true)
    // database
    expect((await listAutonomyCategories()).find((r) => r.key === 'category-new')?.level).toBe(2)
    expect(listModelProfileMap().find((r) => r.profile_id === 'build_strong')?.model_id).toBe('model-new')
    expect(listAgentSettingsByKey('auto_restart')).toEqual({ 'agent-b': { enabled: true } })
    expect([...getDesiredAgents()]).toEqual(['agent-new'])
    expect(readModelFallbackFieldsRaw()).toEqual({ enabled: true, chain: ['model-new-1', 'model-new-2'], revertAfterMinutes: 45 })
    expect(readTerminalInputEnabledRaw()).toBe(true)
    expect(getFederationConfig().systemId).toBe('system-new')
    expect((await listCostBudgets('default')).map((b) => b.id)).toEqual(['budget-new'])
    expect((await listEgressAllowlistRows(null)).map((r) => r.value)).toEqual(expect.arrayContaining(['imported.example.com', 'target-only.example.com']))
    expect(rows("SELECT id FROM skills WHERE id IN ('global/skill-g', 'agent/agent-b/skill-a') ORDER BY id")).toEqual([{ id: 'agent/agent-b/skill-a' }, { id: 'global/skill-g' }])
    expect(rows("SELECT content FROM kanban_comments")).toEqual([{ content: 'a comment' }])
    expect((await listVaultBindings('default')).map((b) => b.envVar)).toEqual(['VAR_NEW'])
    // caches
    expectCachesMatchTables()
    // files
    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('new claude\n')
    expect(readFileSync(join(PROJECT, 'SOUL.md'), 'utf-8')).toBe('new soul\n')
    expect(readFileSync(join(AGENTS, 'agent-b', 'CLAUDE.md'), 'utf-8')).toBe('new agent claude\n')
    expect(readFileSync(join(HOME, '.claude', 'skills', 'skill-g', 'SKILL.md'), 'utf-8')).toBe(SKILL_MD)
    expect(readFileSync(join(AGENTS, 'agent-b', '.claude', 'skills', 'skill-a', 'SKILL.md'), 'utf-8')).toBe(AGENT_SKILL_MD)
    expect(JSON.parse(readFileSync(join(STORE, 'costops-config.json'), 'utf-8')).currency).toBe('USD')
    expect(readFileSync(join(STORE, '.vault-key'), 'utf-8')).toBe('new-vault-key')
    expect(existsSync(join(TASKS, 'task-a', 'task-config.json'))).toBe(true)
    // no staged file, and no backup either (they are removed after a success)
    expect(strays()).toEqual([])
    expect(updateEnvFile).toHaveBeenCalledTimes(1)
  })

  it('orders the work: files staged, then one transaction, then the renames, the vault files, and .env last', async () => {
    await apply(bundle())

    const events = probe.events
    const begin = events.indexOf('begin')
    const commit = events.indexOf('commit')
    expect(begin).toBe(0)
    expect(commit).toBeGreaterThan(begin)
    expect(events.filter((e) => e === 'begin')).toHaveLength(1)
    const finals = events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith('final:'))
    expect(finals.length).toBeGreaterThan(5)
    expect(finals.every(([, i]) => i > commit)).toBe(true)
    const vaultAt = events.indexOf('final:store/.vault-key')
    const lastOrdinary = Math.max(...finals.filter(([e]) => e !== 'final:store/.vault-key' && e !== 'final:store/vault.json').map(([, i]) => i))
    expect(vaultAt).toBeGreaterThan(lastOrdinary)
    expect(events.indexOf('env')).toBe(events.length - 1)
  })

  it('does no file or network I/O inside the transaction body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      if (probe.inTx) probe.ioInTx.push('fetch')
      return Promise.reject(new Error('no network in this test'))
    })
    try {
      await apply(bundle())
    } finally {
      fetchSpy.mockRestore()
    }
    expect(probe.ioInTx).toEqual([])
  })
})

describe('a failure after the commit', () => {
  it('restores the files already renamed from their backups, removes those backups, keeps the database, and says so', async () => {
    probe.failRenameTo = join(PROJECT, 'SOUL.md') // CLAUDE.md is renamed first, SOUL.md is the second rename

    const error = await apply(bundle()).then(() => undefined, (e: unknown) => e as Error)

    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toMatch(/database changes were committed and stay in place/)
    expect(error!.message).toMatch(/rename refused/)
    expect(error!.message).toMatch(/restored to their previous content \(their \.import-bak backups are removed\)/)
    // the first file went back to its previous content, the second never changed
    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe(OLD.claude)
    expect(readFileSync(join(PROJECT, 'SOUL.md'), 'utf-8')).toBe(OLD.soul)
    // the database stays committed, caches included
    expect(probe.events.slice(0, 2)).toEqual(['begin', 'commit'])
    expect(rows("SELECT id FROM kanban_cards WHERE id = 'card-a'")).toEqual([{ id: 'card-a' }])
    expect((await listCostBudgets('default')).map((b) => b.id)).toEqual(['budget-new'])
    expect(readTerminalInputEnabledRaw()).toBe(true)
    expectCachesMatchTables()
    // the vault step and .env never ran
    expect(readFileSync(join(STORE, '.vault-key'), 'utf-8')).toBe(OLD.vaultKey)
    expect(await listVaultBindings('default')).toEqual([])
    expect(updateEnvFile).not.toHaveBeenCalled()
    // the staged files are gone, and so is the backup of the restored file: a restored file leaves nothing behind
    expect(strays()).toEqual([])
    // a file that was new is not left behind either
    expect(existsSync(join(TASKS, 'task-a'))).toBe(false)
  })

  it('a cleanly restored failure does not block the next import', async () => {
    probe.failRenameTo = join(PROJECT, 'SOUL.md')
    await expect(apply(bundle())).rejects.toThrow(/committed and stay in place/)
    expect(strays()).toEqual([])
    probe.failRenameTo = null

    await apply(bundle())

    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('new claude\n')
    expect(readFileSync(join(PROJECT, 'SOUL.md'), 'utf-8')).toBe('new soul\n')
    expect(strays()).toEqual([])
  })

  it('a restore that copies back different content counts as not restored, and its backup stays', async () => {
    probe.failRenameTo = join(PROJECT, 'SOUL.md')
    probe.corruptCopyTo = join(PROJECT, 'CLAUDE.md')

    const error = await apply(bundle()).then(() => undefined, (e: unknown) => e as Error)

    expect(error!.message).toMatch(/could not be restored, take them from their \.import-bak backups: .*CLAUDE\.md/)
    expect(readFileSync(join(PROJECT, 'CLAUDE.md.import-bak'), 'utf-8')).toBe(OLD.claude)
    expect(strays()).toEqual(['project/CLAUDE.md.import-bak'])
  })

  it('a failure in the vault step restores every file renamed before it, the vault files included', async () => {
    probe.failRenameTo = join(STORE, 'vault.json') // .vault-key is renamed first, vault.json second
    mkdirSync(join(PROJECT, '.claude')) // settings.json is a NEW file in a directory that already exists

    await expect(apply(bundle())).rejects.toThrow(/committed and stay in place/)

    expect(existsSync(join(PROJECT, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(PROJECT, '.claude'))).toBe(true)

    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe(OLD.claude)
    expect(readFileSync(join(AGENTS, 'agent-b', 'CLAUDE.md'), 'utf-8')).toBe(OLD.agentClaude)
    expect(readFileSync(join(STORE, '.vault-key'), 'utf-8')).toBe(OLD.vaultKey)
    expect(readFileSync(join(STORE, 'vault.json'), 'utf-8')).toBe(OLD.vaultJson)
    expect(updateEnvFile).not.toHaveBeenCalled()
    expect(strays().filter((p) => p.endsWith('.import-new'))).toEqual([])
  })

  it('a failure of the .env mirror restores the files too', async () => {
    vi.mocked(updateEnvFile).mockImplementation(() => { throw new Error('env refused') })

    await expect(apply(bundle())).rejects.toThrow(/env refused/)

    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe(OLD.claude)
    expect(readFileSync(join(STORE, '.vault-key'), 'utf-8')).toBe(OLD.vaultKey)
    expect(readFileSync(join(STORE, 'vault.json'), 'utf-8')).toBe(OLD.vaultJson)
    expect(readFileSync(join(HOME, '.claude', 'skills', 'skill-g', 'SKILL.md'), 'utf-8')).toBe(OLD.skill)
    expect(strays().filter((p) => p.endsWith('.import-new'))).toEqual([])
  })

  it('reports a file that could not be restored, with the backup to take it from', async () => {
    // The restore of CLAUDE.md copies its backup back: make that copy impossible by turning the final path into a
    // directory, at the last step (the .env mirror), when CLAUDE.md has already been renamed.
    vi.mocked(updateEnvFile).mockImplementation(() => {
      rmSync(join(PROJECT, 'CLAUDE.md'))
      mkdirSync(join(PROJECT, 'CLAUDE.md'))
      throw new Error('env refused')
    })

    const error = await apply(bundle()).then(() => undefined, (e: unknown) => e as Error)

    expect(error!.message).toMatch(/could not be restored, take them from their \.import-bak backups: .*CLAUDE\.md/)
    expect(readFileSync(join(PROJECT, 'CLAUDE.md.import-bak'), 'utf-8')).toBe(OLD.claude)
    // only the backup of the file that is not back stays: the other renamed files were restored and left nothing
    expect(strays()).toEqual(['project/CLAUDE.md.import-bak'])
    expect(readFileSync(join(STORE, '.vault-key'), 'utf-8')).toBe(OLD.vaultKey)
  })

  it('the next import is refused for the file whose backup stayed, and goes through once the operator removes it', async () => {
    vi.mocked(updateEnvFile).mockImplementationOnce(() => {
      rmSync(join(PROJECT, 'CLAUDE.md'))
      mkdirSync(join(PROJECT, 'CLAUDE.md'))
      throw new Error('env refused')
    })
    await expect(apply(bundle())).rejects.toThrow(/could not be restored/)
    rmSync(join(PROJECT, 'CLAUDE.md'), { recursive: true }) // the operator clears the directory in the way

    const refusal = await apply(bundle()).then(() => undefined, (e: unknown) => e as Error)

    expect(refusal).toBeInstanceOf(StaleBackupError)
    expect(refusal!.message).toContain(join(PROJECT, 'CLAUDE.md.import-bak'))
    expect(readFileSync(join(PROJECT, 'CLAUDE.md.import-bak'), 'utf-8')).toBe(OLD.claude)

    copyFileSync(join(PROJECT, 'CLAUDE.md.import-bak'), join(PROJECT, 'CLAUDE.md'))
    rmSync(join(PROJECT, 'CLAUDE.md.import-bak'))
    await apply(bundle())

    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('new claude\n')
    expect(strays()).toEqual([])
  })
})

describe('a backup left by an earlier import', () => {
  const PRECIOUS = 'PRECIOUS previous content that only this backup holds\n'

  async function refused(stale: string): Promise<void> {
    mkdirSync(join(stale, '..'), { recursive: true })
    writeFileSync(stale, PRECIOUS)
    const before = await snapshotProbes()
    const filesBefore = tree()

    const error = await apply(bundle()).then(() => undefined, (e: unknown) => e as Error)

    expect(error).toBeInstanceOf(StaleBackupError)
    expect(error!.message).toContain(stale)
    expect(error!.message).toMatch(/restore it onto .* or remove it/i)
    expect(readFileSync(stale, 'utf-8')).toBe(PRECIOUS)
    // nothing else changed: no other file, no staged file or backup of this import, no directory, no row, no cache
    expect(tree()).toEqual(filesBefore)
    expect(await snapshotProbes()).toEqual(before)
    expect(probe.events).toEqual([])
    expect(updateEnvFile).not.toHaveBeenCalled()
    expectCachesMatchTables()
  }

  it('refuses the import and keeps the backup, for a file that exists', async () => {
    await refused(join(PROJECT, 'CLAUDE.md.import-bak'))
  })

  it('refuses the import for a file that does not exist yet, after earlier files were staged', async () => {
    // staged late: the skill file comes after CLAUDE.md, SOUL.md, .mcp.json and the agent files
    await refused(join(HOME, '.claude', 'skills', 'skill-g', 'SKILL.md.import-bak'))
  })

  it('the import goes through once the backup is gone', async () => {
    const stale = join(PROJECT, 'CLAUDE.md.import-bak')
    writeFileSync(stale, PRECIOUS)
    await expect(apply(bundle())).rejects.toBeInstanceOf(StaleBackupError)

    rmSync(stale)
    await apply(bundle())

    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('new claude\n')
    expect(strays()).toEqual([])
  })
})

describe('two imports applied at once', () => {
  const withClaude = (text: string): FleetJson => {
    const b = bundle()
    ;(b.mainAgent as { claudeMd?: string }).claudeMd = text
    return b
  }

  it('a second apply while one runs is refused at once: one import, one ImportInProgressError, the files of the first bundle', async () => {
    const out = await Promise.allSettled([apply(withClaude('claude ONE\n')), apply(withClaude('claude TWO\n'))])

    expect(out[0]!.status).toBe('fulfilled')
    expect(out[1]!.status).toBe('rejected')
    expect((out[1] as PromiseRejectedResult).reason).toBeInstanceOf(ImportInProgressError)
    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('claude ONE\n')
    expect(probe.events.filter((e) => e === 'begin' || e === 'commit')).toEqual(['begin', 'commit'])
    expect(strays()).toEqual([])
    expectCachesMatchTables()
  })

  it('the same import twice (a double click): one succeeds, the other is refused, nothing is left behind', async () => {
    const out = await Promise.allSettled([apply(bundle()), apply(bundle())])

    expect(out.map((o) => o.status)).toEqual(['fulfilled', 'rejected'])
    // the reason matters: without the lock the second call also rejects, with a rename error after its commit
    expect((out[1] as PromiseRejectedResult).reason).toBeInstanceOf(ImportInProgressError)
    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('new claude\n')
    expect(strays()).toEqual([])
  })

  it('the refused apply touches nothing: no staged file, no backup, no row of its own', async () => {
    const running = apply(withClaude('claude ONE\n'))
    const refused = apply(withClaude('claude TWO\n')).then(() => undefined, (e: unknown) => e)
    expect(await refused).toBeInstanceOf(ImportInProgressError)
    await running

    expect(probe.events.filter((e) => e === 'begin')).toHaveLength(1)
    expect(probe.events.filter((e) => e === 'env')).toHaveLength(1)
    expect(strays()).toEqual([])
  })

  it('the next apply runs after a finished one and after a failed one', async () => {
    await apply(withClaude('claude ONE\n'))
    await expect(apply(bundle({ comments: [BROKEN_COMMENT] }))).rejects.toThrow()
    await apply(withClaude('claude THREE\n'))

    expect(readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8')).toBe('claude THREE\n')
    expect(strays()).toEqual([])
  })

  it('a dry run is not refused while an apply runs', async () => {
    const applying = apply(bundle())
    const dry = await importFleet(JSON.stringify(bundle()), { apply: false })

    expect('dryRun' in dry).toBe(true)
    await applying
  })
})

describe('the same path staged twice', () => {
  it('a global skill name that appears twice in the bundle is staged and renamed once', async () => {
    const b = bundle()
    b.skills = [...(b.skills ?? []), ...(b.skills ?? [])]

    await apply(b)

    expect(readFileSync(join(HOME, '.claude', 'skills', 'skill-g', 'SKILL.md'), 'utf-8')).toBe(SKILL_MD)
    expect(strays()).toEqual([])
    expect(probe.events.filter((e) => e === 'final:home/.claude/skills/skill-g/SKILL.md')).toHaveLength(1)
  })

  it('an agent skill name that appears twice in the agent is staged and renamed once', async () => {
    const b = bundle()
    const agent = b.agents![0]!
    agent.agentSkills = [...(agent.agentSkills ?? []), ...(agent.agentSkills ?? [])]

    await apply(b)

    expect(readFileSync(join(AGENTS, 'agent-b', '.claude', 'skills', 'skill-a', 'SKILL.md'), 'utf-8')).toBe(AGENT_SKILL_MD)
    expect(strays()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The leftover scan walks importTargetRoots(). Here the leftovers come from the REAL import (the cleanup is made a
// no-op, as a crash before it would), so a write location of the import that the roots do not reach shows up as a
// stray the scan did not report.
// ---------------------------------------------------------------------------

describe('the leftover scan finds what an interrupted import really left', () => {
  const found = async () => {
    const scan = await scanImportLeftovers()
    return { scan, rel: scan.items.map((i) => relative(ROOT, i.path)).sort() }
  }

  it('reports every backup of a completed import whose cleanup did not run, and deletes none of them', async () => {
    probe.keepLeftovers = true
    await apply(bundle())
    const before = tree()

    const { scan, rel } = await found()

    expect(strays().filter((p) => p.endsWith('.import-bak')).length).toBeGreaterThan(3)
    expect(rel).toEqual(strays().sort())
    expect(scan.items.every((i) => i.kind === 'stale_bak')).toBe(true)
    expect(scan.truncated).toBe(false)
    expect(tree()).toEqual(before)
  })

  it('reports the staged files and backups of an import that failed before its commit', async () => {
    getDb().exec("CREATE TRIGGER refuse_skill_rows BEFORE INSERT ON skills BEGIN SELECT RAISE(ABORT, 'skill row refused'); END")
    probe.keepLeftovers = true
    // channel pairing files stage two levels (main agent) and four levels (sub-agent) below their roots
    const withChannels = bundle() as unknown as { mainAgent: { channelsAccess: object }; agents: { channelsAccess: object }[] }
    withChannels.mainAgent.channelsAccess = { telegram: { allowFrom: [] } }
    withChannels.agents[0].channelsAccess = { telegram: { allowFrom: [] } }
    await expect(apply(withChannels as unknown as FleetJson)).rejects.toThrow(/skill row refused/)
    const before = tree()

    const { scan, rel } = await found()

    expect(strays().filter((p) => p.endsWith('.import-new')).length).toBeGreaterThan(3)
    expect(rel).toEqual(strays().sort())
    // every root the import stages into is reached
    for (const prefix of ['project/', 'home/.claude/channels/telegram/', 'agents/agent-b/.claude/channels/telegram/', 'home/.claude/skills/', 'tasks/', 'store/']) {
      expect(rel.some((p) => p.startsWith(prefix)), prefix).toBe(true)
    }
    expect(new Set(scan.items.map((i) => i.kind))).toEqual(new Set(['orphan_new', 'stale_bak']))
    expect(tree()).toEqual(before)
  })

  it('finds nothing after a clean import, and the next import is refused while a backup is left', async () => {
    await apply(bundle())
    expect((await found()).rel).toEqual([])

    probe.keepLeftovers = true
    await apply(bundle())
    expect((await found()).rel.length).toBeGreaterThan(0)

    const refusal = await apply(bundle()).then(() => undefined, (e: unknown) => e as Error)
    expect(refusal).toBeInstanceOf(StaleBackupError)
    expect(refusal!.message).toContain('/api/fleet/import-leftovers')
  })
})

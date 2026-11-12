// The synchronous caches (system_config, model_profile_map, agent_settings) on a backend other than SQLite: the async
// load through the facade, the owner (the backend epoch on PG, the handle on SQLite), the error of a reader with
// nothing loaded, and the awaited write-through. No server: the other backend is an in-memory fake that answers the
// cache statements. The SQLite behaviour of the caches is pinned by db-config-cache.test.ts and its siblings.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/connection.js'
import { dbxBackendEpoch, dbxDialect, useDbxBackend, type Dbx } from '../db/facade.js'
import { cachedSystemConfig, cachedSystemConfigList, clearSystemConfigCache, loadSystemConfigCacheAsync } from '../db/config-cache.js'
import { cachedModelProfileMapEntry, cachedModelProfileMapList, loadModelProfileMapCacheAsync } from '../db/model-profile-map-cache.js'
import { cachedAgentSetting, cachedAgentSettingsByKey, loadAgentSettingsCacheAsync } from '../db/agent-settings-cache.js'
import { setSystemConfig, deleteSystemConfig } from '../db/system-config.js'
import { setAgentSetting } from '../db/agent-settings.js'
import { setModelProfileMapEntry } from '../db/model-profile-map.js'
import { initDatabase } from '../db.js'
import { resetDbTestState } from './helpers/with-test-db.js'

// not the useTestDb helper: this file needs the SQLite handle AND a second backend side by side, so it sets both up itself
// (and is not a PG-mode candidate for the partition lists)
beforeEach(() => { resetDbTestState(); initDatabase(':memory:') })
afterEach(() => { try { db?.close() } catch { /* closed */ } resetDbTestState() })

type Row = Record<string, unknown>
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A backend whose tables hold rows the test put there; `delayMs` slows the reads (a switch can happen meanwhile). */
function fake(tables: Record<string, Row[]>, delayMs = 0): { backend: Dbx; runs: string[] } {
  const runs: string[] = []
  const table = (sql: string): Row[] => tables[/FROM (\w+)/.exec(sql)![1]!] ?? []
  const backend: Dbx = {
    all: (async (sql: string) => { await sleep(delayMs); return table(sql).map((r) => ({ ...r })) }) as Dbx['all'],
    get: (async (sql: string, ...p: unknown[]) => {
      await sleep(delayMs)
      const row = table(sql).find((r) => {
        if (sql.includes('agent_settings')) return r.agent_id === p[0] && r.setting_key === p[1]
        return (r.key ?? r.profile_id) === p[0]
      })
      return row ? { ...row } : undefined
    }) as Dbx['get'],
    run: (sql: string) => { runs.push(sql); return Promise.resolve({ changes: 1, lastInsertRowid: 0 }) },
    exec: () => Promise.resolve(),
    tx: ((fn: (tx: Dbx) => Promise<unknown>) => fn(backend)) as Dbx['tx'],
  }
  return { backend, runs }
}

const CFG = { key: 'k1', value: 'v1', updated_at: 1, source: 'db' }
const MPM = { profile_id: 'p1', model_id: 'm1', updated_at: 1, updated_by: 'agent-a' }
const AS = { agent_id: 'agent-a', setting_key: 'context_guard', setting_value: '{"on":true}', tenant_id: 'default', updated_at: 1 }
const tablesOf = (): Record<string, Row[]> => ({ system_config: [CFG], model_profile_map: [MPM], agent_settings: [AS] })
async function loadAll(): Promise<void> {
  await loadSystemConfigCacheAsync()
  await loadModelProfileMapCacheAsync()
  await loadAgentSettingsCacheAsync()
}
const readers: Array<[string, () => unknown]> = [
  ['cachedSystemConfig', () => cachedSystemConfig('k1')],
  ['cachedSystemConfigList', () => cachedSystemConfigList()],
  ['cachedModelProfileMapEntry', () => cachedModelProfileMapEntry('p1')],
  ['cachedModelProfileMapList', () => cachedModelProfileMapList()],
  ['cachedAgentSetting', () => cachedAgentSetting('agent-a', 'context_guard' as never)],
  ['cachedAgentSettingsByKey', () => cachedAgentSettingsByKey('context_guard' as never)],
]

describe('the backend epoch', () => {
  it('grows with every useDbxBackend call, also the one that goes back to SQLite', () => {
    const a = dbxBackendEpoch()
    useDbxBackend(fake({}).backend)
    useDbxBackend(fake({}).backend)
    useDbxBackend(null)
    expect(dbxBackendEpoch()).toBe(a + 3)
  })
})

describe('a reader with nothing loaded', () => {
  it('on the PG backend throws the error that names the loader, not a TypeError on the missing handle', () => {
    useDbxBackend(fake({}).backend)
    for (const [, read] of readers) expect(read).toThrow(/cache not loaded in PG mode: call load\w+CacheAsync\(\)/)
  })

  it('on SQLite it still answers null (the table is read), as before', () => {
    clearSystemConfigCache()
    expect(dbxDialect()).toBe('sqlite')
    expect(cachedSystemConfig('k1')).toBeNull()
  })
})

describe('the async load through the facade', () => {
  it('fills the three caches from the backend, and the readers answer copies of the rows', async () => {
    useDbxBackend(fake(tablesOf()).backend)
    await loadAll()
    expect(cachedSystemConfig('k1')).toEqual(CFG)
    expect(cachedSystemConfig('nope')).toBeUndefined()
    expect(cachedSystemConfigList()).toEqual([CFG])
    expect(cachedModelProfileMapEntry('p1')).toEqual(MPM)
    expect(cachedModelProfileMapList()).toEqual([MPM])
    expect(cachedAgentSetting('agent-a', 'context_guard' as never)).toEqual(AS)
    expect(cachedAgentSettingsByKey('context_guard' as never)).toEqual({ 'agent-a': { on: true } })
    const row = cachedSystemConfig('k1') as unknown as Row
    row.value = 'changed'
    expect(cachedSystemConfig('k1')?.value).toBe('v1')
  })

  it('the cache belongs to the epoch it was loaded under: a switch to another backend makes it unreadable', async () => {
    useDbxBackend(fake(tablesOf()).backend)
    await loadAll()
    useDbxBackend(fake(tablesOf()).backend) // the next test's database
    for (const [, read] of readers) expect(read).toThrow(/cache not loaded in PG mode/)
    await loadAll()
    expect(cachedSystemConfig('k1')).toEqual(CFG)
  })

  it('rows that arrive after the backend was switched belong to nobody and are dropped', async () => {
    useDbxBackend(fake(tablesOf(), 40).backend)
    const loading = loadSystemConfigCacheAsync()
    await sleep(10)
    useDbxBackend(fake(tablesOf()).backend)
    await loading
    expect(() => cachedSystemConfig('k1')).toThrow(/cache not loaded in PG mode/)
  })

  it('a slow load that finishes AFTER a newer load of the next backend does not take the cache away from it (each of the three)', async () => {
    const cases: Array<[() => Promise<void>, () => unknown, unknown, Record<string, Row[]>]> = [
      [loadSystemConfigCacheAsync, () => cachedSystemConfig('k1')?.value, 'v1', { system_config: [{ ...CFG, value: 'old-backend' }] }],
      [loadModelProfileMapCacheAsync, () => cachedModelProfileMapEntry('p1')?.model_id, 'm1', { model_profile_map: [{ ...MPM, model_id: 'old-backend' }] }],
      [loadAgentSettingsCacheAsync, () => cachedAgentSetting('agent-a', 'context_guard' as never)?.tenant_id, 'default', { agent_settings: [{ ...AS, tenant_id: 'old-backend' }] }],
    ]
    for (const [load, read, expected, oldTables] of cases) {
      useDbxBackend(fake(oldTables, 60).backend)
      const slow = load()
      await sleep(10)
      useDbxBackend(fake(tablesOf()).backend)
      await load() // the newer load finishes first
      await slow // the older one finishes last and must be dropped
      expect(read()).toBe(expected)
    }
  })

  it('on SQLite the async load fills the cache for the handle, from the table', async () => {
    db.prepare("INSERT INTO system_config (key, value, source) VALUES ('async-k', 'async-v', 'db')").run()
    await loadSystemConfigCacheAsync()
    expect(cachedSystemConfig('async-k')?.value).toBe('async-v')
    expect(dbxBackendEpoch()).toBeGreaterThan(0)
  })
})

describe('the write-through read-back on PG is awaited', () => {
  it('system_config: set then delete, the cache follows what the backend holds', async () => {
    const tables = tablesOf()
    const { backend, runs } = fake(tables)
    useDbxBackend(backend)
    await loadAll()
    tables.system_config!.push({ key: 'k2', value: 'v2', updated_at: 2, source: 'db' })
    await setSystemConfig('k2', 'v2')
    expect(runs.length).toBe(1)
    expect(cachedSystemConfig('k2')).toMatchObject({ value: 'v2' }) // read back through dbx.get, SQLite holds no such row
    tables.system_config = tables.system_config!.filter((r) => r.key !== 'k2')
    await deleteSystemConfig('k2')
    expect(cachedSystemConfig('k2')).toBeUndefined()
  })

  it('agent_settings and model_profile_map: the same', async () => {
    const tables = tablesOf()
    useDbxBackend(fake(tables).backend)
    await loadAll()
    tables.agent_settings = [{ ...AS, setting_value: '{"on":false}' }]
    await setAgentSetting('agent-a', 'context_guard' as never, { on: false })
    expect(cachedAgentSettingsByKey('context_guard' as never)).toEqual({ 'agent-a': { on: false } })
    tables.model_profile_map = [{ ...MPM, model_id: 'm2' }]
    await setModelProfileMapEntry('p1', 'm2', 'agent-a')
    expect(cachedModelProfileMapEntry('p1')?.model_id).toBe('m2')
  })

  it('a write with nothing loaded for the backend skips the cache and throws nothing', async () => {
    useDbxBackend(fake(tablesOf()).backend)
    await setSystemConfig('k3', 'v3')
    expect(() => cachedSystemConfig('k3')).toThrow(/cache not loaded in PG mode/)
  })

  it('a backend switch while the read-back runs: the stale row is not put in the new epoch cache', async () => {
    const tables = tablesOf()
    useDbxBackend(fake(tables, 40).backend)
    await loadAll()
    const writing = setSystemConfig('k1', 'late')
    await sleep(10)
    useDbxBackend(fake({ system_config: [CFG] }).backend)
    await loadSystemConfigCacheAsync()
    await writing
    expect(cachedSystemConfig('k1')).toEqual(CFG)
  })
})

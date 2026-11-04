// The synchronous write-through cache of agent_settings (migration 0058, #985 group 3/8), mirroring
// db-model-profile-map-cache.test.ts: reads come from memory (no statement is prepared), an (async)
// write is visible at once, a re-initialisation is picked up, and a direct table write is picked up
// only after an explicit reload. Also covers importAgentSettingsFromFile, the boot-sync twin
// (db/index.ts's migrator) -- same per-test STORE_DIR isolation as db-cost-budgets.test.ts, since that
// function reads the JSON side-cars from STORE_DIR.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-agent-settings-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

const dbRow = (agentId: string, key: string) =>
  dbMod.db.prepare('SELECT agent_id, setting_key, setting_value, tenant_id, updated_at FROM agent_settings WHERE agent_id = ? AND setting_key = ?').get(agentId, key)

describe('reads come from the cache', () => {
  it('getAgentSetting and listAgentSettingsByKey prepare no statement', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    const prepare = vi.spyOn(dbMod.db, 'prepare')
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: true }))
    expect(dbMod.getAgentSetting('agent-a', 'context_guard')).toBeUndefined()
    expect(dbMod.listAgentSettingsByKey('auto_restart')).toEqual({ 'agent-a': { enabled: true } })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('a returned row is a copy: changing it does not change the cache', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    const row = dbMod.getAgentSetting('agent-a', 'auto_restart')!
    row.setting_value = 'tampered'
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).not.toBe('tampered')
  })

  it('keys by (agent_id, setting_key): the same agent under two different keys does not collide', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    await dbMod.setAgentSetting('agent-a', 'context_guard', { enabled: false })
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: true }))
    expect(dbMod.getAgentSetting('agent-a', 'context_guard')?.setting_value).toBe(JSON.stringify({ enabled: false }))
  })
})

describe('write-through', () => {
  it('a write is visible at once, and is in the database with the same row', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true }, 'eszter')
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')).toEqual(dbRow('agent-a', 'auto_restart'))
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: false }, 'eszter')
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: false }))
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')).toEqual(dbRow('agent-a', 'auto_restart'))
  })

  it('listAgentSettingsByKey reflects a write at once too', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    await dbMod.setAgentSetting('agent-b', 'auto_restart', { enabled: false })
    expect(dbMod.listAgentSettingsByKey('auto_restart')).toEqual({ 'agent-a': { enabled: true }, 'agent-b': { enabled: false } })
  })
})

describe('initDatabase and the connection', () => {
  it('initDatabase again gives a fresh, empty cache for the fresh database', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    dbMod.initDatabase(':memory:')
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')).toBeUndefined()
    expect(dbMod.listAgentSettingsByKey('auto_restart')).toEqual({})
  })

  it('a row written straight into the table is seen after reloadAgentSettingsCache()', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    dbMod.db.exec(`UPDATE agent_settings SET setting_value = '{"enabled":false}' WHERE agent_id = 'agent-a' AND setting_key = 'auto_restart'`)
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: true })) // stale on purpose
    dbMod.reloadAgentSettingsCache()
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe('{"enabled":false}')
  })

  it('without a loaded cache the reads go to the table, as before', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    dbMod.db.exec(`UPDATE agent_settings SET setting_value = '{"enabled":false}' WHERE agent_id = 'agent-a' AND setting_key = 'auto_restart'`)
    dbMod.clearAgentSettingsCache()
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe('{"enabled":false}')
    expect(dbMod.listAgentSettingsByKey('auto_restart')).toEqual({ 'agent-a': { enabled: false } })
  })

  it('a cache loaded for a closed connection is never served: the table of the new handle is read', async () => {
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: true })
    const { initDatabase: connectionInitDatabase } = await import('../db/connection.js')
    connectionInitDatabase(':memory:')
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')).toBeUndefined()
  })
})

describe('importAgentSettingsFromFile (boot-sync twin)', () => {
  it('returns 0 for an empty entries object', () => {
    expect(dbMod.importAgentSettingsFromFile('auto_restart', {}, () => 'default')).toBe(0)
  })

  it('imports every entry, stamping the resolved tenant', () => {
    const migrated = dbMod.importAgentSettingsFromFile(
      'auto_restart',
      { 'agent-a': { enabled: true }, 'agent-b': { enabled: false } },
      (id) => (id === 'agent-a' ? 'eszter' : 'default'),
    )
    expect(migrated).toBe(2)
    // the real boot order (db/index.ts) loads the cache AFTER the migrators run; calling the
    // migrator directly, bypassing that orchestration, needs the same explicit reload.
    dbMod.reloadAgentSettingsCache()
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.tenant_id).toBe('eszter')
    expect(dbMod.getAgentSetting('agent-b', 'auto_restart')?.tenant_id).toBe('default')
  })

  it('is idempotent: a second run does not overwrite an operator-set row', async () => {
    dbMod.importAgentSettingsFromFile('auto_restart', { 'agent-a': { enabled: true } }, () => 'default')
    dbMod.reloadAgentSettingsCache()
    await dbMod.setAgentSetting('agent-a', 'auto_restart', { enabled: false })
    const secondRun = dbMod.importAgentSettingsFromFile('auto_restart', { 'agent-a': { enabled: true } }, () => 'default')
    expect(secondRun).toBe(0)
    expect(dbMod.getAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: false }))
  })

  it('skips a null/undefined entry, keeps the rest', () => {
    expect(dbMod.importAgentSettingsFromFile('auto_restart', { 'agent-a': null, 'agent-b': { enabled: true } }, () => 'default')).toBe(1)
  })
})

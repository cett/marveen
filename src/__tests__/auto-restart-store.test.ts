// DB-backed since migration 0058 (#985 group 3/8) -- see
// context-guard-store.test.ts's header comment for why the table isn't
// cleared wholesale between tests (real fleet rows may already be imported
// into the shared :memory: DB by initDatabase()'s boot importer).
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  readAutoRestartConfig,
  readAllAutoRestartConfigs,
  writeAutoRestartConfig,
} from '../web/auto-restart-store.js'
import { DEFAULT_AUTO_RESTART } from '../auto-restart.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterEach(() => {
  getDb().exec("DELETE FROM agent_settings WHERE agent_id LIKE 'test-ar-%'")
})

describe('readAutoRestartConfig', () => {
  it('returns disabled defaults when no row exists', () => {
    const cfg = readAutoRestartConfig('test-ar-agent-a')
    expect(cfg).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('returns disabled defaults for an agent with no entry', () => {
    writeAutoRestartConfig('test-ar-other', { enabled: true })
    const cfg = readAutoRestartConfig('test-ar-agent-a')
    expect(cfg).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('returns normalized config after write', () => {
    writeAutoRestartConfig('test-ar-agent-a', { enabled: true, cooldownSeconds: 60 })
    const cfg = readAutoRestartConfig('test-ar-agent-a')
    expect(cfg.enabled).toBe(true)
  })
})

describe('writeAutoRestartConfig', () => {
  it('normalizes and persists a config', () => {
    const saved = writeAutoRestartConfig('test-ar-agent-d', { enabled: true })
    expect(saved.enabled).toBe(true)
    const readBack = readAutoRestartConfig('test-ar-agent-d')
    expect(readBack.enabled).toBe(true)
  })

  it('overwrites an existing entry without affecting others', () => {
    writeAutoRestartConfig('test-ar-agent-a', { enabled: true })
    writeAutoRestartConfig('test-ar-agent-d', { enabled: false })
    writeAutoRestartConfig('test-ar-agent-a', { enabled: false })
    expect(readAutoRestartConfig('test-ar-agent-a').enabled).toBe(false)
    expect(readAutoRestartConfig('test-ar-agent-d').enabled).toBe(false)
  })

  it('survives a row whose setting_value is not valid JSON', () => {
    getDb().prepare(
      `INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id) VALUES (?, 'auto_restart', '{not valid json}', 'default')`,
    ).run('test-ar-agent-a')
    const cfg = readAutoRestartConfig('test-ar-agent-a')
    expect(cfg).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('stamps the given tenant_id on the row', () => {
    writeAutoRestartConfig('test-ar-agent-t', { enabled: true }, 'eszter')
    const row = getDb().prepare(
      `SELECT tenant_id FROM agent_settings WHERE agent_id = ? AND setting_key = 'auto_restart'`,
    ).get('test-ar-agent-t') as { tenant_id: string }
    expect(row.tenant_id).toBe('eszter')
  })
})

describe('readAllAutoRestartConfigs', () => {
  it('returns every persisted agent normalized', () => {
    writeAutoRestartConfig('test-ar-agent-a', { enabled: true })
    writeAutoRestartConfig('test-ar-agent-d', { enabled: false })
    const all = readAllAutoRestartConfigs()
    expect(all['test-ar-agent-a']!.enabled).toBe(true)
    expect(all['test-ar-agent-d']!.enabled).toBe(false)
  })
})

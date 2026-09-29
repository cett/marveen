// DB-backed since migration 0058 (#985 group 3/8) -- real in-memory DB,
// mirrors the initDatabase(':memory:') pattern used by
// db-tasks-schedule-crud.test.ts for other migrated stores. Test agent ids
// are 'test-cg-*' prefixed and cleaned up per-test because initDatabase()
// also runs the real migrateAgentSettingsFromFiles() importer against this
// worktree's actual store/context-guard.json (same as every other DB-store
// test in this suite) -- a shared :memory: DB can carry real fleet rows
// alongside the test's own.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  readContextGuardConfig,
  readAllContextGuardConfigs,
  writeContextGuardConfig,
} from '../web/context-guard-store.js'
import { DEFAULT_CONTEXT_GUARD } from '../context-guard.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterEach(() => {
  getDb().exec("DELETE FROM agent_settings WHERE agent_id LIKE 'test-cg-%'")
})

describe('readContextGuardConfig', () => {
  it('returns disabled defaults when no row exists', () => {
    expect(readContextGuardConfig('test-cg-agent-a')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('returns disabled defaults for an agent with no entry', () => {
    writeContextGuardConfig('test-cg-other', { enabled: true })
    expect(readContextGuardConfig('test-cg-agent-a')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('returns the stored value after a write', () => {
    writeContextGuardConfig('test-cg-agent-a', { enabled: true })
    expect(readContextGuardConfig('test-cg-agent-a').enabled).toBe(true)
  })
})

describe('writeContextGuardConfig', () => {
  it('normalizes and persists a config', () => {
    const saved = writeContextGuardConfig('test-cg-agent-d', { enabled: true })
    expect(saved.enabled).toBe(true)
    expect(readContextGuardConfig('test-cg-agent-d').enabled).toBe(true)
  })

  it('overwrites an existing entry without affecting others', () => {
    writeContextGuardConfig('test-cg-agent-a', { enabled: true })
    writeContextGuardConfig('test-cg-agent-d', { enabled: false })
    writeContextGuardConfig('test-cg-agent-a', { enabled: false })
    expect(readContextGuardConfig('test-cg-agent-a').enabled).toBe(false)
    expect(readContextGuardConfig('test-cg-agent-d').enabled).toBe(false)
  })

  it('survives a row whose setting_value is not valid JSON', () => {
    getDb().prepare(
      `INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id) VALUES (?, 'context_guard', 'INVALID', 'default')`,
    ).run('test-cg-agent-a')
    expect(readContextGuardConfig('test-cg-agent-a')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('stamps the given tenant_id on the row', () => {
    writeContextGuardConfig('test-cg-agent-t', { enabled: true }, 'eszter')
    const row = getDb().prepare(
      `SELECT tenant_id FROM agent_settings WHERE agent_id = ? AND setting_key = 'context_guard'`,
    ).get('test-cg-agent-t') as { tenant_id: string }
    expect(row.tenant_id).toBe('eszter')
  })
})

describe('readAllContextGuardConfigs', () => {
  it('returns every persisted agent, normalized', () => {
    writeContextGuardConfig('test-cg-agent-a', { enabled: true })
    writeContextGuardConfig('test-cg-agent-d', { enabled: false })
    const all = readAllContextGuardConfigs()
    expect(all['test-cg-agent-a']?.enabled).toBe(true)
    expect(all['test-cg-agent-d']?.enabled).toBe(false)
  })
})

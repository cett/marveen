import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// DB-fixture pattern (#985 group 5/8): agent-desired-state.ts now reads/writes
// the single system_config row 'agents_desired' (a JSON array) instead of
// store/agents-desired.json -- see db-system-config.test.ts for why each test
// needs its own module instance (config.js/db/connection.js resolve STORE_DIR
// once, at import time).
let storeDir: string
let dbMod: typeof import('../db.js')
let store: typeof import('../web/agent-desired-state.js')

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'desired-state-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  store = await import('../web/agent-desired-state.js')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('getDesiredAgents', () => {
  it('returns empty Set when no row exists', () => {
    expect(store.getDesiredAgents().size).toBe(0)
  })

  it('returns empty Set when the stored row is invalid JSON', () => {
    dbMod.setSystemConfig('agents_desired', '{bad}')
    expect(store.getDesiredAgents().size).toBe(0)
  })

  it('returns empty Set when the stored row is non-array JSON', () => {
    dbMod.setSystemConfig('agents_desired', '{"key":"val"}')
    expect(store.getDesiredAgents().size).toBe(0)
  })
})

describe('addDesiredAgent', () => {
  it('creates the row and adds the agent', () => {
    store.addDesiredAgent('agent-a')
    const set = store.getDesiredAgents()
    expect(set.has('agent-a')).toBe(true)
  })

  it('is idempotent -- adding twice does not duplicate', () => {
    store.addDesiredAgent('agent-a')
    store.addDesiredAgent('agent-a')
    expect(store.getDesiredAgents().size).toBe(1)
  })

  it('accumulates multiple agents', () => {
    store.addDesiredAgent('agent-a')
    store.addDesiredAgent('agent-d')
    const set = store.getDesiredAgents()
    expect(set.has('agent-a')).toBe(true)
    expect(set.has('agent-d')).toBe(true)
  })
})

describe('removeDesiredAgent', () => {
  it('removes an existing agent', () => {
    store.addDesiredAgent('agent-a')
    store.removeDesiredAgent('agent-a')
    expect(store.getDesiredAgents().has('agent-a')).toBe(false)
  })

  it('is idempotent -- removing a non-present agent does not throw', () => {
    expect(() => store.removeDesiredAgent('nonexistent')).not.toThrow()
  })

  it('does not remove other agents', () => {
    store.addDesiredAgent('agent-a')
    store.addDesiredAgent('agent-d')
    store.removeDesiredAgent('agent-a')
    const set = store.getDesiredAgents()
    expect(set.has('agent-a')).toBe(false)
    expect(set.has('agent-d')).toBe(true)
  })
})

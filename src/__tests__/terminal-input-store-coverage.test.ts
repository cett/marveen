import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// DB-fixture pattern (#985 group 5/8): terminal-input-store.ts now reads/writes
// the system_config row 'terminal_input_enabled' instead of
// store/terminal-input.json -- see db-system-config.test.ts for why each test
// needs its own module instance (config.js/db/connection.js resolve STORE_DIR
// once, at import time).
let storeDir: string
let dbMod: typeof import('../db.js')
let store: typeof import('../web/terminal-input-store.js')

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'terminal-store-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  store = await import('../web/terminal-input-store.js')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('terminal-input-store', () => {
  it('readTerminalInputEnabled returns false when no row exists (safe OFF default)', () => {
    expect(store.readTerminalInputEnabled()).toBe(false)
  })

  it('readTerminalInputEnabled returns true when the row value is 1', () => {
    dbMod.setSystemConfig('terminal_input_enabled', '1')
    expect(store.readTerminalInputEnabled()).toBe(true)
  })

  it('readTerminalInputEnabled returns false when the row value is 0', () => {
    dbMod.setSystemConfig('terminal_input_enabled', '0')
    expect(store.readTerminalInputEnabled()).toBe(false)
  })

  it('readTerminalInputEnabled returns false for a malformed stored value (fail-closed)', () => {
    dbMod.setSystemConfig('terminal_input_enabled', 'not-a-flag')
    expect(store.readTerminalInputEnabled()).toBe(false)
  })

  it('writeTerminalInputEnabled sets enabled:true and returns true', () => {
    const result = store.writeTerminalInputEnabled(true)
    expect(result).toBe(true)
  })

  it('writeTerminalInputEnabled sets enabled:false and returns false', () => {
    const result = store.writeTerminalInputEnabled(false)
    expect(result).toBe(false)
  })

  it('writeTerminalInputEnabled persists state readable by readTerminalInputEnabled', () => {
    store.writeTerminalInputEnabled(true)
    expect(store.readTerminalInputEnabled()).toBe(true)
  })
})

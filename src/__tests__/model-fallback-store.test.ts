import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_MODEL_FALLBACK, DEFAULT_MODEL_CHAIN } from '../model-fallback.js'

// DB-fixture pattern (#985 group 5/8): model-fallback-store.ts now reads/writes
// system_config rows instead of store/model-fallback.json, so each test gets
// its own in-memory DB via a fresh module instance -- see db-system-config.test.ts
// for why STORE_DIR isolation alone isn't enough (config.js/db/connection.js
// are resolved once at import time).
let storeDir: string
let dbMod: typeof import('../db.js')
let configMod: typeof import('../config.js')
let store: typeof import('../web/model-fallback-store.js')

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'model-fallback-store-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  configMod = await import('../config.js')
  store = await import('../web/model-fallback-store.js')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('defaultChainForInstall', () => {
  it('puts the install default model first, de-duplicated against the distribution chain', () => {
    const chain = store.defaultChainForInstall()
    expect(chain[0]).toBe(configMod.DEFAULT_AGENT_MODEL)
    expect(chain.filter((m) => m === configMod.DEFAULT_AGENT_MODEL)).toHaveLength(1)
  })
})

describe('readModelFallbackConfig', () => {
  it('returns disabled defaults with the install chain when no system_config rows exist', () => {
    const cfg = store.readModelFallbackConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.chain).toEqual(store.defaultChainForInstall())
    expect(cfg.revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })

  it('substitutes the install chain when the stored config has no explicit chain', () => {
    dbMod.setSystemConfig('model_fallback_enabled', '1')
    const cfg = store.readModelFallbackConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.chain).toEqual(store.defaultChainForInstall())
  })

  it('keeps an operator-configured chain untouched', () => {
    const custom = ['modelA', 'modelB', 'modelC']
    dbMod.setSystemConfig('model_fallback_enabled', '1')
    dbMod.setSystemConfig('model_fallback_chain', JSON.stringify(custom))
    const cfg = store.readModelFallbackConfig()
    expect(cfg.chain).toEqual(custom)
  })

  it('treats a single-entry stored chain as not explicit (falls back to install chain)', () => {
    dbMod.setSystemConfig('model_fallback_chain', JSON.stringify(['only-one']))
    const cfg = store.readModelFallbackConfig()
    expect(cfg.chain).toEqual(store.defaultChainForInstall())
  })

  it('survives a corrupted stored chain value', () => {
    dbMod.setSystemConfig('model_fallback_chain', 'not json')
    const cfg = store.readModelFallbackConfig()
    expect(cfg.chain).toEqual(store.defaultChainForInstall())
  })
})

describe('writeModelFallbackConfig', () => {
  it('merges onto the current config and persists', () => {
    const saved = store.writeModelFallbackConfig({ enabled: true, revertAfterMinutes: 45 })
    expect(saved.enabled).toBe(true)
    expect(saved.revertAfterMinutes).toBe(45)
    const readBack = store.readModelFallbackConfig()
    expect(readBack.enabled).toBe(true)
    expect(readBack.revertAfterMinutes).toBe(45)
  })

  it('is a partial merge: writing one field leaves the others as previously stored', () => {
    store.writeModelFallbackConfig({ enabled: true, chain: [...DEFAULT_MODEL_CHAIN] })
    store.writeModelFallbackConfig({ revertAfterMinutes: 90 })
    const cfg = store.readModelFallbackConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.revertAfterMinutes).toBe(90)
  })

  it('an enabled-only write does NOT bake the computed install chain into system_config -- the chain row stays absent', () => {
    // Fresh DB: readModelFallbackConfig() would compute defaultChainForInstall()
    // for `current` since nothing is stored yet. That computed value must
    // never be persisted just because it happened to be merged in-memory.
    store.writeModelFallbackConfig({ enabled: true })
    const row = dbMod.getSystemConfig('model_fallback_chain')
    expect(row).toBeUndefined()
    // readModelFallbackConfig() still returns a usable chain (computed on
    // the fly each time) -- the API contract for GET/the PUT response is
    // unaffected, only the underlying system_config row is.
    expect(store.readModelFallbackConfig().chain).toEqual(store.defaultChainForInstall())
  })

  it('an enabled-only write does not touch a PREVIOUSLY explicit chain either', () => {
    const custom = ['modelA', 'modelB']
    store.writeModelFallbackConfig({ chain: custom })
    store.writeModelFallbackConfig({ enabled: true })
    expect(store.readModelFallbackConfig().chain).toEqual(custom)
  })

  it('a revertAfterMinutes-only write does not create the enabled or chain rows', () => {
    store.writeModelFallbackConfig({ revertAfterMinutes: 30 })
    expect(dbMod.getSystemConfig('model_fallback_enabled')).toBeUndefined()
    expect(dbMod.getSystemConfig('model_fallback_chain')).toBeUndefined()
  })

  it('a full write (all three fields) still persists all three -- the UI, which always sends the full object, keeps working exactly as before', () => {
    store.writeModelFallbackConfig({ enabled: true, chain: [...DEFAULT_MODEL_CHAIN], revertAfterMinutes: 60 })
    expect(dbMod.getSystemConfig('model_fallback_enabled')?.value).toBe('1')
    expect(dbMod.getSystemConfig('model_fallback_chain')).toBeDefined()
    expect(dbMod.getSystemConfig('model_fallback_revert_after_minutes')?.value).toBe('60')
  })

  it('the returned (in-memory) config is still fully merged even when the chain write was skipped', () => {
    const saved = store.writeModelFallbackConfig({ enabled: true })
    expect(saved.chain).toEqual(store.defaultChainForInstall())
    expect(saved.enabled).toBe(true)
  })
})

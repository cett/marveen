import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { unlinkSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR, AGENT_MODEL } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'model-fallback-store-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store'), AGENT_MODEL: 'claude-sonnet-5' }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR, DEFAULT_AGENT_MODEL: AGENT_MODEL }))

import {
  readModelFallbackConfig,
  writeModelFallbackConfig,
  defaultChainForInstall,
} from '../web/model-fallback-store.js'
import { DEFAULT_MODEL_FALLBACK, DEFAULT_MODEL_CHAIN } from '../model-fallback.js'

const STORE_FILE = join(TMP_ROOT, 'store', 'model-fallback.json')

function cleanStore(): void {
  if (existsSync(STORE_FILE)) unlinkSync(STORE_FILE)
}

beforeEach(cleanStore)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('defaultChainForInstall', () => {
  it('puts the install default model first, de-duplicated against the distribution chain', () => {
    const chain = defaultChainForInstall()
    expect(chain[0]).toBe(AGENT_MODEL)
    expect(chain.filter((m) => m === AGENT_MODEL)).toHaveLength(1)
  })
})

describe('readModelFallbackConfig', () => {
  it('returns disabled defaults with the install chain when no file exists', () => {
    const cfg = readModelFallbackConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.chain).toEqual(defaultChainForInstall())
    expect(cfg.revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })

  it('substitutes the install chain when the stored file has no explicit chain', () => {
    require('node:fs').writeFileSync(STORE_FILE, JSON.stringify({ enabled: true }))
    const cfg = readModelFallbackConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('keeps an operator-configured chain untouched', () => {
    const custom = ['modelA', 'modelB', 'modelC']
    require('node:fs').writeFileSync(STORE_FILE, JSON.stringify({ enabled: true, chain: custom }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(custom)
  })

  it('treats a single-entry stored chain as not explicit (falls back to install chain)', () => {
    require('node:fs').writeFileSync(STORE_FILE, JSON.stringify({ chain: ['only-one'] }))
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })

  it('survives corrupted store file', () => {
    require('node:fs').writeFileSync(STORE_FILE, 'not json')
    const cfg = readModelFallbackConfig()
    expect(cfg.chain).toEqual(defaultChainForInstall())
  })
})

describe('writeModelFallbackConfig', () => {
  it('merges onto the current config and persists', () => {
    const saved = writeModelFallbackConfig({ enabled: true, revertAfterMinutes: 45 })
    expect(saved.enabled).toBe(true)
    expect(saved.revertAfterMinutes).toBe(45)
    const readBack = readModelFallbackConfig()
    expect(readBack.enabled).toBe(true)
    expect(readBack.revertAfterMinutes).toBe(45)
  })

  it('is a partial merge: writing one field leaves the others as previously stored', () => {
    writeModelFallbackConfig({ enabled: true, chain: [...DEFAULT_MODEL_CHAIN] })
    writeModelFallbackConfig({ revertAfterMinutes: 90 })
    const cfg = readModelFallbackConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.revertAfterMinutes).toBe(90)
  })
})

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { unlinkSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'openrouter-models-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import {
  loadOpenRouterCatalog,
  fetchAllOpenRouterModels,
  loadCuratedManual,
  addCuratedManual,
  removeCuratedManual,
  resolveOpenRouterModel,
  AUTO_PREFIX,
  OPENROUTER_MODELS_FILE,
  OPENROUTER_MANUAL_FILE,
} from '../web/openrouter-models.js'

function cleanStore(): void {
  if (existsSync(OPENROUTER_MODELS_FILE)) unlinkSync(OPENROUTER_MODELS_FILE)
  if (existsSync(OPENROUTER_MANUAL_FILE)) unlinkSync(OPENROUTER_MANUAL_FILE)
}

beforeEach(cleanStore)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('loadOpenRouterCatalog', () => {
  it('returns the hardcoded default when no file exists', () => {
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBeGreaterThan(0)
    expect(cat.tiers.find((t) => t.key === 'tier1')).toBeTruthy()
  })

  it('returns the stored catalog when the file has tiers', () => {
    const custom = { updated: 'now', tiers: [{ key: 'x', label: 'X', auto: 'model-x', manual: ['model-x'] }] }
    writeFileSync(OPENROUTER_MODELS_FILE, JSON.stringify(custom))
    expect(loadOpenRouterCatalog()).toEqual(custom)
  })

  it('falls back to default when the stored file has no tiers', () => {
    writeFileSync(OPENROUTER_MODELS_FILE, JSON.stringify({ updated: 'now', tiers: [] }))
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.length).toBeGreaterThan(0)
  })

  it('falls back to default on corrupted JSON', () => {
    writeFileSync(OPENROUTER_MODELS_FILE, 'not json')
    const cat = loadOpenRouterCatalog()
    expect(cat.tiers.find((t) => t.key === 'tier1')).toBeTruthy()
  })
})

describe('resolveOpenRouterModel', () => {
  it('returns a non-auto model id unchanged', () => {
    expect(resolveOpenRouterModel('deepseek/deepseek-chat-v3.1')).toBe('deepseek/deepseek-chat-v3.1')
  })

  it('resolves an auto-tier reference to the tier auto model', () => {
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}tier2`)).toBe('qwen/qwen3-coder')
  })

  it('falls back to tier1 auto when the tier key is unknown', () => {
    expect(resolveOpenRouterModel(`${AUTO_PREFIX}does-not-exist`)).toBe('deepseek/deepseek-chat-v3.1')
  })
})

describe('curated manual list', () => {
  it('returns an empty list when no file exists', () => {
    expect(loadCuratedManual()).toEqual([])
  })

  it('adds a model, de-duplicated and sorted by id', () => {
    addCuratedManual('z/model', 'Z Model')
    addCuratedManual('a/model', 'A Model')
    addCuratedManual('z/model', 'Z Model Again')
    const list = loadCuratedManual()
    expect(list.map((m) => m.id)).toEqual(['a/model', 'z/model'])
  })

  it('falls back to the id as the name when name is empty', () => {
    addCuratedManual('bare/model', '')
    expect(loadCuratedManual().find((m) => m.id === 'bare/model')?.name).toBe('bare/model')
  })

  it('removes a model, no-op when absent', () => {
    addCuratedManual('keep/me', 'Keep')
    const after = removeCuratedManual('not/present')
    expect(after.map((m) => m.id)).toContain('keep/me')
    const after2 = removeCuratedManual('keep/me')
    expect(after2.map((m) => m.id)).not.toContain('keep/me')
  })

  it('falls back to an empty list on corrupted manual file', () => {
    writeFileSync(OPENROUTER_MANUAL_FILE, 'not json')
    expect(loadCuratedManual()).toEqual([])
  })
})

describe('fetchAllOpenRouterModels', () => {
  // The module keeps an in-memory cache across calls; reset the module
  // registry per test so each case starts from an empty cache instead of
  // inheriting state (and skipped fetch calls) from a previous test.
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function freshModule() {
    vi.resetModules()
    return import('../web/openrouter-models.js')
  }

  it('maps and sorts the OpenRouter catalog response', async () => {
    const payload = {
      data: [
        { id: 'z/model', name: 'Z', context_length: 8000, pricing: { prompt: '0.000002', completion: '0.000004' } },
        { id: 'a/model', name: 'A', context_length: 4000, pricing: { prompt: '0', completion: '0' } },
      ],
    }
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload }) as unknown as typeof fetch
    const mod = await freshModule()
    const models = await mod.fetchAllOpenRouterModels(1000)
    expect(models.map((m) => m.id)).toEqual(['a/model', 'z/model'])
    expect(models[0]!.free).toBe(true)
    expect(models[1]!.promptPrice).toBeCloseTo(2)
  })

  it('throws on a non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch
    const mod = await freshModule()
    await expect(mod.fetchAllOpenRouterModels(2000)).rejects.toThrow('503')
  })

  it('serves from cache within the TTL without re-fetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const mod = await freshModule()
    await mod.fetchAllOpenRouterModels(10_000)
    await mod.fetchAllOpenRouterModels(10_000 + 1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once the cache expires', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const mod = await freshModule()
    await mod.fetchAllOpenRouterModels(20_000)
    await mod.fetchAllOpenRouterModels(20_000 + 7 * 60 * 60 * 1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips entries without an id', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'no id' }, { id: 'ok/model', name: 'OK' }] }),
    }) as unknown as typeof fetch
    const mod = await freshModule()
    const models = await mod.fetchAllOpenRouterModels(30_000)
    expect(models.map((m) => m.id)).toEqual(['ok/model'])
  })
})

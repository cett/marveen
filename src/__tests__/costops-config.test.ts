// coverage batch-50: costops/config.ts (62.5% statements, but every
// exported function only ran incidentally as a side effect of unrelated
// bootstrap paths -- no test file references validateConfig/
// loadCostopsConfig/saveCostopsConfig/ensureExampleConfig by name, so the
// branch/error-path coverage inside them was untested. Pure I/O + validation
// module (no DB), so the only isolation needed is STORE_DIR -> a fresh temp
// dir per test, dynamic re-import after vi.resetModules() since
// COSTOPS_CONFIG_PATH/COSTOPS_EXAMPLE_PATH are module-level consts resolved
// from STORE_DIR at import time (same pattern as settings-store.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

let mod: typeof import('../costops/config.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'costops-config-test-'))
  mkdirSync(storeDir, { recursive: true })
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  mod = await import('../costops/config.js')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('validateConfig', () => {
  it('falls back to an empty, valid config for non-object input', () => {
    const r = mod.validateConfig(null)
    expect(r.errors).toEqual([])
    expect(r.config).toEqual({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
  })

  it('preserves a top-level version and currency when present', () => {
    const r = mod.validateConfig({ version: 3, currency: 'USD' })
    expect(r.config.version).toBe(3)
    expect(r.config.currency).toBe('USD')
  })

  it('keeps a fully-specified fixed_costs entry as-is', () => {
    const entry = {
      source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic',
      source_type: 'subscription', amount: 25, period: 'monthly',
      charge_category: 'subscription', confidence: 'manual', currency: 'USD', notes: 'x',
    }
    const r = mod.validateConfig({ fixed_costs: [entry] })
    expect(r.errors).toEqual([])
    expect(r.config.fixed_costs).toEqual([entry])
  })

  it('fills defaults for a minimal fixed_costs entry', () => {
    const r = mod.validateConfig({ currency: 'EUR', fixed_costs: [{ source_id: 'x', amount: 5 }] })
    expect(r.errors).toEqual([])
    expect(r.config.fixed_costs[0]).toEqual({
      source_id: 'x', name: 'x', provider: 'other', source_type: 'manual',
      amount: 5, period: 'monthly', charge_category: 'subscription',
      confidence: 'manual', currency: 'EUR', notes: undefined,
    })
  })

  it('drops a fixed_costs entry with a missing source_id and records an error', () => {
    const r = mod.validateConfig({ fixed_costs: [{ amount: 5 }] })
    expect(r.config.fixed_costs).toHaveLength(0)
    expect(r.errors[0]).toContain('missing source_id')
  })

  it.each([
    ['negative', { source_id: 'x', amount: -1 }],
    ['non-number', { source_id: 'x', amount: '5' }],
    ['non-finite', { source_id: 'x', amount: Infinity }],
    ['missing', { source_id: 'x' }],
  ])('drops a fixed_costs entry with a %s amount and records an error', (_label, entry) => {
    const r = mod.validateConfig({ fixed_costs: [entry] })
    expect(r.config.fixed_costs).toHaveLength(0)
    expect(r.errors[0]).toContain('amount must be a non-negative number')
  })

  it('rejects any fixed_costs period other than monthly (v0.1 constraint)', () => {
    const r = mod.validateConfig({ fixed_costs: [{ source_id: 'x', amount: 5, period: 'yearly' }] })
    expect(r.config.fixed_costs).toHaveLength(0)
    expect(r.errors[0]).toContain("only period 'monthly' is supported")
  })

  it('keeps a fully-specified budgets entry as-is', () => {
    const entry = {
      id: 'global-monthly', name: 'Global', scope: 'agent', scope_ref: 'test-agent',
      amount: 1_000_000, currency: 'USD', warning_threshold: 0.5, hard_threshold: 0.9, block_on_hard: true,
    }
    const r = mod.validateConfig({ budgets: [entry] })
    expect(r.errors).toEqual([])
    expect(r.config.budgets).toEqual([entry])
  })

  it('fills defaults for a minimal budgets entry', () => {
    const r = mod.validateConfig({ budgets: [{ id: 'b1', amount: 100 }] })
    expect(r.errors).toEqual([])
    expect(r.config.budgets[0]).toEqual({
      id: 'b1', name: 'b1', scope: 'global', scope_ref: undefined,
      amount: 100, currency: 'HUF', warning_threshold: 0.8, hard_threshold: 1.0, block_on_hard: false,
    })
  })

  it('drops a budgets entry with a missing id and records an error', () => {
    const r = mod.validateConfig({ budgets: [{ amount: 100 }] })
    expect(r.config.budgets).toHaveLength(0)
    expect(r.errors[0]).toContain('missing id')
  })

  it('drops a budgets entry with a negative amount and records an error', () => {
    const r = mod.validateConfig({ budgets: [{ id: 'b1', amount: -5 }] })
    expect(r.config.budgets).toHaveLength(0)
    expect(r.errors[0]).toContain('amount must be a non-negative number')
  })

  it('block_on_hard is true only for a literal boolean true, not a truthy string', () => {
    const r = mod.validateConfig({ budgets: [{ id: 'b1', amount: 1, block_on_hard: 'yes' }] })
    expect(r.config.budgets[0].block_on_hard).toBe(false)
  })
})

describe('loadCostopsConfig', () => {
  it('writes the placeholder example and returns an empty non-existent config when no file is present', () => {
    expect(existsSync(mod.COSTOPS_CONFIG_PATH)).toBe(false)
    const r = mod.loadCostopsConfig()
    expect(r.exists).toBe(false)
    expect(r.errors).toEqual([])
    expect(r.config).toEqual({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
    expect(existsSync(mod.COSTOPS_EXAMPLE_PATH)).toBe(true)
  })

  it('reports a parse error for malformed JSON without throwing', () => {
    writeFileSync(mod.COSTOPS_CONFIG_PATH, '{ not json', 'utf-8')
    const r = mod.loadCostopsConfig()
    expect(r.exists).toBe(true)
    expect(r.errors).toEqual(['config is not valid JSON'])
    expect(r.config.fixed_costs).toEqual([])
  })

  it('validates a well-formed existing config file', () => {
    writeFileSync(mod.COSTOPS_CONFIG_PATH, JSON.stringify({
      version: 2, currency: 'USD', fixed_costs: [{ source_id: 'x', amount: 10 }], budgets: [],
    }), 'utf-8')
    const r = mod.loadCostopsConfig()
    expect(r.exists).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.config.version).toBe(2)
    expect(r.config.fixed_costs).toHaveLength(1)
  })
})

describe('saveCostopsConfig', () => {
  it('re-validates and persists the normalized config to disk', () => {
    const result = mod.saveCostopsConfig({
      version: 1, currency: 'HUF',
      fixed_costs: [{ source_id: 'x', name: 'x', provider: 'other', source_type: 'manual', amount: 7 }],
      budgets: [],
    })
    expect(result.errors).toEqual([])
    expect(existsSync(mod.COSTOPS_CONFIG_PATH)).toBe(true)
    const onDisk = JSON.parse(readFileSync(mod.COSTOPS_CONFIG_PATH, 'utf-8'))
    expect(onDisk.fixed_costs[0].source_id).toBe('x')
    expect(onDisk.fixed_costs[0].amount).toBe(7)
  })

  it('drops invalid entries on save the same way validateConfig would', () => {
    const result = mod.saveCostopsConfig({
      version: 1, currency: 'HUF',
      fixed_costs: [{ source_id: '', name: '', provider: '', source_type: '', amount: 1 }],
      budgets: [],
    })
    expect(result.errors[0]).toContain('missing source_id')
    const onDisk = JSON.parse(readFileSync(mod.COSTOPS_CONFIG_PATH, 'utf-8'))
    expect(onDisk.fixed_costs).toEqual([])
  })
})

describe('ensureExampleConfig', () => {
  it('creates the example file when absent', () => {
    expect(existsSync(mod.COSTOPS_EXAMPLE_PATH)).toBe(false)
    mod.ensureExampleConfig()
    expect(existsSync(mod.COSTOPS_EXAMPLE_PATH)).toBe(true)
    const parsed = JSON.parse(readFileSync(mod.COSTOPS_EXAMPLE_PATH, 'utf-8'))
    expect(parsed.fixed_costs.length).toBeGreaterThan(0)
  })

  it('never overwrites an already-existing example file', () => {
    writeFileSync(mod.COSTOPS_EXAMPLE_PATH, 'hand-edited sentinel', 'utf-8')
    mod.ensureExampleConfig()
    expect(readFileSync(mod.COSTOPS_EXAMPLE_PATH, 'utf-8')).toBe('hand-edited sentinel')
  })
})

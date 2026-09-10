import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'budget-alert-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR, DB_FILENAME: 'claudeclaw.db' }))

const { mockNotifyChannel } = vi.hoisted(() => ({ mockNotifyChannel: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../notify.js', () => ({ notifyChannel: mockNotifyChannel }))

import { initDatabase, getDb } from '../db.js'
import { evaluateBudgets, type BudgetStatus } from '../costops/budget-alert.js'
import { runBudgetAlertCheck } from '../costops/budget-alert-runner.js'
import type { CostOpsConfig, BudgetEntry } from '../costops/config.js'

const COSTOPS_CONFIG_PATH = join(STORE_DIR, 'costops-config.json')
const STATE_PATH = join(STORE_DIR, 'budget-alert-state.json')

// 2026-09-10T12:00:00 local time -- comfortably inside "2026-09".
const NOW_MS = new Date('2026-09-10T12:00:00').getTime()
const NOW_SEC = Math.floor(NOW_MS / 1000)

function budget(overrides: Partial<BudgetEntry> = {}): BudgetEntry {
  return {
    id: 'global-monthly',
    name: 'Global monthly',
    scope: 'global',
    amount: 1000,
    warning_threshold: 0.8,
    hard_threshold: 1.0,
    ...overrides,
  }
}

function config(budgets: BudgetEntry[]): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets }
}

function insertRawUsage(agent: string, timestampSec: number, tokens: Partial<{
  input_tokens: number; output_tokens: number; cache_read_tokens: number
  cache_creation_tokens: number; thinking_tokens: number; tenant_id: string
}>): void {
  const db = getDb()
  const tenant_id = tokens.tenant_id ?? 'default'
  db.prepare(`
    INSERT INTO token_usage
      (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model, tenant_id)
    VALUES (@agent, @session_id, @timestamp, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @thinking_tokens, 'test-model', @tenant_id)
  `).run({
    agent,
    session_id: `sess-${agent}-${tenant_id}-${timestampSec}`,
    timestamp: timestampSec,
    input_tokens: tokens.input_tokens ?? 0,
    output_tokens: tokens.output_tokens ?? 0,
    cache_read_tokens: tokens.cache_read_tokens ?? 0,
    cache_creation_tokens: tokens.cache_creation_tokens ?? 0,
    thinking_tokens: tokens.thinking_tokens ?? 0,
    tenant_id,
  })
}

function insertMonthlyRollup(month: string, agent: string, tokens: Partial<{
  input_tokens: number; output_tokens: number; cache_read_tokens: number
  cache_creation_tokens: number; thinking_tokens: number
}>): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO token_usage_monthly
      (month, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, session_count, row_count)
    VALUES (@month, @agent, 'test-model', @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @thinking_tokens, 1, 1)
  `).run({
    month,
    agent,
    input_tokens: tokens.input_tokens ?? 0,
    output_tokens: tokens.output_tokens ?? 0,
    cache_read_tokens: tokens.cache_read_tokens ?? 0,
    cache_creation_tokens: tokens.cache_creation_tokens ?? 0,
    thinking_tokens: tokens.thinking_tokens ?? 0,
  })
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mockNotifyChannel.mockClear()
  try { rmSync(COSTOPS_CONFIG_PATH) } catch { /* fine */ }
  try { rmSync(STATE_PATH) } catch { /* fine */ }
})

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('evaluateBudgets', () => {
  it('reports ok when spend is well under the warning threshold', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 100, output_tokens: 50 })
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 1000 })]), NOW_MS)
    expect(status.spent).toBe(150)
    expect(status.ratio).toBeCloseTo(0.15)
    expect(status.level).toBe('ok')
    expect(status.blocked).toBe(false)
  })

  it('sums BOTH raw token_usage and rolled-up token_usage_monthly for the current month (no double count)', () => {
    // Half the month already aggregated (as pruneTokenUsage would do if
    // retention were shorter), half still raw -- both must count.
    insertMonthlyRollup('2026-09', 'agent-a', { input_tokens: 300, output_tokens: 100 })
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 200, output_tokens: 50 })
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 1000 })]), NOW_MS)
    expect(status.spent).toBe(300 + 100 + 200 + 50)
  })

  it('ignores usage from other months', () => {
    const augustSec = Math.floor(new Date('2026-08-15T12:00:00').getTime() / 1000)
    insertRawUsage('agent-a', augustSec, { input_tokens: 900, output_tokens: 900 })
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 10, output_tokens: 10 })
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 1000 })]), NOW_MS)
    expect(status.spent).toBe(20)
  })

  it('reaches warning level at the configured threshold', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 850 })
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 1000, warning_threshold: 0.8, hard_threshold: 1.0 })]), NOW_MS)
    expect(status.level).toBe('warning')
  })

  it('reaches hard level once spend meets the hard threshold', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 1000 })
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 1000, hard_threshold: 1.0 })]), NOW_MS)
    expect(status.level).toBe('hard')
  })

  it('marks blocked only when hard level AND block_on_hard is set', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 1000 })
    const [withFlag] = evaluateBudgets(getDb(), config([budget({ amount: 1000, block_on_hard: true })]), NOW_MS)
    expect(withFlag.level).toBe('hard')
    expect(withFlag.blocked).toBe(true)

    const [withoutFlag] = evaluateBudgets(getDb(), config([budget({ amount: 1000, block_on_hard: false })]), NOW_MS)
    expect(withoutFlag.blocked).toBe(false)
  })

  it('scopes to a single agent when scope is "agent"', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 100 })
    insertRawUsage('agent-b', NOW_SEC, { input_tokens: 900 })
    const [status] = evaluateBudgets(
      getDb(),
      config([budget({ id: 'agent-a-monthly', scope: 'agent', scope_ref: 'agent-a', amount: 1000 })]),
      NOW_MS,
    )
    expect(status.spent).toBe(100)
  })

  it('scopes to a single tenant when scope is "tenant" (other tenants excluded)', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 100, tenant_id: 'acme' })
    insertRawUsage('agent-b', NOW_SEC, { input_tokens: 900, tenant_id: 'other-tenant' })
    const [status] = evaluateBudgets(
      getDb(),
      config([budget({ id: 'acme-monthly', scope: 'tenant', scope_ref: 'acme', amount: 1000 })]),
      NOW_MS,
    )
    expect(status.spent).toBe(100)
  })

  it('fails open (ok, spent 0) for a tenant-scope budget missing scope_ref', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 5000, tenant_id: 'acme' })
    const [status] = evaluateBudgets(getDb(), config([budget({ scope: 'tenant', amount: 1000 })]), NOW_MS)
    expect(status.level).toBe('ok')
    expect(status.spent).toBe(0)
  })

  it('fails open (ok, spent 0) for an agent-scope budget missing scope_ref', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 5000 })
    const [status] = evaluateBudgets(getDb(), config([budget({ scope: 'agent', amount: 1000 })]), NOW_MS)
    expect(status.level).toBe('ok')
    expect(status.spent).toBe(0)
  })

  it('fails open for scopes with no token-volume equivalent (source/provider/product)', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 5000 })
    for (const scope of ['source', 'provider', 'product'] as const) {
      const [status] = evaluateBudgets(getDb(), config([budget({ scope, amount: 1000 })]), NOW_MS)
      expect(status.level).toBe('ok')
    }
  })

  it('fails open for a zero/unset amount instead of dividing by zero', () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 5000 })
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 0 })]), NOW_MS)
    expect(status.level).toBe('ok')
    expect(Number.isFinite(status.ratio)).toBe(true)
  })

  it('returns ok with no usage at all (empty tables)', () => {
    const [status] = evaluateBudgets(getDb(), config([budget({ amount: 1000 })]), NOW_MS)
    expect(status).toMatchObject({ spent: 0, ratio: 0, level: 'ok', blocked: false })
  })
})

describe('runBudgetAlertCheck', () => {
  function writeConfig(budgets: BudgetEntry[]): void {
    writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify(config(budgets)), 'utf-8')
  }

  it('does nothing when no budgets are configured', async () => {
    writeConfig([])
    await runBudgetAlertCheck(getDb(), NOW_MS)
    expect(mockNotifyChannel).not.toHaveBeenCalled()
    expect(existsSync(STATE_PATH)).toBe(false)
  })

  it('notifies once for a hard-level budget and persists cooldown state', async () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 1000 })
    writeConfig([budget({ amount: 1000 })])

    await runBudgetAlertCheck(getDb(), NOW_MS)

    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(mockNotifyChannel.mock.calls[0][0]).toMatch(/plafon elérve/)
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    expect(state['global-monthly'].hard_last_sent).toBe(NOW_MS)
  })

  it('does not re-notify within the hard cooldown window (6h)', async () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 1000 })
    writeConfig([budget({ amount: 1000 })])

    await runBudgetAlertCheck(getDb(), NOW_MS)
    mockNotifyChannel.mockClear()
    await runBudgetAlertCheck(getDb(), NOW_MS + 60 * 60 * 1000) // +1h, still under 6h cooldown

    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })

  it('re-notifies once the hard cooldown window has elapsed', async () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 1000 })
    writeConfig([budget({ amount: 1000 })])

    await runBudgetAlertCheck(getDb(), NOW_MS)
    mockNotifyChannel.mockClear()
    await runBudgetAlertCheck(getDb(), NOW_MS + 7 * 60 * 60 * 1000) // +7h, past 6h cooldown

    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
  })

  it('does not notify for a budget still at ok level', async () => {
    insertRawUsage('agent-a', NOW_SEC, { input_tokens: 10 })
    writeConfig([budget({ amount: 1000 })])

    await runBudgetAlertCheck(getDb(), NOW_MS)

    expect(mockNotifyChannel).not.toHaveBeenCalled()
    expect(existsSync(STATE_PATH)).toBe(false)
  })
})

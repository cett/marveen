// Budget-plafon riasztás -- pure evaluation logic.
//
// Cost basis is TOKEN VOLUME, not money: BudgetEntry.amount is a token count,
// checked against the sum of input/output/cache/thinking tokens used in the
// current calendar month -- billed_cost/HUF aggregation is explicitly out of
// scope here.
//
// Token totals for the current month must be read from BOTH token_usage
// (raw, unaggregated rows) AND token_usage_monthly (rolled-up rows): the daily
// sweep (pruneTokenUsage in db/audit.ts) only rolls a raw row into the monthly
// table once it falls outside TOKEN_USAGE_RETENTION_DAYS (default 30) -- so
// for an in-progress month almost everything is still sitting in the raw
// table. Summing only token_usage_monthly would under-report the current
// month's usage by nearly 100% for most of the month.
import type Database from 'better-sqlite3'
import type { BudgetEntry, CostOpsConfig } from './config.js'

export interface BudgetStatus {
  budget: BudgetEntry
  spent: number
  ratio: number
  level: 'ok' | 'warning' | 'hard'
  blocked: boolean // level === 'hard' && budget.block_on_hard
}

const TOKEN_SUM_EXPR = 'input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens + thinking_tokens'

// Scopes that used to be billed_cost/ledger-based (removed 2026-08-23, #524
// cleanup) and have no token-volume equivalent. Fail-open: treated as no data.
const UNSUPPORTED_SCOPES = new Set(['source', 'provider', 'product'])

function monthlyTokenSpend(db: Database.Database, agent: string | null, nowSec: number): number {
  const row = db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(${TOKEN_SUM_EXPR}) FROM token_usage_monthly
        WHERE month = strftime('%Y-%m', @nowSec, 'unixepoch', 'localtime')
          AND (@agent IS NULL OR agent = @agent)
      ), 0)
      +
      COALESCE((
        SELECT SUM(${TOKEN_SUM_EXPR}) FROM token_usage
        WHERE strftime('%Y-%m', timestamp, 'unixepoch', 'localtime')
              = strftime('%Y-%m', @nowSec, 'unixepoch', 'localtime')
          AND (@agent IS NULL OR agent = @agent)
      ), 0)
      AS total
  `).get({ nowSec, agent }) as { total: number }
  return row.total
}

/**
 * Evaluate every configured budget against the current month's token spend.
 * Fail-open throughout: any budget whose scope has no data (unsupported
 * scope, empty tables, zero amount) reads as 'ok' rather than raising or
 * fabricating a false alarm.
 */
export function evaluateBudgets(
  db: Database.Database,
  config: CostOpsConfig,
  nowMs: number,
): BudgetStatus[] {
  const nowSec = Math.floor(nowMs / 1000)
  return config.budgets.map((budget) => {
    const scope = budget.scope ?? 'global'
    if (UNSUPPORTED_SCOPES.has(scope) || budget.amount <= 0) {
      return { budget, spent: 0, ratio: 0, level: 'ok', blocked: false }
    }
    if (scope === 'agent' && !budget.scope_ref) {
      return { budget, spent: 0, ratio: 0, level: 'ok', blocked: false }
    }
    const agent = scope === 'agent' ? budget.scope_ref! : null
    const spent = monthlyTokenSpend(db, agent, nowSec)
    const ratio = spent / budget.amount
    const warn = budget.warning_threshold ?? 0.8
    const hard = budget.hard_threshold ?? 1.0
    const level: BudgetStatus['level'] = ratio >= hard ? 'hard' : ratio >= warn ? 'warning' : 'ok'
    return { budget, spent, ratio, level, blocked: level === 'hard' && budget.block_on_hard === true }
  })
}

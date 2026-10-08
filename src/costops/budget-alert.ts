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
import type { BudgetEntry, CostOpsConfig } from './config.js'
import { getMonthlyTokenSpend, type TokenSpendFilter } from '../db.js'

export interface BudgetStatus {
  budget: BudgetEntry
  spent: number
  ratio: number
  level: 'ok' | 'warning' | 'hard'
  blocked: boolean // level === 'hard' && budget.block_on_hard
}

// Scopes that used to be billed_cost/ledger-based (removed 2026-08-23, #524
// cleanup) and have no token-volume equivalent. Fail-open: treated as no data.
const UNSUPPORTED_SCOPES = new Set(['source', 'provider', 'product'])

/**
 * Evaluate every configured budget against the current month's token spend.
 * Fail-open throughout: any budget whose scope has no data (unsupported
 * scope, empty tables, zero amount) reads as 'ok' rather than raising or
 * fabricating a false alarm.
 */
export function evaluateBudgets(
  config: CostOpsConfig,
  nowMs: number,
): BudgetStatus[] {
  const nowSec = Math.floor(nowMs / 1000)
  return config.budgets.map((budget) => {
    const scope = budget.scope ?? 'global'
    if (UNSUPPORTED_SCOPES.has(scope) || budget.amount <= 0) {
      return { budget, spent: 0, ratio: 0, level: 'ok', blocked: false }
    }
    if ((scope === 'agent' || scope === 'tenant') && !budget.scope_ref) {
      return { budget, spent: 0, ratio: 0, level: 'ok', blocked: false }
    }
    const filter: TokenSpendFilter =
      scope === 'agent' ? { agent: budget.scope_ref } :
      scope === 'tenant' ? { tenant: budget.scope_ref } :
      {}
    const spent = getMonthlyTokenSpend(filter, nowSec)
    const ratio = spent / budget.amount
    const warn = budget.warning_threshold ?? 0.8
    const hard = budget.hard_threshold ?? 1.0
    const level: BudgetStatus['level'] = ratio >= hard ? 'hard' : ratio >= warn ? 'warning' : 'ok'
    return { budget, spent, ratio, level, blocked: level === 'hard' && budget.block_on_hard === true }
  })
}

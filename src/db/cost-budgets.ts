// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).
//
// Read/write access to cost_budgets (migration 0061, #985 group 6/8) plus the
// one-time migrator that copies an existing install's store/costops-config.json
// `budgets[]` array into it. `version`/`currency`/`fixed_costs` stay in that
// JSON file -- only `budgets` moved here. See the migration file's own header
// comment for why (fixed_costs has no clean home in the existing cost_sources
// table) and for why this migrator never bakes real values into a tracked
// migration (costops-config.json is gitignored specifically to keep real
// budget/cost figures out of tracked files).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './connection.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import type { BudgetEntry } from '../costops/config.js'

interface CostBudgetRow {
  id: string
  name: string
  scope: string
  scope_ref: string | null
  amount: number
  currency: string
  warning_threshold: number
  hard_threshold: number
  block_on_hard: number
  tenant_id: string
}

function rowToBudgetEntry(row: CostBudgetRow): BudgetEntry {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as BudgetEntry['scope'],
    scope_ref: row.scope_ref ?? undefined,
    amount: row.amount,
    currency: row.currency,
    warning_threshold: row.warning_threshold,
    hard_threshold: row.hard_threshold,
    block_on_hard: row.block_on_hard === 1,
  }
}

export function listCostBudgets(tenantId: string = 'default'): BudgetEntry[] {
  const rows = db
    .prepare(
      `SELECT id, name, scope, scope_ref, amount, currency, warning_threshold, hard_threshold, block_on_hard, tenant_id
       FROM cost_budgets WHERE tenant_id = ? ORDER BY id`
    )
    .all(tenantId) as CostBudgetRow[]
  return rows.map(rowToBudgetEntry)
}

// Whole-value replace within a transaction: matches the pre-migration
// behavior of saveCostopsConfig() overwriting the entire file (so a budget
// removed by the caller's in-memory edit actually disappears, not just an
// upsert of what's present).
export function replaceCostBudgets(tenantId: string, budgets: BudgetEntry[]): void {
  const now = Math.floor(Date.now() / 1000)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cost_budgets WHERE tenant_id = ?').run(tenantId)
    const stmt = db.prepare(
      `INSERT INTO cost_budgets
         (id, name, scope, scope_ref, amount, currency, warning_threshold, hard_threshold, block_on_hard, tenant_id, created_at, updated_at)
       VALUES (@id, @name, @scope, @scope_ref, @amount, @currency, @warning_threshold, @hard_threshold, @block_on_hard, @tenant_id, @now, @now)`
    )
    for (const b of budgets) {
      stmt.run({
        id: b.id,
        name: b.name ?? b.id,
        scope: b.scope ?? 'global',
        scope_ref: b.scope_ref ?? null,
        amount: b.amount,
        currency: b.currency ?? 'HUF',
        warning_threshold: b.warning_threshold ?? 0.8,
        hard_threshold: b.hard_threshold ?? 1.0,
        block_on_hard: b.block_on_hard === true ? 1 : 0,
        tenant_id: tenantId,
        now,
      })
    }
  })
  tx()
}

// One-time backfill of an existing install's store/costops-config.json
// `budgets[]` array into cost_budgets. INSERT OR IGNORE per row (same
// idiom as the other #985 group file-backfill migrators): an operator's
// later DB edit is never overwritten by a stale re-read, and a fresh
// install with no file gets zero rows -- matching loadCostopsConfig()'s own
// pre-migration default of an empty budgets array. Safe to call on every boot.
export function migrateCostBudgetsFromFile(): number {
  const filePath = join(STORE_DIR, 'costops-config.json')
  if (!existsSync(filePath)) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    logger.warn({ err, filePath }, 'cost_budgets migration: failed to parse costops-config.json, skipping')
    return 0
  }
  if (!parsed || typeof parsed !== 'object') return 0
  const rawBudgets = (parsed as Record<string, unknown>).budgets
  if (!Array.isArray(rawBudgets)) return 0

  const stmt = db.prepare(
    `INSERT INTO cost_budgets
       (id, name, scope, scope_ref, amount, currency, warning_threshold, hard_threshold, block_on_hard, tenant_id, created_at, updated_at)
     VALUES (@id, @name, @scope, @scope_ref, @amount, @currency, @warning_threshold, @hard_threshold, @block_on_hard, 'default', unixepoch(), unixepoch())
     ON CONFLICT DO NOTHING`
  )
  let migrated = 0
  for (const e of rawBudgets) {
    const b = e as Record<string, unknown>
    if (typeof b?.id !== 'string' || !b.id) continue
    if (typeof b?.amount !== 'number' || !isFinite(b.amount) || b.amount < 0) continue
    const result = stmt.run({
      id: b.id,
      name: typeof b.name === 'string' ? b.name : b.id,
      scope: typeof b.scope === 'string' ? b.scope : 'global',
      scope_ref: typeof b.scope_ref === 'string' ? b.scope_ref : null,
      amount: b.amount,
      currency: typeof b.currency === 'string' ? b.currency : 'HUF',
      warning_threshold: typeof b.warning_threshold === 'number' ? b.warning_threshold : 0.8,
      hard_threshold: typeof b.hard_threshold === 'number' ? b.hard_threshold : 1.0,
      block_on_hard: b.block_on_hard === true ? 1 : 0,
    })
    if (result.changes > 0) migrated++
  }
  return migrated
}

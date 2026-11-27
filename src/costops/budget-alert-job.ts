// The budget check as one process run (scripts/budget-alert-check.ts): boots the database this process runs on, evaluates the
// budgets inside the named system job `budget-alert-check`, logs one line that says what it saw, and ends the pool.
//
//   PostgreSQL  MARVEEN_PG_URL set: bootPgBackend({ migrateUrl: '' }), the way the channel coordinator boots
//               (channel-coordinator/boot.ts). The serving pool on the application role; no migrate URL, so no DDL from this
//               process and the owner credential is never read here.
//   SQLite      otherwise: the unchanged initDatabase() chain.
//
// The trap this file closes: evaluateBudgets is fail-open. Without the system context, row-level security shows zero
// budgets and zero token rows, so an unwrapped run exits 0, prints nothing, and every budget reads 0%. The info line below
// (the budgets seen, the level and the rounded ratio of each) is what tells "ran and saw N budgets" apart from "ran blind".
// It carries no amounts and no spend figures.
//
// A failure propagates to the caller, which exits non-zero with the error on stderr. The pool is ended on success and on
// failure alike.
import { logger } from '../logger.js'
import { resolvePgUrl } from '../db/pg/url.js'
import { bootPgBackend, closePgBackend } from '../db/pg-boot.js'
import { initDatabase } from '../db.js'
import { systemJob } from '../db/background-jobs.js'
import { runBudgetAlertCheck } from './budget-alert-runner.js'
import type { BudgetStatus } from './budget-alert.js'

export interface BudgetAlertJobResult {
  backend: 'sqlite' | 'pg'
  statuses: BudgetStatus[]
}

/** One evaluation+notify pass on the database of this process. `nowMs` is the clock of the evaluation (tests pass a fixed one). */
export async function runBudgetAlertJob(nowMs: number = Date.now()): Promise<BudgetAlertJobResult> {
  const backend = resolvePgUrl() === undefined ? 'sqlite' : 'pg'
  try {
    if (backend === 'pg') {
      // migrateUrl '' = none, whatever the environment says (see channel-coordinator/boot.ts)
      await bootPgBackend({ migrateUrl: '' })
    } else {
      initDatabase()
    }
    const statuses = await systemJob('budget-alert-check', () => runBudgetAlertCheck(nowMs))()
    logger.info(
      {
        backend,
        budgets: statuses.length,
        results: statuses.map((s) => ({ id: s.budget.id, level: s.level, ratio: Math.round(s.ratio * 100) / 100 })),
      },
      'budget-alert-check: evaluated',
    )
    return { backend, statuses }
  } finally {
    await closePgBackend()
  }
}

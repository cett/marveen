#!/usr/bin/env tsx
// Budget-plafon riasztás -- one-shot CLI entry point for the scheduled task.
// Invoked by the budget-plafon-monitor heartbeat prompt:
//
//   npm run budget-alert-check
//
// Boots the database this install runs on (PostgreSQL when MARVEEN_PG_URL is set, SQLite otherwise), runs one
// evaluation+notify pass inside the system job `budget-alert-check`, ends the pool and exits. The logic lives in
// src/costops/budget-alert*.ts (unit-tested) and the boot and the job in src/costops/budget-alert-job.ts.
import './lib/log-to-stderr.js'
import { logger } from '../src/logger.js'
import { runBudgetAlertJob } from '../src/costops/budget-alert-job.js'

try {
  await runBudgetAlertJob()
} catch (err) {
  logger.error({ err }, 'budget-alert-check failed')
  process.exitCode = 1
}

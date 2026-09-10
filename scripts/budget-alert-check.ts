#!/usr/bin/env tsx
// Budget-plafon riasztás -- one-shot CLI entry point for the scheduled task.
// Invoked by the budget-plafon-monitor heartbeat prompt:
//
//   npm run budget-alert-check
//
// Opens the real DB, runs one evaluation+notify pass, exits. All logic lives
// in src/costops/budget-alert*.ts (unit-tested); this file is deliberately
// thin.
import { initDatabase, getDb } from '../src/db.js'
import { runBudgetAlertCheck } from '../src/costops/budget-alert-runner.js'

initDatabase()
await runBudgetAlertCheck(getDb())

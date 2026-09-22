// Review-gate enforcement at the three sites where schedule-runner.ts decides
// whether to fire a task. Follows the source-inspection
// pattern established for this file's internal tick loop (see
// schedule-catchup.test.ts's "the runner wires the policy in" and
// schedule-runner-autostart.test.ts) -- the cron fire loop and the pending-retry
// queue live inside startScheduleRunner()'s closure, not exported, and driving
// them end-to-end would require mocking the entire tmux/session/DB stack that
// attemptFireTask depends on. The directly-callable gate (runScheduledTaskNow)
// gets a behavioral test instead, via the route-level mock in
// schedules-review-gate-route.test.ts plus the source assertion below that
// locks in exactly how it enforces the gate.
//
// Regression this guards: a 'draft' task written directly into the DB (or via
// any future write path that bypasses the POST /api/schedules route) must
// never fire on its own cron schedule or through the retry queue, even though
// task.enabled is true -- enabled and live are orthogonal (an operator's
// on/off switch vs. an admin's review-gate approval).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('review-gate: isTaskLive is imported and wired into all three fire sites', () => {
  it('imports isTaskLive from scheduled-tasks-io', () => {
    expect(SRC).toMatch(/^\s*isTaskLive,\s*$/m)
  })

  it('gate 1 -- runScheduledTaskNow (manual run-now) refuses a non-live task unless allowNotLive', () => {
    const fnIdx = SRC.indexOf('export async function runScheduledTaskNow(')
    expect(fnIdx).toBeGreaterThan(0)
    const body = SRC.slice(fnIdx, fnIdx + 1200)
    expect(body).toMatch(/if \(!isTaskLive\(task\) && !opts\.allowNotLive\)/)
    expect(body).toMatch(/error: 'not_live'/)
  })

  it('gate 2 -- the pending-retry queue drops a retry for a task that is no longer live', () => {
    const idx = SRC.indexOf('const pendingRows = listPendingTaskRetries()')
    expect(idx).toBeGreaterThan(0)
    const block = SRC.slice(idx, idx + 1500)
    expect(block).toMatch(/if \(!taskDef\.enabled \|\| !isTaskLive\(taskDef\)\)/)
    expect(block).toMatch(/deletePendingTaskRetry\(row\.task_name, row\.agent_name\)/)
  })

  it('gate 3 -- the main cron fire loop skips a task that is enabled but not live', () => {
    const idx = SRC.indexOf('for (const task of tasks) {')
    expect(idx).toBeGreaterThan(0)
    const loopHead = SRC.slice(idx, idx + 200)
    expect(loopHead).toMatch(/if \(!task\.enabled \|\| !isTaskLive\(task\)\) continue/)
  })

  it('gate 3 comes strictly after the retry-queue processing (both run every tick)', () => {
    // Ordering sanity check: the retry queue (gate 2) is scanned, THEN the
    // cron loop (gate 3) fires due occurrences -- a single missing/duplicated
    // gate would otherwise be easy to miss in a future refactor.
    const retryIdx = SRC.indexOf('const pendingRows = listPendingTaskRetries()')
    const cronIdx = SRC.indexOf('for (const task of tasks) {')
    expect(cronIdx).toBeGreaterThan(retryIdx)
  })
})

describe('review-gate: not_live is a registered API error token', () => {
  it('src/api-error-catalog.ts allows not_live at 409 (state conflict, not malformed request)', () => {
    const catalog = readFileSync(join(__dirname, '../api-error-catalog.ts'), 'utf-8')
    expect(catalog).toMatch(/'not_live'/)
    expect(catalog).toMatch(/409: \[.*'not_live'.*\]/)
  })
})

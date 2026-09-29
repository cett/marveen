// schedule-state-ui: (a) the per-task lastRunResult badge next to the
// existing "last run" text, (b) the scheduler-wide tick-liveness indicator
// (/api/schedules/tick-status). Source-assertion smoke test, same pattern
// as schedules-ui-review-gate.test.ts -- this vanilla-JS module has no
// component framework, so a DOM-mount test would need to reimplement most
// of the module's DI wiring for little extra signal over grepping the exact
// strings the feature depends on.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = readFileSync(join(__dirname, '../../web/modules/schedules.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

const LAST_RUN_RESULT_KEYS = ['fired', 'fired_late', 'skipped_quota', 'skipped_precheck', 'command']

describe('schedules.js: lastRunResult badge', () => {
  it('defines a label and a variant for every schedules.last_run_result value the backend can send', () => {
    for (const key of LAST_RUN_RESULT_KEYS) {
      expect(APP).toMatch(new RegExp(`${key}:\\s*\\(\\) => t\\('tasks\\.last_run_result\\.${key}'\\)`))
      expect(APP).toMatch(new RegExp(`${key}:\\s*'(success|warning|neutral|danger|accent|info)'`))
    }
  })

  it('the badge only renders once a task has actually run (guards against a false "never" -> badge combo)', () => {
    const idx = APP.indexOf('LAST_RUN_RESULT_LABEL[task.lastRunResult]')
    expect(idx).toBeGreaterThan(0)
    const before = APP.slice(Math.max(0, idx - 60), idx)
    expect(before).toMatch(/task\.lastRunAt &&/)
  })

  it('every last_run_result i18n key exists in both languages', () => {
    for (const key of LAST_RUN_RESULT_KEYS) {
      const needle = `'tasks.last_run_result.${key}':`
      expect(EN, `en.js missing ${needle}`).toContain(needle)
      expect(HU, `hu.js missing ${needle}`).toContain(needle)
    }
  })
})

describe('schedules.js: scheduler tick-status heartbeat', () => {
  it('loadSchedules() fires the heartbeat load alongside pending retries', () => {
    const idx = APP.indexOf('loadPendingRetries()\n    loadSchedulerHeartbeat()')
    expect(idx).toBeGreaterThan(0)
  })

  it('the heartbeat fetch is admin-gated, same as the "new task" button', () => {
    const idx = APP.indexOf('async function loadSchedulerHeartbeat')
    const body = APP.slice(idx, idx + 400)
    expect(body).toMatch(/if \(!_canWriteSchedules\) \{ container\.hidden = true; return \}/)
    expect(body).toMatch(/fetch\('\/api\/schedules\/tick-status'\)/)
    expect(body).toMatch(/if \(!res\.ok\) \{ container\.hidden = true; return \}/)
  })

  it('renders a danger badge when stale, success when not, and a warning when lastTickMs is unknown', () => {
    const idx = APP.indexOf('function renderSchedulerHeartbeat')
    const body = APP.slice(idx, idx + 700)
    expect(body).toMatch(/data-variant="warning"[^]*tasks\.scheduler_heartbeat\.unknown/)
    expect(body).toMatch(/data-variant="danger"[^]*tasks\.scheduler_heartbeat\.stale/)
    expect(body).toMatch(/data-variant="success"[^]*tasks\.scheduler_heartbeat\.ok/)
  })

  it('every scheduler_heartbeat i18n key exists in both languages', () => {
    for (const key of ['ok', 'stale', 'unknown']) {
      const needle = `'tasks.scheduler_heartbeat.${key}':`
      expect(EN, `en.js missing ${needle}`).toContain(needle)
      expect(HU, `hu.js missing ${needle}`).toContain(needle)
    }
  })

  it('index.html declares the mount point, hidden by default', () => {
    expect(INDEX_HTML).toMatch(/<div id="schedulerHeartbeatSection" hidden><\/div>/)
  })
})

// The seeded evening `daily-log-summary` command task: inserted once per install, never brought back after the
// operator deleted it, never overwritten after the operator changed it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSchedule, getScheduleFromDb, initDatabase, patchSchedule } from '../db.js'
import { DAILY_LOG_SUMMARY_CRON, DAILY_LOG_SUMMARY_TASK, dailyLogSummaryCommand, ensureDailyLogSummaryTask } from '../web/daily-log-summary-task.js'

let store: string
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'daily-log-summary-seed-'))
  initDatabase(':memory:')
})
afterEach(() => rmSync(store, { recursive: true, force: true }))

const seed = (): boolean => ensureDailyLogSummaryTask(store, '/opt/install', 'main-agent', 3420)

describe('ensureDailyLogSummaryTask', () => {
  it('inserts a live command task for the main agent in the default tenant, at 22:30, without an LLM prompt', () => {
    expect(seed()).toBe(true)
    expect(getScheduleFromDb(DAILY_LOG_SUMMARY_TASK)).toMatchObject({
      type: 'command',
      schedule: '30 22 * * *',
      agent: 'main-agent',
      tenant_id: 'default',
      enabled: 1,
      status: 'live',
      prompt: '',
      command: "export DASHBOARD_BASE_URL='http://localhost:3420'; python3 '/opt/install/scripts/daily-log-summary.py' main-agent",
      catch_up_max_age_minutes: 85,
    })
    expect(DAILY_LOG_SUMMARY_CRON).toBe('30 22 * * *')
    expect(existsSync(join(store, 'daily-log-summary.seeded'))).toBe(true)
  })

  it('renders the command from the install dir, the port and the agent', () => {
    expect(dailyLogSummaryCommand('/a b', 4000, 'zed')).toBe("export DASHBOARD_BASE_URL='http://localhost:4000'; python3 '/a b/scripts/daily-log-summary.py' zed")
  })

  it('seeds once: a second start inserts nothing', () => {
    expect(seed()).toBe(true)
    expect(seed()).toBe(false)
  })

  it('does not bring the task back after the operator deleted it', () => {
    seed()
    deleteSchedule(DAILY_LOG_SUMMARY_TASK)
    expect(seed()).toBe(false)
    expect(getScheduleFromDb(DAILY_LOG_SUMMARY_TASK)).toBeUndefined()
  })

  it('leaves an operator-changed row as it is, and still settles the marker', () => {
    seed()
    patchSchedule(DAILY_LOG_SUMMARY_TASK, { schedule: '0 23 * * *', enabled: false })
    rmSync(join(store, 'daily-log-summary.seeded'))
    expect(seed()).toBe(false)
    expect(getScheduleFromDb(DAILY_LOG_SUMMARY_TASK)).toMatchObject({ schedule: '0 23 * * *', enabled: 0 })
    expect(existsSync(join(store, 'daily-log-summary.seeded'))).toBe(true)
  })
})

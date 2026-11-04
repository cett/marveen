import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, WEB_PORT } from '../config.js'
import { seedScheduleIfAbsent } from '../db.js'
import { logger } from '../logger.js'

// The evening daily-log summary of the install: a seeded `daily-log-summary` command task that runs
// scripts/daily-log-summary.py as the main agent. Before it, the daily log only held what agents chose to POST,
// so a quiet agent left the log empty for weeks. The seed happens once per install (a marker file, like
// `claude-update`): an existing install gets the task too, a task the operator deleted does not come back, and a
// task the operator changed is never overwritten (seedScheduleIfAbsent only inserts).

export const DAILY_LOG_SUMMARY_TASK = 'daily-log-summary'
/** 22:30 every day (the node process runs in Europe/Budapest, like every cron here). */
export const DAILY_LOG_SUMMARY_CRON = '30 22 * * *'
const SEEDED_MARKER = 'daily-log-summary.seeded'

export function dailyLogSummaryCommand(installDir: string, webPort: number, agent: string): string {
  return `export DASHBOARD_BASE_URL='http://localhost:${webPort}'; python3 '${installDir}/scripts/daily-log-summary.py' ${agent}`
}

/** Seeds the task once. Returns true when a row was inserted. */
export async function ensureDailyLogSummaryTask(
  storeDir: string = STORE_DIR,
  projectRoot: string = PROJECT_ROOT,
  agent: string = MAIN_AGENT_ID,
  webPort: number = WEB_PORT,
): Promise<boolean> {
  const marker = join(storeDir, SEEDED_MARKER)
  if (existsSync(marker)) return false
  const inserted = await seedScheduleIfAbsent(DAILY_LOG_SUMMARY_TASK, {
    prompt: '',
    description: 'Esti napi összefoglaló a napi naplóba (LLM nélkül): az aznapi új memóriák, kanban-mozgások, munkadokumentumok és merge-elt PR-ek a scripts/daily-log-summary.py-ból, a fő agent nevében. Naponta egyszer ír (a meglévő bejegyzést nem duplázza), üres napon is egy rövid sort. Hiba esetén (nem 0 exit kód) riasztás.',
    schedule: DAILY_LOG_SUMMARY_CRON,
    agent,
    type: 'command',
    enabled: true,
    tenant_id: 'default',
    skip_if_busy: false,
    force_send: false,
    command: dailyLogSummaryCommand(projectRoot, webPort, agent),
    timeout_ms: 600_000,
    fail_threshold: 2,
    // A run missed by a sleeping host is made up until 23:55 at the latest: the script files the entry under
    // the day it runs on, so a catch-up after midnight would put it on the wrong day.
    catch_up_max_age_minutes: 85,
    status: 'live',
  })
  try { writeFileSync(marker, new Date().toISOString() + '\n') }
  catch (err) { logger.warn({ err }, 'daily-log-summary: failed to write the seeded marker') }
  return inserted
}

import { PROJECT_ROOT, WEB_PORT } from '../config.js'
import { getScheduleFromDb, patchSchedule } from '../db.js'
import { logger } from '../logger.js'

// The nightly `memory-maintenance` command task used to be an inline `curl | grep -q '"ok":true'` chain. It now runs
// scripts/memory-maintenance.sh, which also reports memories that could not be linked (exit 42, a finding). The
// seed file only reaches an empty schedules table, so an install that already has the row is moved over here, and
// ONLY when its command is still one of the stock forms the earlier releases shipped: an operator's own command is
// never touched.

export const MEMORY_MAINTENANCE_TASK = 'memory-maintenance'

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const AGENT_ID = '[A-Za-z0-9_-]+'

/** The command the seed file renders to now. */
export function memoryMaintenanceCommand(installDir: string, webPort: number, agent: string): string {
  return `export DASHBOARD_BASE_URL='http://localhost:${webPort}'; bash '${installDir}/scripts/memory-maintenance.sh' ${agent}`
}

/** True for the two stock inline forms shipped before the script: with or without the `$API` variable and --agent. */
export function isStockInlineMemoryMaintenanceCommand(command: string, installDir: string, agent?: string): boolean {
  const root = escapeRegExp(installDir)
  // With `agent` given, an inline --agent must name exactly that agent; without it any agent id fits.
  const inlineAgent = agent === undefined ? AGENT_ID : escapeRegExp(agent)
  const call = (api: string, seconds: number, path: string): string =>
    `bash ${api} (?:--agent ${inlineAgent} )?--max-time ${seconds} POST ${path} '\\{\\}' \\| grep -q '"ok":true'`
  const forms = [
    // variable form (the seed file of the previous release)
    new RegExp(
      `^API='${root}/scripts/agent-api\\.sh'; export DASHBOARD_BASE_URL='http://localhost:\\d+'; `
      + `${call('"\\$API"', 120, '/api/memories/resort')} && ${call('"\\$API"', 300, '/api/memories/links/maintain')}$`,
    ),
    // direct form (installs seeded before that)
    new RegExp(
      `^${call(`${root}/scripts/agent-api\\.sh`, 120, '/api/memories/resort')} && ${call(`${root}/scripts/agent-api\\.sh`, 300, '/api/memories/links/maintain')}$`,
    ),
  ]
  return forms.some(re => re.test(command))
}

/** Moves a stock-command memory-maintenance row to the script. Returns true when the row was changed. */
export async function ensureMemoryMaintenanceCommand(installDir: string = PROJECT_ROOT, webPort: number = WEB_PORT): Promise<boolean> {
  const row = await getScheduleFromDb(MEMORY_MAINTENANCE_TASK)
  if (!row || row.type !== 'command' || !row.command) return false
  if (!new RegExp(`^${AGENT_ID}$`).test(row.agent)) return false
  if (!isStockInlineMemoryMaintenanceCommand(row.command, installDir)) return false
  // An inline --agent that is not the row's agent was put there by the operator: moving the row to the script
  // (which runs as row.agent) would silently drop it, so such a row counts as customised and stays as it is.
  if (!isStockInlineMemoryMaintenanceCommand(row.command, installDir, row.agent)) {
    logger.warn({ task: MEMORY_MAINTENANCE_TASK, agent: row.agent }, 'memory-maintenance: the command names another agent than the task, leaving it as it is')
    return false
  }
  await patchSchedule(MEMORY_MAINTENANCE_TASK, { command: memoryMaintenanceCommand(installDir, webPort, row.agent) })
  return true
}

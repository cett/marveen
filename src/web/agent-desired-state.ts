import { getSystemConfig, setSystemConfig } from '../db/system-config.js'
import { logger } from '../logger.js'

// Desired run-state for sub-agents.
//
// The agents run on a tmux server shared with the main channels session, which
// gets `systemctl restart`ed several times a day (bun-watchdog, stuck-tool-call
// watchdog, hard-restart). Because that unit is KillMode=control-group, every
// such restart kills the whole tmux server and takes ALL sub-agents down with
// it -- and the channel monitor only auto-restarts agents whose *session still
// exists* with a dead plugin, not agents whose session vanished entirely.
//
// This records which agents the operator wants running, so the monitor can
// reconcile reality back to that desired state (after a nuke, a dashboard
// restart, or a machine reboot). Explicit start adds; explicit stop removes --
// so a deliberately stopped agent is not resurrected. Migrated off
// store/agents-desired.json into a single system_config row (#985 group 5/8)
// -- see migrateGroup5StateFromFiles() in db/system-config.ts for the
// one-time backfill of an existing install's file.
const KEY = 'agents_desired'

export function getDesiredAgents(): Set<string> {
  try {
    const row = getSystemConfig(KEY)
    if (!row) return new Set()
    const parsed = JSON.parse(row.value)
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
    return new Set()
  } catch (err) {
    logger.warn({ err }, 'Could not read agents_desired from system_config; treating as empty')
    return new Set()
  }
}

function writeDesired(set: Set<string>): void {
  try {
    setSystemConfig(KEY, JSON.stringify([...set].sort()))
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
  }
}

export function addDesiredAgent(name: string): void {
  const set = getDesiredAgents()
  if (set.has(name)) return
  set.add(name)
  writeDesired(set)
  logger.info({ agent: name }, 'Agent added to desired run-state')
}

export function removeDesiredAgent(name: string): void {
  const set = getDesiredAgents()
  if (!set.delete(name)) return
  writeDesired(set)
  logger.info({ agent: name }, 'Agent removed from desired run-state')
}

/** Whole-value replace, for fleet-transfer import -- the identity-takeover model
 *  treats this field as source-authoritative, same as the other P3 overwrite
 *  fields (see DashboardSettingsExport in fleet-transfer.ts). Unlike
 *  add/removeDesiredAgent, this does not merge onto the current set. */
export function setDesiredAgents(names: string[]): void {
  writeDesired(new Set(names))
}

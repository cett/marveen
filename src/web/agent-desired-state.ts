import { getSystemConfig, setSystemConfig } from '../db/system-config.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'

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
//
// The main agent is never in this set. Its lifecycle is service-managed (the
// `<id>-channels` session; /api/agents/<main>/stop answers 400 not_supported), so an
// entry for it could never be removed again and every reader that starts the
// desired agents (startup reconciliation, the monitor's periodic reconcile) would
// launch a second, unused `agent-<main>` session next to the real one. The set is
// filtered here, at the one place all of them read it. (Compared with MAIN_AGENT_ID directly, the same test
// as isMainChannelsAgent() in main-agent.ts, which this module must not import: that file reads more config.)
const KEY = 'agents_desired'

function readStored(): string[] {
  try {
    const row = getSystemConfig(KEY)
    if (!row) return []
    const parsed = JSON.parse(row.value)
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    return []
  } catch (err) {
    logger.warn({ err }, 'Could not read agents_desired from system_config; treating as empty')
    return []
  }
}

export function getDesiredAgents(): Set<string> {
  return new Set(readStored().filter((name) => name !== MAIN_AGENT_ID))
}

function writeDesired(set: Set<string>): void {
  try {
    setSystemConfig(KEY, JSON.stringify([...set].filter((name) => name !== MAIN_AGENT_ID).sort()))
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
  }
}

export function addDesiredAgent(name: string): void {
  if (name === MAIN_AGENT_ID) return
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

/** One-time cleanup for installs whose stored set still holds the main agent (an earlier start request
 *  or the shutdown flush wrote it). Reads the stored value as it is, drops the main agent and writes it back; a
 *  set without it is not touched, so running it on every start is a no-op after the first. Returns true
 *  when it rewrote the row. getDesiredAgents() hides the entry already, this removes it from the row, which
 *  fleet-transfer and a manual read of system_config show too. */
export function pruneMainAgentFromDesired(): boolean {
  const stored = readStored()
  if (!stored.includes(MAIN_AGENT_ID)) return false
  writeDesired(new Set(stored))
  logger.info('Main agent removed from the stored desired run-state (its lifecycle is service-managed)')
  return true
}

import { getSystemConfig, setSystemConfig, updateSystemConfig } from '../db/system-config.js'
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

function parseDesired(raw: string | undefined): Set<string> {
  if (raw === undefined) return new Set()
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  return new Set()
}

// The stored list as it is, the main agent included if an earlier build wrote it. A read stays synchronous (the
// system_config cache answers it); only the writes below are asynchronous.
function readStored(): string[] {
  try {
    return [...parseDesired(getSystemConfig(KEY)?.value)]
  } catch (err) {
    logger.warn({ err }, 'Could not read agents_desired from system_config; treating as empty')
    return []
  }
}

export function getDesiredAgents(): Set<string> {
  return new Set(readStored().filter((name) => name !== MAIN_AGENT_ID))
}

// One read-modify-write of the stored set: the current set is read from the database inside the write
// transaction (updateSystemConfig), so two overlapping add/remove calls both land. A stored value that cannot
// be parsed counts as empty, as getDesiredAgents() reads it. The main agent is dropped from the set before
// `change` sees it and so never survives a write (the same as getDesiredAgents() hiding it on a read).
// `change` returns whether it changed the set.
// A failed write is logged and answered with false, never thrown (the callers are start/stop paths).
async function changeDesired(change: (set: Set<string>) => boolean): Promise<boolean> {
  try {
    return await updateSystemConfig(KEY, (current) => {
      let set: Set<string>
      try { set = parseDesired(current) } catch { set = new Set() }
      set.delete(MAIN_AGENT_ID)
      return change(set) ? JSON.stringify([...set].sort()) : undefined
    })
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
    return false
  }
}

export async function addDesiredAgent(name: string): Promise<void> {
  if (name === MAIN_AGENT_ID) return
  const added = await changeDesired((set) => {
    if (set.has(name)) return false
    set.add(name)
    return true
  })
  if (added) logger.info({ agent: name }, 'Agent added to desired run-state')
}

export async function removeDesiredAgent(name: string): Promise<void> {
  const removed = await changeDesired((set) => set.delete(name))
  if (removed) logger.info({ agent: name }, 'Agent removed from desired run-state')
}

/** Whole-value replace, for fleet-transfer import -- the identity-takeover model
 *  treats this field as source-authoritative, same as the other P3 overwrite
 *  fields (see DashboardSettingsExport in fleet-transfer.ts). Unlike
 *  add/removeDesiredAgent, this does not merge onto the current set. */
export async function setDesiredAgents(names: string[]): Promise<void> {
  try {
    await setSystemConfig(KEY, JSON.stringify([...new Set(names)].filter((name) => name !== MAIN_AGENT_ID).sort()))
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
  }
}

/** One-time cleanup for installs whose stored set still holds the main agent (an earlier start request
 *  or the shutdown flush wrote it). Reads the stored value inside the write transaction, drops the main agent and
 *  writes it back; a set without it is not touched (the update answers undefined), so running it on every start
 *  is a no-op after the first. Resolves true when it rewrote the row. getDesiredAgents() hides the entry already,
 *  this removes it from the row, which fleet-transfer and a manual read of system_config show too. Asynchronous:
 *  the caller awaits it (startup runs it before the desired set is read). */
export async function pruneMainAgentFromDesired(): Promise<boolean> {
  try {
    const pruned = await updateSystemConfig(KEY, (current) => {
      let stored: string[]
      try { stored = [...parseDesired(current)] } catch { return undefined }
      if (!stored.includes(MAIN_AGENT_ID)) return undefined
      return JSON.stringify(stored.filter((name) => name !== MAIN_AGENT_ID).sort())
    })
    if (pruned) logger.info('Main agent removed from the stored desired run-state (its lifecycle is service-managed)')
    return pruned
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
    return false
  }
}

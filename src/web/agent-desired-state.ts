import { getSystemConfig, setSystemConfig, updateSystemConfig } from '../db/system-config.js'
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

function parseDesired(raw: string | undefined): Set<string> {
  if (raw === undefined) return new Set()
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  return new Set()
}

export function getDesiredAgents(): Set<string> {
  try {
    return parseDesired(getSystemConfig(KEY)?.value)
  } catch (err) {
    logger.warn({ err }, 'Could not read agents_desired from system_config; treating as empty')
    return new Set()
  }
}

// One read-modify-write of the stored set: the current set is read from the database inside the write
// transaction (updateSystemConfig), so two overlapping add/remove calls both land. A stored value that cannot
// be parsed counts as empty, as getDesiredAgents() reads it. `change` returns whether it changed the set.
// A failed write is logged and answered with false, never thrown (the callers are start/stop paths).
async function changeDesired(change: (set: Set<string>) => boolean): Promise<boolean> {
  try {
    return await updateSystemConfig(KEY, (current) => {
      let set: Set<string>
      try { set = parseDesired(current) } catch { set = new Set() }
      return change(set) ? JSON.stringify([...set].sort()) : undefined
    })
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
    return false
  }
}

export async function addDesiredAgent(name: string): Promise<void> {
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
    await setSystemConfig(KEY, JSON.stringify([...new Set(names)].sort()))
  } catch (err) {
    logger.error({ err }, 'Failed to persist agents_desired to system_config')
  }
}

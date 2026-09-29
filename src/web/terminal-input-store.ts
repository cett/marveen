import { getSystemConfig, setSystemConfig } from '../db/system-config.js'

// Master opt-in toggle for the dashboard per-agent terminal-input (send-keys)
// feature. DEFAULT OFF.
//
// SECURITY (ddc0cd9b, 2026-07-05): the raw keystroke-injection endpoint
// (/api/agents/:name/keys) was the root-cause vector of the 2026-06-26
// forged-"Szabi" prompt-injection incident, so it was disabled outright. This
// toggle brings it back as a deliberate two-step, owner-gated opt-in: the
// operator must explicitly flip it ON in the dashboard (behind the
// dashboard-token gate) before ANY /keys call is accepted. It defaults to OFF
// and stays OFF across restarts unless the operator turned it on. Every accepted
// /keys call is audit-logged separately (the missing fix from the incident).
//
// Migrated off store/terminal-input.json into system_config (#985 group 5/8).
// Deliberately NOT baked as a migration seed: an install that already opted
// in keeps that choice via migrateGroup5StateFromFiles()'s one-time file
// backfill, but a fresh install with no file gets no row here and reads back
// the safe OFF default below -- baking this fork's current toggle state into
// the shipped migration would silently flip the security default for every
// other install.
const KEY = 'terminal_input_enabled'

/** Current toggle state; OFF by default and on any read error (fail-closed). */
export function readTerminalInputEnabled(): boolean {
  try {
    return getSystemConfig(KEY)?.value === '1'
  } catch {
    return false
  }
}

/** Persist the toggle. Returns the new state. */
export function writeTerminalInputEnabled(enabled: boolean): boolean {
  const next = enabled === true
  setSystemConfig(KEY, next ? '1' : '0')
  return next
}

/** undefined when the operator never explicitly set this toggle -- for
 *  fleet-transfer export. Unlike readTerminalInputEnabled(), this does NOT
 *  substitute the safe-OFF default, so a target install that was never told
 *  about this field on import keeps its own current value instead of being
 *  silently reset to OFF (this toggle is security-sensitive: see the incident
 *  note above readTerminalInputEnabled() -- an import must never be able to
 *  flip a target's deliberate opt-in back off just because the source fleet
 *  never touched the setting). */
export function readTerminalInputEnabledRaw(): boolean | undefined {
  const row = getSystemConfig(KEY)
  return row ? row.value === '1' : undefined
}

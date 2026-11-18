// CLAUDE_ROTATION_MODE: what the backend plan-rotation monitor may do.
//
//   off      the monitor does not even measure
//   observe  it measures, classifies, logs what it WOULD do, and does nothing
//            to the fleet (the default)
//   act      it also performs the rotation (restarts a session)
//
// The mode is the one switch that lets an unattended process restart the main
// agent's session, so it is held to the same bar as RBAC_MODE: only a person
// logged in to the dashboard may write it (POST /api/settings refuses every
// token, the main agent's included, for EVERY value, so nobody can quietly
// switch the monitor off either), and this reader trusts a stored value only
// when it looks like it came through that route:
//
//   * it is read from the system_config row, straight from the table. NEVER
//     from the env file, the process environment or any file an agent can
//     write (getEffectiveSettingValue falls back to .env, so it is not used);
//   * the row's source must be 'db' (what the settings route writes), not a
//     value migrated in from a side-car file;
//   * the newest change-journal row for the key must say the same thing
//     (the route journals every write). A row written by hand has no journal
//     row, and reads as observe plus one log line.
//
// Fail toward doing nothing: a missing row, an unreadable table, a misspelt
// value and an unconfirmed off/act are all observe. Observe is the safe
// state, not off, because the monitor then still keeps the telemetry fresh.

import { getSystemConfigUncached, getLastConfigChangeValue } from '../db.js'
import { logger } from '../logger.js'

export const ROTATION_MODE_KEY = 'CLAUDE_ROTATION_MODE'

export type RotationMode = 'off' | 'observe' | 'act'

/** Why the live mode is not simply the stored value. null: it is. */
export type RotationModeReason = 'invalid_value' | 'not_db_source' | 'unlogged_value' | 'read_error'

export interface RotationModeReading {
  /** What the monitor applies. */
  mode: RotationMode
  /** The raw row value (null: no row, or unreadable). */
  stored: string | null
  reason: RotationModeReason | null
}

/** Exactly off / observe / act (trimmed, any case); anything else is null. */
export function parseRotationModeStrict(raw: unknown): RotationMode | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return v === 'off' || v === 'observe' || v === 'act' ? v : null
}

// One warning per distinct (reason, stored) pair: a stuck bad row must not
// fill the log at one line per tick.
let lastWarned = ''

function warnOnce(reason: RotationModeReason, stored: string | null): void {
  const key = `${reason}:${stored}`
  if (key === lastWarned) return
  lastWarned = key
  try {
    logger.warn({ reason, stored }, 'CLAUDE_ROTATION_MODE row is not trusted, the monitor stays in observe')
  } catch {
    // The logger failing must not change the mode.
  }
}

/** Test seam: forget the last warning. */
export function _resetRotationModeWarningForTest(): void {
  lastWarned = ''
}

/** The mode the monitor applies right now. Never throws. */
export async function readRotationMode(): Promise<RotationModeReading> {
  let stored: string | null = null
  try {
    const row = await getSystemConfigUncached(ROTATION_MODE_KEY)
    if (!row) return { mode: 'observe', stored: null, reason: null }
    stored = row.value
    const parsed = parseRotationModeStrict(row.value)
    if (parsed === null) {
      warnOnce('invalid_value', stored)
      return { mode: 'observe', stored, reason: 'invalid_value' }
    }
    // observe is the default and the floor: nothing to confirm.
    if (parsed === 'observe') return { mode: 'observe', stored, reason: null }
    if (row.source !== 'db') {
      warnOnce('not_db_source', stored)
      return { mode: 'observe', stored, reason: 'not_db_source' }
    }
    const last = await getLastConfigChangeValue(ROTATION_MODE_KEY)
    if (typeof last !== 'string' || parseRotationModeStrict(last) !== parsed) {
      warnOnce('unlogged_value', stored)
      return { mode: 'observe', stored, reason: 'unlogged_value' }
    }
    lastWarned = ''
    return { mode: parsed, stored, reason: null }
  } catch (err) {
    try {
      logger.warn({ err }, 'Could not read CLAUDE_ROTATION_MODE, the monitor stays in observe')
    } catch {
      // see warnOnce
    }
    return { mode: 'observe', stored, reason: 'read_error' }
  }
}

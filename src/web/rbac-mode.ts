// Live RBAC mode: whether the top-level RBAC gate in web.ts blocks (enforce) or only records
// would-deny entries (shadow). The value lives in the system_config row RBAC_MODE and is changed from
// the Settings page, not from the env file.
//
// The gate is synchronous, so it reads getRbacMode(), an in-memory value. The value is refreshed
// (a) right after POST /api/settings writes the key and (b) by an unref'd timer every few seconds, so
// a hand-edited row or a rollback shows without a restart.
//
// Fail closed, everywhere: a missing row, an unreadable table, an unknown value and a read error are
// all enforce, and an error never keeps a previously read shadow. Shadow is a loss-of-protection
// mode, so on top of the strict value it needs two more things:
//   - the env file can only tighten (RBAC_MODE=enforce in the env wins over a stored shadow; an env
//     shadow is ignored once the row exists);
//   - the journal agrees: a stored shadow counts only if the newest config_change_log row for the key
//     says shadow too. A row written by hand (no journal row) is enforce plus an alarm.

import { RBAC_MODE_ENV, MAIN_AGENT_ID } from '../config.js'
import {
  getSystemConfig,
  insertSystemConfigIfAbsent,
  getLastConfigChangeValue,
  logConfigChange,
  writeAdminAuditLog,
  createAgentMessage,
} from '../db.js'
import { logger } from '../logger.js'
import type { RbacMode } from './authz.js'

export const RBAC_MODE_KEY = 'RBAC_MODE'
const REFRESH_INTERVAL_MS = 5000

/** Only the exact word shadow (trimmed, any case) loosens; anything else, empty or misspelled, is enforce. */
export function parseRbacMode(raw: unknown): RbacMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'shadow' ? 'shadow' : 'enforce'
}

// Starts as enforce: until loadRbacMode() has run nothing is loosened.
let cached: RbacMode = 'enforce'
let unloggedShadowAlarmed = false
let timer: NodeJS.Timeout | undefined

/** The mode the gate applies. Synchronous and never throws. */
export function getRbacMode(): RbacMode {
  return cached
}

/** Tell the main agent (and through it the owner). Never throws: a notice fault must not change the mode. */
export function notifyRbacMode(content: string): void {
  try {
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    logger.warn({ err }, 'Could not notify the main agent about the RBAC mode')
  }
}

function alarmUnloggedShadow(): void {
  logger.warn('system_config RBAC_MODE says shadow but the change journal does not; treating it as enforce')
  try {
    writeAdminAuditLog('system', 'security.rbac_shadow_unlogged', RBAC_MODE_KEY, {})
  } catch (err) {
    logger.warn({ err }, 'Could not journal the unlogged RBAC_MODE value')
  }
  notifyRbacMode(
    '[SECURITY] system_config RBAC_MODE was set to shadow without a Settings-page change in the journal. ' +
      'The RBAC gate stays in enforce mode. Check who wrote the row.',
  )
}

// unlogged = the row says shadow and the journal does not (the alarm case).
function readStoredMode(envMode: RbacMode | undefined): { mode: RbacMode; unlogged: boolean } {
  try {
    const row = getSystemConfig(RBAC_MODE_KEY)
    if (!row || parseRbacMode(row.value) !== 'shadow') return { mode: 'enforce', unlogged: false }
    // The env file tightens only: an explicit enforce there is the emergency brake.
    if (envMode === 'enforce') return { mode: 'enforce', unlogged: false }
    const last = getLastConfigChangeValue(RBAC_MODE_KEY)
    if (typeof last !== 'string' || parseRbacMode(last) !== 'shadow') return { mode: 'enforce', unlogged: true }
    return { mode: 'shadow', unlogged: false }
  } catch (err) {
    logger.warn({ err }, 'Could not read RBAC_MODE from system_config, using enforce')
    return { mode: 'enforce', unlogged: false }
  }
}

/** Re-read the row and replace the cached mode. envMode defaults to the process environment. */
export function refreshRbacMode(envMode: RbacMode | undefined = RBAC_MODE_ENV): RbacMode {
  const { mode, unlogged } = readStoredMode(envMode)
  // One alarm per episode: the flag clears as soon as the row stops being an unlogged shadow.
  if (unlogged && !unloggedShadowAlarmed) alarmUnloggedShadow()
  unloggedShadowAlarmed = unlogged
  if (mode !== cached) logger.warn({ from: cached, to: mode }, 'RBAC mode changed')
  cached = mode
  return cached
}

/**
 * One-time, idempotent boot step, called right after initDatabase(): seed the row from the env value
 * (no env value is an explicit enforce) with INSERT-if-absent, journal the seed, then read the live
 * mode. An existing row is never overwritten, so a second boot changes nothing.
 */
export function loadRbacMode(envMode: RbacMode | undefined = RBAC_MODE_ENV): RbacMode {
  try {
    const value: RbacMode = envMode ?? 'enforce'
    if (insertSystemConfigIfAbsent(RBAC_MODE_KEY, value, 'migrated_from_env')) {
      logConfigChange(RBAC_MODE_KEY, envMode ?? null, value, 'system:migration')
      logger.info({ value }, 'RBAC_MODE seeded into system_config from the environment')
    } else if (envMode === 'shadow') {
      logger.warn('env RBAC_MODE=shadow ignored, use the Settings page')
    }
  } catch (err) {
    logger.warn({ err }, 'RBAC_MODE seed into system_config failed')
  }
  return refreshRbacMode(envMode)
}

/** Start the periodic re-read. The timer is unref'd, so it never keeps the process alive. */
export function startRbacModeRefresh(envMode: RbacMode | undefined = RBAC_MODE_ENV): void {
  stopRbacModeRefresh()
  timer = setInterval(() => refreshRbacMode(envMode), REFRESH_INTERVAL_MS)
  timer.unref()
}

export function stopRbacModeRefresh(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

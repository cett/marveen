// Break-glass security reset (AUTHPLAN1 #5).
//
// One operation that returns dashboard access to its baseline: every device
// key revoked, every browser session cleared. Passwords and users are NOT
// touched (use dashboard-user reset-password/remove for those) and the bearer
// token keeps working -- this is the "some credential I handed out is loose,
// cut them all NOW" lever, not a factory reset.
//
// Future login-enforcement toggles (deferred to the next release) must be
// cleared here too, so a reset can never leave the operator locked out by a
// half-configured policy.
//
// Lives outside the CLI so the logic is unit-testable and reusable; the CLI
// (scripts/dashboard-user.ts security:reset) is a thin wrapper.

import { logConfigChange } from '../db.js'
import { revokeAllDeviceKeys } from './auth-device-keys.js'
import { revokeAllSessions } from './auth-sessions.js'

export interface SecurityResetResult {
  deviceKeysRevoked: number
  sessionsCleared: number
}

/**
 * `onDone`, when given, runs once the revocations have happened, in a finally: after the audit row, or after its failure
 * (the revocation is not undone by a failed audit write, so the caller's alert must still go out). It is not called when a
 * revocation itself fails (nothing was revoked that the alert could describe).
 */
export async function securityReset(actor: string, onDone?: (result: SecurityResetResult) => Promise<void>): Promise<SecurityResetResult> {
  const deviceKeysRevoked = await revokeAllDeviceKeys()
  const sessionsCleared = await revokeAllSessions()
  const result = { deviceKeysRevoked, sessionsCleared }
  try {
    // Counts only -- never credential material -- into the audit trail.
    await logConfigChange('security.reset', null, `device_keys=${deviceKeysRevoked} sessions=${sessionsCleared}`, actor)
  } finally {
    if (onDone) await onDone(result)
  }
  return result
}

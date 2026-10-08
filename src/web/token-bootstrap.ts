// Enrolls the file-based dashboard bearer token into the api_tokens table on
// first boot. After enrollment the DB-lookup path in auth-gate.ts resolves it
// with explicit role=admin and default tenant; the legacy file-token fallback
// still runs for any token NOT in the DB, keeping rollback trivial.
//
// Idempotent: INSERT OR IGNORE -- the UNIQUE constraint on token_hash means a
// second call (restart, redeploy) is a no-op with zero side effects.
//
// Rollback: DELETE FROM api_tokens WHERE name = 'dashboard'
// The fallback in auth-gate.ts (step 2 in the precedence list) immediately
// takes over -- no server restart required.

import { createHash } from 'node:crypto'
import { logger } from '../logger.js'
import { enrollDashboardApiToken } from '../db.js'

export function bootstrapDashboardToken(rawToken: string): void {
  try {
    const hash = createHash('sha256').update(rawToken).digest('hex')
    const now = Math.floor(Date.now() / 1000)
    if (enrollDashboardApiToken(hash, now) > 0) {
      logger.info('api_tokens: dashboard token enrolled (role=admin, no expiry)')
    }
  } catch (err) {
    // Non-fatal: the legacy file-token fallback in auth-gate.ts keeps working.
    logger.warn({ err }, 'api_tokens: dashboard token bootstrap failed -- using file-token fallback')
  }
}

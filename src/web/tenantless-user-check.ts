// Boot report of the dashboard users that break the tenant-less rule (db/user-tenant-rule.ts): no tenant, and a role
// (above all `agent`) that needs one.
//
// Report only. Nothing is changed, disabled or deleted: such a row predates the rule, and what to do with it (give it a
// tenant, change its role, disable it) is an admin's decision. The line carries the COUNT and nothing else: no username,
// no id, no tenant, no credential. One line per boot, none when the count is zero. Never throws into the boot.

import { logger } from '../logger.js'
import { countTenantlessWriteRoleUsers } from '../db/sessions.js'

/** Logs one warning with the count when it is above zero; returns the count (-1 when the count could not be read). */
export async function warnTenantlessWriteRoleUsers(): Promise<number> {
  let count: number
  try {
    count = await countTenantlessWriteRoleUsers()
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not count the dashboard users without a tenant that hold a role needing one')
    return -1
  }
  if (count > 0) {
    logger.warn({ count }, 'Dashboard users without a tenant hold a role that needs one (agent): give them a tenant or change their role in the Users tab')
  }
  return count
}

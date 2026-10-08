// The tenant a telemetry or journal row is stamped with at the place it is written (Phase 0 of the
// PostgreSQL move; the columns come from migration 0077). The same rule for every writer, so a
// row of a shared agent never lands in the wrong tenant and an unresolved one is visibly NULL.

import { getServedTenantIds } from './agents.js'
import { db } from './connection.js'
import { getServingTenant } from './tenant-channel-bindings.js'

/**
 * Tenant of the work an agent is doing right now:
 *   1. the fresh tenant context of the request it is serving (agent_tenant_context), the truth at
 *      the write site;
 *   2. otherwise, when the agent serves exactly one tenant, that tenant (nothing to guess), and
 *      'default' when it serves none (a fleet-internal agent);
 *   3. otherwise NULL: a shared agent with no fresh context. The row says "unknown", it is not
 *      filed under 'default'.
 * No agent id (a system writer) is NULL as well.
 */
export function resolveWriteTenant(agentId: string | null | undefined): string | null {
  if (!agentId) return null
  const serving = getServingTenant(agentId)
  if (serving) return serving
  const served = getServedTenantIds(agentId)
  if (served.length === 0) return 'default'
  return served.length === 1 ? served[0]! : null
}

/** Tenant of a dashboard user, for the rows an admin action writes (agent_audit_log keeps the user
 *  name in agent_id). The global admin has no tenant: NULL. */
export function dashboardUserTenant(username: string): string | null {
  const row = db
    .prepare('SELECT tenant_id FROM dashboard_users WHERE lower(username) = lower(?)')
    .get(username) as { tenant_id: string | null } | undefined
  return row?.tenant_id ?? null
}

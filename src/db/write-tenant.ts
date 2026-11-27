// The tenant a telemetry or journal row is stamped with at the place it is written (Phase 0 of the
// PostgreSQL move; the columns come from migration 0077). The same rule for every writer, so a
// row of a shared agent never lands in the wrong tenant and an unresolved one is visibly NULL.

import { getServedTenantIds } from './agents.js'
import { dbx } from './facade.js'
import { getServingTenantContext } from './tenant-channel-bindings.js'

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
export async function resolveWriteTenant(agentId: string | null | undefined): Promise<string | null> {
  return (await resolveInternal(agentId, false)).tenantId
}

/** The tenant of resolveWriteTenant, plus WHERE it came from, for a writer whose row is older than "now". */
export interface WriteTenantResolution {
  tenantId: string | null
  /**
   * Set only when the tenant came from the fresh context row AND the agent serves 2+ tenants (a shared agent): the context
   * row's updated_at (epoch seconds). Such a stamp is the tenant in force FROM that moment on; it says nothing about an earlier
   * time. null for every other source (one served tenant, none, no fresh context): those do not depend on the time.
   */
  sharedContextSince: number | null
}

/**
 * resolveWriteTenant with the facts a delayed writer needs (a spool-drained row decided earlier than it is written). The context
 * row is read ONCE: the tenant and its updated_at come from the same read, never from a resolve followed by a second read.
 */
export async function resolveWriteTenantAt(agentId: string | null | undefined): Promise<WriteTenantResolution> {
  return resolveInternal(agentId, true)
}

// `withSince` is false for the plain resolver: it must not pay the extra served-tenants read the delayed writer needs.
async function resolveInternal(agentId: string | null | undefined, withSince: boolean): Promise<WriteTenantResolution> {
  if (!agentId) return { tenantId: null, sharedContextSince: null }
  const serving = await getServingTenantContext(agentId)
  if (serving) {
    if (!withSince) return { tenantId: serving.tenantId, sharedContextSince: null }
    const served = await getServedTenantIds(agentId)
    return { tenantId: serving.tenantId, sharedContextSince: served.length > 1 ? serving.updatedAt : null }
  }
  const served = await getServedTenantIds(agentId)
  if (served.length === 0) return { tenantId: 'default', sharedContextSince: null }
  return { tenantId: served.length === 1 ? served[0]! : null, sharedContextSince: null }
}

/** Tenant of a dashboard user, for the rows an admin action writes (agent_audit_log keeps the user
 *  name in agent_id). The global admin has no tenant: NULL. */
export async function dashboardUserTenant(username: string): Promise<string | null> {
  const row = await dbx.get<{ tenant_id: string | null }>('SELECT tenant_id FROM dashboard_users WHERE lower(username) = lower(?)', username)
  return row?.tenant_id ?? null
}

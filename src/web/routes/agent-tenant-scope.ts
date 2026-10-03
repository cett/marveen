import type { RouteContext } from './types.js'
import { getEnabledAgentsForTenant, isTenantAgentEnabled } from '../../db.js'

// One definition of "which agents may this caller see", shared by every
// agent-reading endpoint so the Agents grid, the org chart and the per-agent
// sub-resources can never drift apart again (the org chart once listed every
// agent while the grid was correctly scoped).
//
// Rule: admin sees everything. Any other role -- including an unresolved one --
// sees only the agents explicitly enabled=1 for its tenant in
// tenant_agent_availability (deny-by-default, see
// 0026_tenant_agent_availability.sql). The check is on the role, never on
// tenantId === null (see RouteContext.tenantId).

type Caller = Pick<RouteContext, 'role' | 'tenantId'>

export function isAdminCaller(ctx: Caller): boolean {
  return ctx.role === 'admin'
}

/** Names the caller may see; null means "no filter" (admin). */
export function visibleAgentSet(ctx: Caller): Set<string> | null {
  if (isAdminCaller(ctx)) return null
  return new Set(getEnabledAgentsForTenant(ctx.tenantId ?? 'default'))
}

export function callerCanSeeAgent(ctx: Caller, name: string): boolean {
  if (isAdminCaller(ctx)) return true
  return isTenantAgentEnabled(ctx.tenantId ?? 'default', name)
}

/** Narrow the tenant-membership fields of an agent summary to what the caller
 *  may know. Admin gets them untouched. Everyone else keeps only their OWN
 *  tenant: an agent shared with another tenant must not reveal that tenant's
 *  id or display name. */
export function scopeTenantFieldsToCaller<T extends {
  primaryTenantId?: string | null
  tenantIds?: string[]
  tenantNames?: Record<string, string>
}>(summary: T, ctx: Caller): T {
  if (isAdminCaller(ctx)) return summary
  const own = ctx.tenantId ?? 'default'
  const out: T = { ...summary }
  if (out.tenantIds !== undefined) out.tenantIds = out.tenantIds.filter(id => id === own)
  if (out.tenantNames !== undefined) {
    out.tenantNames = own in out.tenantNames ? { [own]: out.tenantNames[own] } : {}
  }
  if (out.primaryTenantId !== undefined && out.primaryTenantId !== own) out.primaryTenantId = null
  return out
}

// One line of `npm run dashboard-user -- list`, kept out of the CLI so it can be tested without running it.
//
// The line names the role and the tenant because they decide what a login may do: a human-only approval
// is decided only by a global admin (role admin, no tenant), and the owner needs to confirm that from the
// machine, without the dashboard, before enforcement is switched on.

import type { DashboardUserPublic } from '../../src/db/sessions.js'

/** "tenant=global" for the user with no tenant, "tenant=<id>" otherwise. */
export function formatTenant(tenantId: string | null | undefined): string {
  return tenantId ? `tenant=${tenantId}` : 'tenant=global'
}

export function formatUserLine(u: Pick<DashboardUserPublic, 'username' | 'role' | 'tenant_id' | 'created_at' | 'disabled'>): string {
  const created = new Date(u.created_at * 1000).toISOString()
  return `${u.username}${u.disabled ? ' (disabled)' : ''}  role=${u.role}  ${formatTenant(u.tenant_id)}  created ${created}`
}

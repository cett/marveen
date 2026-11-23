// The one rule about a dashboard user without a tenant (tenant_id NULL, "global").
//
// A tenant-less user may hold only a role that carries no tenant data access: `admin` (the
// cross-tenant operator), `viewer` and `read_only` (reads that the routes scope or filter). Any other
// role, above all `agent` (the tenant user who writes kanban, memories and messages), needs a tenant:
// without one the request context has no tenant to run as, and the database layer would have to
// guess. The list is an allowlist, so a role added later is refused until it is named here (fail
// closed), and an unknown or empty role is refused too.
//
// The admin routes already refuse every tenant-less non-admin (a stricter, route-level rule); this is
// the rule at the data layer, so a caller that is not that route (an import, a script, a later
// provisioning path) cannot create the row either. It is not a migration: existing rows are not
// changed, only counted at boot (countTenantlessWriteRoleUsers in sessions.ts).

export const TENANTLESS_ROLES = ['admin', 'viewer', 'read_only'] as const

/** True when the role must have a tenant (every role that is not in the tenant-less allowlist). */
export function roleNeedsTenant(role: string): boolean {
  return !(TENANTLESS_ROLES as readonly string[]).includes(role)
}

/** A role that needs a tenant was given none. Typed so a caller can answer it without parsing a message. */
export class TenantlessRoleError extends Error {
  readonly code = 'tenantless_role'
  constructor(readonly role: string) {
    super(`a user without a tenant cannot hold the role '${role}'`)
    this.name = 'TenantlessRoleError'
  }
}

/**
 * The ONE reading of "no tenant": null, undefined, or a string that is empty after JavaScript's trim() (spaces, tabs,
 * newlines, the no-break space and the other Unicode whitespace). Every judgment about a stored or given tenant uses it,
 * in JavaScript: the writers and the boot count read the value and decide here, never with a SQL TRIM, which strips
 * spaces only and differs between SQLite and PostgreSQL in what else it takes.
 */
export function isBlankTenant(tenantId: string | null | undefined): boolean {
  return tenantId == null || tenantId.trim() === ''
}

/** Throws TenantlessRoleError when the (role, tenant) pair breaks the rule. */
export function assertTenantForRole(role: string, tenantId: string | null | undefined): void {
  if (isBlankTenant(tenantId) && roleNeedsTenant(role)) throw new TenantlessRoleError(role)
}

/** The allowlist as an SQL list literal for a fixed internal constant, never for caller input. */
export const TENANTLESS_ROLES_SQL_LIST = TENANTLESS_ROLES.map((r) => `'${r}'`).join(', ')

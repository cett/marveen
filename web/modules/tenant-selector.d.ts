/**
 * Insert a tenant-filter <select> into the element identified by containerId.
 * Only renders for global admin sessions (role=admin, tenant_id=null).
 *
 * @returns a getter `() => string | null` for the selected tenantId,
 *          or null if the caller is not a global admin.
 */
export function initTenantSelector(
  containerId: string,
  onChange: (tenantId: string | null) => void,
): Promise<(() => string | null) | null>

/**
 * Enabled tenants for a global admin session; [] for any other caller.
 */
export function fetchAdminTenants(): Promise<{ id: string; display_name?: string }[]>

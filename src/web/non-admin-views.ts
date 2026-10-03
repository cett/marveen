// What a non-admin session may read from the two boot-time endpoints every dashboard session calls:
// GET /api/marveen (brand and agent name, kanban display config) and GET /api/settings (the UI language).
// Allowlists, not blocklists: a field added to either response later stays admin-only until someone
// puts it here on purpose. The admin (and the legacy bearer token, which resolves to admin) still gets
// the full response.

/** GET /api/marveen fields a non-admin sees: identity for the chrome and the kanban display config. */
export const NON_ADMIN_MARVEEN_FIELDS = [
  'name', 'brandName', 'agentId', 'role', 'channelProvider',
  'kanbanAging', 'kanbanWip', 'kanbanSwimlanes', 'kanbanLabels',
] as const

/** GET /api/settings keys a non-admin sees (the dashboard reads the language at boot). */
export const NON_ADMIN_SETTING_KEYS: readonly string[] = ['DASHBOARD_LANG']

/** The setting row fields a non-admin sees. Descriptions, module and bounds stay with the admin UI. */
export const NON_ADMIN_SETTING_ROW_FIELDS = ['key', 'type', 'value', 'default'] as const

export function pickFields<T extends Record<string, unknown>>(obj: T, fields: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f]
  return out as Partial<T>
}

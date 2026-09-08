// Read-only mirror of src/web/rbac.ts's ROLE_PERMISSIONS, grouped for the
// dashboard's Users-tab permission matrix (admin-b2b.js renderPermissionMatrix).
//
// This is a manually-kept mirror, not a live fetch: the matrix is static
// config, and a backend endpoint would only add indirection for data that
// changes at the same pace as this file's own edits. Drift is caught by
// src/__tests__/rbac-permission-matrix-data.test.ts, which asserts every
// role/permission cell here matches rbac.ts's hasPermission() -- if rbac.ts
// changes, update PERMISSION_MATRIX_CATEGORIES in the same PR or that test fails.

export const PERMISSION_MATRIX_ROLES = ['admin', 'agent', 'read_only', 'viewer']

export const PERMISSION_MATRIX_CATEGORIES = [
  {
    key: 'memory',
    permissions: [
      { key: 'memories:read', roles: { admin: true, agent: true, read_only: true, viewer: true } },
      { key: 'memories:write', roles: { admin: true, agent: true, read_only: false, viewer: false } },
    ],
  },
  {
    key: 'kanban',
    permissions: [
      { key: 'kanban:read', roles: { admin: true, agent: true, read_only: true, viewer: true } },
      { key: 'kanban:write', roles: { admin: true, agent: true, read_only: false, viewer: false } },
    ],
  },
  {
    key: 'agents',
    permissions: [
      { key: 'agents:read', roles: { admin: true, agent: true, read_only: true, viewer: true } },
      { key: 'messages:write', roles: { admin: true, agent: true, read_only: false, viewer: false } },
      { key: 'blackboard:read', roles: { admin: true, agent: true, read_only: true, viewer: true } },
      { key: 'blackboard:write', roles: { admin: true, agent: true, read_only: false, viewer: false } },
    ],
  },
  {
    key: 'approvals',
    permissions: [
      { key: 'approvals:read', roles: { admin: true, agent: true, read_only: true, viewer: true } },
      { key: 'approvals:write', roles: { admin: true, agent: false, read_only: true, viewer: true } },
    ],
  },
  {
    key: 'federation',
    permissions: [
      { key: 'federation:read', roles: { admin: true, agent: true, read_only: false, viewer: false } },
      { key: 'federation:write', roles: { admin: true, agent: true, read_only: false, viewer: false } },
    ],
  },
  {
    key: 'admin',
    permissions: [
      { key: 'admin:all', roles: { admin: true, agent: false, read_only: false, viewer: false } },
    ],
  },
]

// 'memories:read' -> 'memories.read' (matches the 'admin.b2b.perm.<...>.label/.desc' i18n keys).
export function permissionI18nKeyPart(permissionKey) {
  return permissionKey.replace(':', '.')
}

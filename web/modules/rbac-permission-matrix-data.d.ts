export type PermissionMatrixRole = 'admin' | 'agent' | 'read_only' | 'viewer'

export interface PermissionMatrixEntry {
  key: string
  roles: Record<PermissionMatrixRole, boolean>
}

export interface PermissionMatrixCategory {
  key: string
  permissions: PermissionMatrixEntry[]
}

export const PERMISSION_MATRIX_ROLES: readonly PermissionMatrixRole[]
export const PERMISSION_MATRIX_CATEGORIES: readonly PermissionMatrixCategory[]

/** 'memories:read' -> 'memories.read' (i18n key part). */
export function permissionI18nKeyPart(permissionKey: string): string

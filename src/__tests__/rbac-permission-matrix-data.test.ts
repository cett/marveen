// Drift guard for the dashboard's Users-tab permission matrix.
// web/modules/rbac-permission-matrix-data.js is a manually-kept JS mirror of
// rbac.ts's ROLE_PERMISSIONS (chosen over a live API endpoint -- see that
// file's header comment). This test is what keeps the mirror honest: it
// walks every role/permission cell in the mirror and asserts it matches
// hasPermission() from the real rbac.ts. If rbac.ts changes without updating
// the mirror, this test fails in CI.
import { describe, it, expect } from 'vitest'
import { ALL_ROLES, hasPermission, type Permission, type Role } from '../web/rbac.js'
import {
  PERMISSION_MATRIX_ROLES,
  PERMISSION_MATRIX_CATEGORIES,
} from '../../web/modules/rbac-permission-matrix-data.js'

const ALL_PERMISSIONS: Permission[] = [
  'memories:read',
  'memories:write',
  'kanban:read',
  'kanban:write',
  'agents:read',
  'messages:write',
  'approvals:read',
  'approvals:write',
  'blackboard:read',
  'blackboard:write',
  'admin:all',
  'federation:read',
  'federation:write',
]

describe('rbac-permission-matrix-data mirror vs rbac.ts (drift guard)', () => {
  it('mirrors ALL_ROLES exactly', () => {
    expect([...PERMISSION_MATRIX_ROLES].sort()).toEqual([...ALL_ROLES].sort())
  })

  it('covers every Permission exactly once, and no unknown permission', () => {
    const mirrored = PERMISSION_MATRIX_CATEGORIES.flatMap((c) => c.permissions.map((p) => p.key))
    expect([...mirrored].sort()).toEqual([...ALL_PERMISSIONS].sort())
  })

  it('every category has a non-empty key and at least one permission', () => {
    for (const category of PERMISSION_MATRIX_CATEGORIES) {
      expect(category.key).toBeTruthy()
      expect(category.permissions.length).toBeGreaterThan(0)
    }
  })

  it('every mirrored role/permission cell matches hasPermission() in rbac.ts', () => {
    const mismatches: string[] = []
    for (const category of PERMISSION_MATRIX_CATEGORIES) {
      for (const perm of category.permissions) {
        for (const role of PERMISSION_MATRIX_ROLES as Role[]) {
          const mirrored = perm.roles[role]
          const actual = hasPermission(role, perm.key as Permission)
          if (mirrored !== actual) {
            mismatches.push(`${role} x ${perm.key}: mirror=${mirrored} rbac.ts=${actual}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})

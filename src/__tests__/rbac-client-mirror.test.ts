// Drift guard for web/modules/rbac-client.js. Its role -> permission map is kept by hand and only
// decides which controls the dashboard shows, so a stale copy would hide or expose a button
// against what the server allows without any server-side symptom. This walks every role and every
// permission of rbac.ts against it.
import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, ALL_ROLES, hasPermission } from '../web/rbac.js'
import { ROLE_PERMISSIONS } from '../../web/modules/rbac-client.js'

describe('rbac-client ROLE_PERMISSIONS vs rbac.ts', () => {
  it('has exactly the roles of rbac.ts', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ALL_ROLES].sort())
  })

  it.each([...ALL_ROLES])('%s holds exactly the permissions rbac.ts grants it', (role) => {
    const server = ALL_PERMISSIONS.filter(p => hasPermission(role, p)).sort()
    const client = [...(ROLE_PERMISSIONS[role] ?? [])].sort()
    expect(client).toEqual(server)
  })

  it('names no permission rbac.ts does not know', () => {
    const known = new Set<string>(ALL_PERMISSIONS)
    const unknown = Object.values(ROLE_PERMISSIONS).flatMap(set => [...set]).filter(p => !known.has(p))
    expect(unknown).toEqual([])
  })
})

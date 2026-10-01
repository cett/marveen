// RBAC rows for /api/admin/tenants/:id/starter-pack, through the real table and the real gate.
// The route is admin:all through the /api/admin/ prefix, in both the legacy and the /api/v1 spelling.
// The role check inside the route (covered in tenant-starter-pack.test.ts) is what holds in shadow mode.
import { describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { applyRbacGate } from '../web/authz.js'
import { ALL_ROLES, resolveRequiredPermission, type Role } from '../web/rbac.js'
import type { AuthResult } from '../web/auth-gate.js'

const res = () => ({ writeHead: vi.fn(), end: vi.fn() }) as unknown as http.ServerResponse
const sessionOf = (role: Role): AuthResult => ({ kind: 'session', user: 'u', role, tenantId: 'tenant-b' })

describe('starter-pack routes need admin:all', () => {
  it.each([
    ['POST', '/api/admin/tenants/acme/starter-pack'],
    ['GET', '/api/admin/tenants/acme/starter-pack'],
    ['POST', '/api/v1/admin/tenants/acme/starter-pack'],
    ['GET', '/api/v1/admin/tenants/acme/starter-pack'],
  ])('%s %s', (method, path) => {
    expect(resolveRequiredPermission(method, path)).toBe('admin:all')
  })

  it.each([...ALL_ROLES])('%s in enforce mode: only admin passes', (role) => {
    for (const [method, path] of [['POST', '/api/admin/tenants/acme/starter-pack'], ['GET', '/api/admin/tenants/acme/starter-pack']] as const) {
      expect(applyRbacGate(sessionOf(role), method, path, res(), 'enforce')).toBe(role === 'admin')
    }
  })
})

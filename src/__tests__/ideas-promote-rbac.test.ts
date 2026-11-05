// The two idea-promotion routes write kanban cards (the promoted card and, for promote-breakdown, one child card per
// approved subtask with a body-supplied assignee) without any tenant check of their own: they are safe only because
// the RBAC table leaves them unlisted, which makes them admin:all. This test pins that. A later RBAC row that opens
// either route to a fleet agent or a tenant user would hand them a way to name another tenant's agent on a card, so the
// row must come with the tenant check in ideas.ts (and this test changed on purpose).
import { describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { applyRbacGate } from '../web/authz.js'
import { ALL_ROLES, hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import type { AuthResult } from '../web/auth-gate.js'

const res = () => ({ writeHead: vi.fn(), end: vi.fn() }) as unknown as http.ServerResponse
const sessionOf = (role: Role): AuthResult => ({ kind: 'session', user: 'user-a', role, tenantId: 'tenant-b' })

const ROUTES = [
  ['POST', '/api/ideas/idea-a/promote'],
  ['POST', '/api/ideas/idea-a/promote-breakdown'],
  ['POST', '/api/v1/ideas/idea-a/promote'],
  ['POST', '/api/v1/ideas/idea-a/promote-breakdown'],
] as const

// every role that can call the API: the four dashboard-user roles and the fleet agent's token role
const ROLES: Role[] = [...ALL_ROLES, 'fleet_agent']

describe('the idea promotion routes are admin only', () => {
  // an unlisted route has no row (null) and the gate then requires admin:all; a row that names anything else is the change this test stops
  it.each(ROUTES)('%s %s needs admin:all (unlisted, or listed as admin:all)', (method, path) => {
    expect(resolveRequiredPermission(method, path) ?? 'admin:all').toBe('admin:all')
  })

  it.each(ROUTES)('%s %s: no role but the admin holds the permission (fleet_agent, agent, read_only, viewer are out)', (method, path) => {
    const required = resolveRequiredPermission(method, path) ?? 'admin:all'
    for (const role of ROLES) {
      expect(hasPermission(role, required), `${role} on ${path}`).toBe(role === 'admin')
    }
  })

  it.each(ALL_ROLES.map((r) => [r]))('%s in enforce mode through the real gate: only the admin passes', (role) => {
    for (const [method, path] of ROUTES) {
      expect(applyRbacGate(sessionOf(role), method, path, res(), 'enforce'), `${role} ${path}`).toBe(role === 'admin')
    }
  })
})

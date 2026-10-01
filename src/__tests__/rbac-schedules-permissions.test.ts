// RBAC rows for /api/schedules*, through the real table and the real gate (no mocks).
// Each row is asserted twice over: the permission the path resolves to, and what every role
// would get from the gate in enforce mode. The activate and tick-status rows exist because the
// prefix rows next to them would otherwise cover them.
import { describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { applyRbacGate } from '../web/authz.js'
import { ALL_ROLES, hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import type { AuthResult } from '../web/auth-gate.js'

const res = () => ({ writeHead: vi.fn(), end: vi.fn() }) as unknown as http.ServerResponse
const sessionOf = (role: Role): AuthResult => ({ kind: 'session', user: 'u', role, tenantId: 'tenant-b' })
const enforced = (auth: AuthResult, method: string, path: string) => applyRbacGate(auth, method, path, res(), 'enforce')

describe('which permission each schedules route needs', () => {
  it.each([
    ['GET', '/api/schedules', 'schedules:read'],
    ['GET', '/api/schedules/agents', 'schedules:read'],
    ['GET', '/api/schedules/pending', 'schedules:read'],
    ['GET', '/api/schedules/my-task/runs', 'schedules:read'],
    ['POST', '/api/schedules', 'schedules:write'],
    ['POST', '/api/schedules/my-task/toggle', 'schedules:write'],
    ['POST', '/api/schedules/my-task/run', 'schedules:write'],
    ['POST', '/api/schedules/expand-questions', 'schedules:write'],
    ['POST', '/api/schedules/expand-prompt', 'schedules:write'],
    ['PUT', '/api/schedules/my-task', 'schedules:write'],
    ['DELETE', '/api/schedules/my-task', 'schedules:write'],
    ['DELETE', '/api/schedules/pending/12', 'schedules:write'],
  ])('%s %s -> %s', (method, path, permission) => {
    expect(resolveRequiredPermission(method, path)).toBe(permission)
  })

  it('activation and tick-status are admin-only, not swallowed by the prefix rows', () => {
    expect(resolveRequiredPermission('POST', '/api/schedules/my-task/activate')).toBe('admin:all')
    expect(resolveRequiredPermission('GET', '/api/schedules/tick-status')).toBe('admin:all')
  })

  it('a schedule literally named like an action does not slip past: only the exact shapes are special', () => {
    expect(resolveRequiredPermission('GET', '/api/schedules/activate')).toBe('schedules:read')
    expect(resolveRequiredPermission('POST', '/api/schedules/a/b/activate')).toBe('schedules:write')
  })
})

describe('what each role gets in enforce mode', () => {
  const matrix: Array<[Role, { read: boolean; write: boolean; activate: boolean }]> = [
    ['admin', { read: true, write: true, activate: true }],
    ['agent', { read: true, write: true, activate: false }],
    ['read_only', { read: true, write: false, activate: false }],
    ['viewer', { read: true, write: false, activate: false }],
  ]

  it.each(matrix)('%s', (role, want) => {
    const auth = sessionOf(role)
    expect(enforced(auth, 'GET', '/api/schedules')).toBe(want.read)
    expect(enforced(auth, 'PUT', '/api/schedules/my-task')).toBe(want.write)
    expect(enforced(auth, 'POST', '/api/schedules')).toBe(want.write)
    expect(enforced(auth, 'DELETE', '/api/schedules/my-task')).toBe(want.write)
    expect(enforced(auth, 'POST', '/api/schedules/my-task/activate')).toBe(want.activate)
  })

  it('tick-status stays admin-only for every other role', () => {
    for (const role of ALL_ROLES) {
      expect(enforced(sessionOf(role), 'GET', '/api/schedules/tick-status')).toBe(role === 'admin')
    }
  })

  it('the shared admin token (legacy file token) keeps full access', () => {
    const token: AuthResult = { kind: 'token' }
    expect(enforced(token, 'PUT', '/api/schedules/my-task')).toBe(true)
    expect(enforced(token, 'POST', '/api/schedules/my-task/activate')).toBe(true)
  })

  it('a denied write answers 403 and does not reach the route', () => {
    const r = res()
    expect(applyRbacGate(sessionOf('viewer'), 'PUT', '/api/schedules/my-task', r, 'enforce')).toBe(false)
    expect((r.writeHead as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(403)
  })
})

describe('shadow mode only reports', () => {
  it('a viewer write is let through and logged as would-deny', () => {
    const onWouldDeny = vi.fn()
    expect(applyRbacGate(sessionOf('viewer'), 'PUT', '/api/schedules/my-task', res(), 'shadow', onWouldDeny)).toBe(true)
    expect(onWouldDeny).toHaveBeenCalledOnce()
    expect(onWouldDeny.mock.calls[0]![0]).toContain('schedules:write')
  })

  it('the agent role is no longer a would-deny on schedules, an admin-only activate still is', () => {
    const onWouldDeny = vi.fn()
    applyRbacGate(sessionOf('agent'), 'PUT', '/api/schedules/my-task', res(), 'shadow', onWouldDeny)
    expect(onWouldDeny).not.toHaveBeenCalled()
    applyRbacGate(sessionOf('agent'), 'POST', '/api/schedules/my-task/activate', res(), 'shadow', onWouldDeny)
    expect(onWouldDeny).toHaveBeenCalledOnce()
  })
})

describe('role sets', () => {
  it('only admin and agent can write schedules; everyone can read', () => {
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, 'schedules:read')).toBe(true)
      expect(hasPermission(role, 'schedules:write')).toBe(role === 'admin' || role === 'agent')
    }
  })
})

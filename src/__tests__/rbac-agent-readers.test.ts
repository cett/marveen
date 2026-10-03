// The agent readers against the real endpoint table in enforce mode: the
// tenant-scoped org chart and activity are readable by every role that can read
// the agent list, the agent bundles are not.
import { describe, it, expect, vi } from 'vitest'
import type http from 'node:http'
import { applyRbacGate } from '../web/authz.js'
import type { AuthResult } from '../web/auth-gate.js'
import type { Role } from '../web/rbac.js'

function gate(role: Role, method: string, path: string): { allowed: boolean; status: number | null } {
  let status: number | null = null
  const res = { writeHead: vi.fn((c: number) => { status = c }), end: vi.fn() } as unknown as http.ServerResponse
  const auth = { kind: 'token', role } as AuthResult
  return { allowed: applyRbacGate(auth, method, path, res, 'enforce'), status }
}

const TENANT_ROLES: Role[] = ['agent', 'viewer', 'read_only']

describe('enforce-mode gate on the agent readers', () => {
  for (const role of TENANT_ROLES) {
    for (const path of ['/api/team/graph', '/api/v1/team/graph', '/api/agents', '/api/agents/activity', '/api/agents/some-agent/team']) {
      it(`${role} may GET ${path}`, () => {
        expect(gate(role, 'GET', path)).toEqual({ allowed: true, status: null })
      })
    }
    for (const path of ['/api/agents/export-all', '/api/v1/agents/export-all', '/api/agents/some-agent/export', '/api/v1/agents/some-agent/export']) {
      it(`${role} is refused GET ${path} (403)`, () => {
        expect(gate(role, 'GET', path)).toEqual({ allowed: false, status: 403 })
      })
    }
  }

  it('the reporting-line edit stays admin-only', () => {
    for (const role of TENANT_ROLES) {
      expect(gate(role, 'PUT', '/api/agents/some-agent/team').allowed).toBe(false)
    }
  })

  it('admin may read everything above', () => {
    for (const path of ['/api/team/graph', '/api/agents/export-all', '/api/agents/some-agent/export']) {
      expect(gate('admin', 'GET', path).allowed).toBe(true)
    }
  })
})

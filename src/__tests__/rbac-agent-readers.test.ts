// The agent bundle routes against the real endpoint table in enforce mode: they
// carry an agent's instruction files and, with ?secrets=1, its vault secrets, so
// no tenant role may reach them.
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

describe('enforce-mode gate on the agent bundle routes', () => {
  for (const role of TENANT_ROLES) {
    for (const path of ['/api/agents/export-all', '/api/v1/agents/export-all', '/api/agents/some-agent/export', '/api/v1/agents/some-agent/export']) {
      it(`${role} is refused GET ${path} (403)`, () => {
        expect(gate(role, 'GET', path)).toEqual({ allowed: false, status: 403 })
      })
    }
    it(`${role} can still read the agent list and a single agent`, () => {
      expect(gate(role, 'GET', '/api/agents').allowed).toBe(true)
      expect(gate(role, 'GET', '/api/agents/some-agent').allowed).toBe(true)
    })
  }

  it('admin may export', () => {
    for (const path of ['/api/agents/export-all', '/api/agents/some-agent/export']) {
      expect(gate('admin', 'GET', path).allowed).toBe(true)
    }
  })
})

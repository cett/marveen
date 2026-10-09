// The fleet_agent role and its plumbing permissions: who holds what, and the wiring in web.ts that the
// request tests of fleet-agent-tokens.test.ts cannot see (they chain the gate pieces by hand).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALL_PERMISSIONS, ALL_ROLES, FLEET_AGENT_PERMISSIONS, ENDPOINT_PERMISSION_TABLE, hasPermission,
  resolveRequiredPermission, type Permission, type Role,
} from '../web/rbac.js'

const HUMAN_NON_ADMIN: Role[] = ['agent', 'read_only', 'viewer']

describe('the fleet_agent role', () => {
  it('is not a role a dashboard user can hold: ALL_ROLES (the Users tab and its mirrors) is the four user roles', () => {
    expect([...ALL_ROLES]).toEqual(['admin', 'agent', 'read_only', 'viewer'])
    expect(ALL_ROLES).not.toContain('fleet_agent')
  })

  it('holds no admin:all, no agents:write and no federation permission', () => {
    for (const p of ['admin:all', 'agents:write', 'federation:read', 'federation:write'] as Permission[]) {
      expect(hasPermission('fleet_agent', p), p).toBe(false)
    }
  })

  it('holds every plumbing permission; so does admin; no tenant-user role does', () => {
    for (const p of FLEET_AGENT_PERMISSIONS) {
      expect(hasPermission('fleet_agent', p), `fleet_agent ${p}`).toBe(true)
      expect(hasPermission('admin', p), `admin ${p}`).toBe(true)
      for (const r of HUMAN_NON_ADMIN) expect(hasPermission(r, p), `${r} ${p}`).toBe(false)
    }
  })

  it('keeps the plumbing permissions out of ALL_PERMISSIONS (the dashboard matrix mirrors that list)', () => {
    for (const p of FLEET_AGENT_PERMISSIONS) expect((ALL_PERMISSIONS as readonly string[]).includes(p), p).toBe(false)
  })

  it('every permission a table row names is a known permission, and every plumbing permission has a row', () => {
    const known = new Set<string>([...ALL_PERMISSIONS, ...FLEET_AGENT_PERMISSIONS])
    const used = new Set(ENDPOINT_PERMISSION_TABLE.map(e => e.permission))
    for (const p of used) expect(known.has(p), p).toBe(true)
    for (const p of FLEET_AGENT_PERMISSIONS) expect(used.has(p), `no endpoint row for ${p}`).toBe(true)
  })

  it('adds nothing for a tenant user: the plumbing paths stay admin-only for them', () => {
    const paths: [string, string][] = [
      ['GET', '/api/conversation-ledger/x/recent'], ['POST', '/api/conversation-ledger'], ['PUT', '/api/agent-state/x/k'],
      ['POST', '/api/daily-log'], ['POST', '/api/hook-audit'], ['GET', '/api/artifacts'], ['PUT', '/api/skills/sql/x'],
      ['GET', '/api/autonomy'], ['GET', '/api/egress-allowlist'],
    ]
    for (const [m, p] of paths) {
      const need = resolveRequiredPermission(m, p)
      expect(need, `${m} ${p}`).not.toBeNull()
      for (const r of HUMAN_NON_ADMIN) expect(hasPermission(r, need!), `${r} ${m} ${p}`).toBe(false)
    }
  })

  it('keeps the listing and admin sub-resources admin-only', () => {
    for (const [m, p] of [['GET', '/api/hook-audit'], ['POST', '/api/hook-audit/prune'], ['GET', '/api/skills/sql/x/access'], ['PUT', '/api/skills/sql/x/access/t'], ['DELETE', '/api/skills/sql/x/access/t']] as const) {
      expect(resolveRequiredPermission(m, p) ?? 'admin:all', `${m} ${p}`).toBe('admin:all')
    }
  })
})

describe('web.ts wiring', () => {
  const WEB_SRC = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')

  it('refuses a token with no tenant context before the RBAC gate runs (so it holds in shadow mode)', () => {
    const refusal = WEB_SRC.indexOf('auth.tenantContextMissing')
    const gate = WEB_SRC.indexOf('runRbacGate(auth')
    expect(refusal).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(refusal)
  })

  it('hands the token agent to the routes and lets it override the self-reported header for a fleet_agent', () => {
    expect(WEB_SRC).toMatch(/tokenAgentId = auth\.kind === 'token' \? auth\.agentId : undefined/)
    expect(WEB_SRC).toMatch(/role === 'fleet_agent' && tokenAgentId \? tokenAgentId : resolveAgentIdHeader\(req\)/)
    expect(WEB_SRC).toMatch(/agentId, tokenAgentId \}/)
  })
})

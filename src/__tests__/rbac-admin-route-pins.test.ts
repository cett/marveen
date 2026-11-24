// Route pins of the row-level-security work (structural cells, the method of federation-config-rbac.test.ts).
//
// (1) Three routes resolve to admin:all: the agent delete and the terminal-input master toggle have no row in the endpoint
//     table (the unmapped fallback), the tenant gate status sits under the /api/admin/ prefix row. Nothing names the first
//     two as admin only, so a broad row added later would open them silently. Each is measured here through the REAL runRbacGate in enforce mode:
//     a tenant agent session, a viewer, a read_only session, a device key and a fleet agent token get a 403 written and the
//     gate returns false; the admin token and an admin session pass.
// (2) Every GET route of routes/federation.ts is on a named list of known read routes (and the secret-bearing one, the
//     peer's inbound token, is admin:all). A GET added later, for example one that returns a secret, fails the cell until
//     someone classifies it on purpose: the GET prefix row stays federation:read, which the tenant agent role holds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRequiredPermission } from '../web/rbac.js'
import type { AuthResult } from '../web/auth-gate.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

const ADMIN_TOKEN: AuthResult = { kind: 'token' }
const ADMIN_SESSION: AuthResult = { kind: 'session', user: 'user-a', role: 'admin', tenantId: null }
const REFUSED: ReadonlyArray<readonly [string, AuthResult]> = [
  ['tenant agent session', { kind: 'session', user: 'user-b', role: 'agent', tenantId: 'tenant-a' }],
  ['viewer session', { kind: 'session', user: 'user-d', role: 'viewer', tenantId: 'tenant-a' }],
  ['read_only session', { kind: 'session', user: 'user-c', role: 'read_only', tenantId: 'tenant-a' }],
  ['device key', { kind: 'device', device: 'device-a', deviceId: 1 }],
  ['fleet agent token', { kind: 'token', role: 'fleet_agent', tenantId: 'default', agentId: 'agent-a' }],
]

// The gate writes a decision row for a refusal: a real in-memory database, as the shadow log tests do.
beforeEach(async () => {
  vi.resetModules()
  const dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})
afterEach(() => { vi.restoreAllMocks() })

function mockRes(): { res: http.ServerResponse; status: () => number | undefined } {
  const writeHead = vi.fn()
  const res = { writeHead, setHeader: vi.fn(), end: vi.fn() } as unknown as http.ServerResponse
  return { res, status: () => (writeHead.mock.calls[0] as [number] | undefined)?.[0] }
}

async function gate(auth: AuthResult, method: string, path: string): Promise<{ passed: boolean; status: number | undefined }> {
  const { runRbacGate } = await import('../web/rbac-shadow-log.js')
  const { res, status } = mockRes()
  const passed = await runRbacGate(auth, method, path, res, 'enforce')
  return { passed, status: status() }
}

// [method, path]: the routes with no table row, both the legacy alias and the canonical prefix where the route answers both.
const ROUTE_FILE_FACTS = {
  agentDelete: read('web/routes/agents-crud.ts'),
  agentStop: read('web/routes/agents-process.ts'),
  terminalInput: read('web/routes/agent-terminal.ts'),
  gateStatus: read('web/routes/tenant-gate-status.ts'),
}

describe('the three admin-only routes: the agent delete, the terminal-input toggle, the tenant gate status', () => {
  // The route files are read, so a renamed path makes the cell fail instead of pinning a path nobody serves.
  it('the paths below are the ones the route files serve', () => {
    expect(ROUTE_FILE_FACTS.agentDelete).toMatch(/agentMatch && method === 'DELETE'/)
    expect(ROUTE_FILE_FACTS.agentStop).toContain('/^\\/api\\/agents\\/([^/]+)\\/stop$/')
    expect(ROUTE_FILE_FACTS.terminalInput).toContain("path === '/api/terminal-input'")
    expect(ROUTE_FILE_FACTS.gateStatus).toContain("'/api/admin/tenant-gate-status'")
  })

  const ROUTES: ReadonlyArray<readonly [string, string]> = [
    ['DELETE', '/api/agents/agent-a'],
    ['DELETE', '/api/v1/agents/agent-a'],
    // The second caller of the desired-state removal (the first is the delete above): under row-level security the
    // removal is a write on a global table, so a tenant caller must not reach it.
    ['POST', '/api/agents/agent-a/stop'],
    ['POST', '/api/v1/agents/agent-a/stop'],
    ['POST', '/api/terminal-input'],
    ['POST', '/api/v1/terminal-input'],
    ['GET', '/api/admin/tenant-gate-status'],
    ['GET', '/api/v1/admin/tenant-gate-status'],
    // The only chain that reaches `listEnabledTenantIds` outside the tenant admin routes (fleet-transfer.ts, the diff report
    // and the apply of an import): under row-level security the set would silently shrink to the caller's own tenant, which is
    // harmless only while a non-admin cannot reach it. Pinned so a later row cannot change that unnoticed.
    ['POST', '/api/fleet/import'],
    ['POST', '/api/v1/fleet/import'],
    ['GET', '/api/fleet/export'],
    ['GET', '/api/v1/fleet/export'],
  ]

  for (const [method, path] of ROUTES) {
    // null is the unmapped fallback, which the gate reads as admin:all (the agent delete and the terminal toggle have no row);
    // the tenant gate status sits under the /api/admin/ prefix row, which is admin:all too. Either way the answer is admin:all.
    it(`${method} ${path}: resolves to admin:all`, () => {
      expect(resolveRequiredPermission(method, path) ?? 'admin:all').toBe('admin:all')
    })

    for (const [label, auth] of REFUSED) {
      it(`${method} ${path}: ${label} gets 403 from the gate`, async () => {
        const r = await gate(auth, method, path)
        expect(r).toEqual({ passed: false, status: 403 })
      })
    }

    it(`${method} ${path}: the admin token and an admin session pass`, async () => {
      expect((await gate(ADMIN_TOKEN, method, path)).passed).toBe(true)
      expect((await gate(ADMIN_SESSION, method, path)).passed).toBe(true)
    })
  }
})

// The GET routes of routes/federation.ts, read from the source in the two forms it uses (a path literal, and a variable
// segment matched by a regex). A third form is noticed by the count of every `method === 'GET'`.
export function federationGetRoutes(src: string): { literals: string[]; matched: string[]; total: number } {
  const literals = [...src.matchAll(/path === '(\/api\/federation\/[^']+)' && method === 'GET'/g)].map((m) => m[1]!)
  const matched = [...src.matchAll(/const (\w+) = path\.match\((\/\^[^\n]*\$\/)\)\n\s+if \(\1 && method === 'GET'\)/g)].map((m) => m[2]!)
  const total = (src.match(/method === 'GET'/g) ?? []).length
  return { literals, matched, total }
}

// The known read routes. A new GET is not on this list until someone decides what it returns and who may read it.
const KNOWN_GET_LITERALS = ['/api/federation/directory', '/api/federation/manifest', '/api/federation/peers', '/api/federation/status']
const KNOWN_GET_MATCHED = [String.raw`/^\/api\/federation\/peers\/([^/]+)\/inbound-token$/`]

/** The GET routes of a source that are not on the named lists (empty when every one is classified). */
export function unclassifiedFederationGets(src: string): string[] {
  const { literals, matched, total } = federationGetRoutes(src)
  const out = [
    ...literals.filter((l) => !KNOWN_GET_LITERALS.includes(l)),
    ...matched.filter((m) => !KNOWN_GET_MATCHED.includes(m)),
  ]
  // a GET in a form neither reader sees: count it as unclassified too
  if (literals.length + matched.length !== total) out.push('(a GET route in a form this cell does not read)')
  return out
}

describe('every GET route of routes/federation.ts is classified', () => {
  const src = read('web/routes/federation.ts')

  it('the real source: every GET is on the named list, and the list has no stale entry', () => {
    expect(unclassifiedFederationGets(src)).toEqual([])
    const { literals, matched } = federationGetRoutes(src)
    expect([...literals].sort()).toEqual(KNOWN_GET_LITERALS)
    expect(matched).toEqual(KNOWN_GET_MATCHED)
  })

  it('the named reads keep federation:read, the secret-bearing peer token read is admin:all', () => {
    for (const prefix of ['/api/federation', '/api/v1/federation']) {
      for (const lit of KNOWN_GET_LITERALS) {
        const path = lit.replace('/api/federation', prefix)
        expect(resolveRequiredPermission('GET', path), `GET ${path}`).toBe('federation:read')
      }
      expect(resolveRequiredPermission('GET', `${prefix}/peers/peer-a/inbound-token`)).toBe('admin:all')
    }
  })

  // The classifier itself: a GET route added to the source, in either form, must come back unclassified. Without these a
  // reader that accepted any path would keep the cell above green forever.
  it('a new GET route, of a literal or a matched form, or in a form the readers miss, is reported', () => {
    const lit = `${src}\n  if (path === '/api/federation/secrets' && method === 'GET') { return true }\n`
    expect(unclassifiedFederationGets(lit)).toEqual(['/api/federation/secrets'])
    const matched = `${src}\n  const keyMatch = path.match(/^\\/api\\/federation\\/peers\\/([^/]+)\\/key$/)\n  if (keyMatch && method === 'GET') { return true }\n`
    expect(unclassifiedFederationGets(matched)).toEqual([String.raw`/^\/api\/federation\/peers\/([^/]+)\/key$/`])
    const other = `${src}\n  if (method === 'GET' && path.startsWith('/api/federation/x')) { return true }\n`
    expect(unclassifiedFederationGets(other)).toEqual(['(a GET route in a form this cell does not read)'])
  })
})

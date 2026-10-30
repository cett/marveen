// Deciding an approval is an admin's act. read_only and viewer see approvals (approvals:read) and never
// decide one, not even one of their own tenant: the PATCH is refused at the permission gate (403) and the
// request stays pending. Real in-memory database, the gate chain of web.ts in miniature; an admin goes
// through the real route and resolves the request.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { initDatabase, createTenant, createApproval, getApproval } from '../db.js'
import type { AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { hasPermission, ALL_ROLES } from '../web/rbac.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['alpha'],
  isKnownAgent: (n: string) => ['alpha', 'main-agent'].includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const session = (role: 'admin' | 'agent' | 'read_only' | 'viewer', tenantId: string | null): AuthResult =>
  ({ kind: 'session', user: `u-${role}`, role, tenantId })

// The gate of web.ts in miniature: the permission check first, the route only when it passes.
async function callAs(auth: AuthResult, method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost:3420${path}`)
  const decision = checkPermission(auth, method, url.pathname)
  if (!decision.allowed) return { status: decision.status, body: { error: 'denied', reason: decision.reason } as Record<string, unknown> }
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not JSON */ }
    },
  } as unknown as http.ServerResponse
  const role = resolveRole(auth)
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId: resolveTenantId(auth),
    auth: auth.kind === 'session' ? { kind: 'session', user: auth.user } : undefined,
  } as unknown as RouteContext
  if (!(await tryHandleApprovals(ctx))) out.status = 404
  return out
}

beforeEach(async () => {
  initDatabase(':memory:')
  await createTenant('acme', 'Acme')
  await createApproval({ id: 'appr-acme', agent_id: 'alpha', category: 'deploy', action_description: 'acme deploy', tenant_id: 'acme' })
  await createApproval({ id: 'appr-default', agent_id: 'alpha', category: 'deploy', action_description: 'default deploy', tenant_id: 'default' })
})

describe('approvals:write by role', () => {
  it('is held by admin only among the dashboard roles; read_only and viewer keep approvals:read', () => {
    expect(ALL_ROLES.filter((r) => hasPermission(r, 'approvals:write'))).toEqual(['admin'])
    for (const role of ['read_only', 'viewer'] as const) {
      expect(hasPermission(role, 'approvals:read'), role).toBe(true)
      expect(hasPermission(role, 'approvals:write'), role).toBe(false)
    }
  })
})

describe('PATCH /api/approvals/:id', () => {
  it.each([
    ['viewer', '/api/approvals/appr-acme'],
    ['viewer', '/api/v1/approvals/appr-acme'],
    ['read_only', '/api/approvals/appr-acme'],
    ['read_only', '/api/v1/approvals/appr-acme'],
  ] as const)('%s in the tenant of the request gets 403 on %s and the request stays pending', async (role, path) => {
    const out = await callAs(session(role, 'acme'), 'PATCH', path, { status: 'approved' })
    expect(out.status).toBe(403)
    expect(String(out.body.reason)).toContain('approvals:write')
    expect((await getApproval('appr-acme'))?.status).toBe('pending')
  })

  it.each(['viewer', 'read_only'] as const)('%s also gets 403 on a request of another tenant, and on a rejection', async (role) => {
    expect((await callAs(session(role, 'acme'), 'PATCH', '/api/approvals/appr-default', { status: 'approved' })).status).toBe(403)
    expect((await callAs(session(role, 'acme'), 'PATCH', '/api/approvals/appr-acme', { status: 'rejected' })).status).toBe(403)
    expect((await getApproval('appr-default'))?.status).toBe('pending')
    expect((await getApproval('appr-acme'))?.status).toBe('pending')
  })

  it('a viewer still reads the approvals of the tenant (approvals:read stays)', async () => {
    const out = await callAs(session('viewer', 'acme'), 'GET', '/api/approvals')
    expect(out.status).toBe(200)
  })

  it('an admin resolves the request through the route (200) and the row changes', async () => {
    const out = await callAs(session('admin', null), 'PATCH', '/api/approvals/appr-acme', { status: 'approved' })
    expect(out.status).toBe(200)
    expect((await getApproval('appr-acme'))?.status).toBe('approved')
  })
})

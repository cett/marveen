// The four process-level diagnostic endpoints (db-context, rerank-stats, otel-export-status, tenant-gate-status) answer
// a GLOBAL admin only: auth kind token or session, role 'admin', and a tenant scope of undefined, null or 'default'
// (the browser enrollment code uses the very same predicate). Covered:
//   - the shared helper (every role, every tenant shape),
//   - each of the four handlers on both URL forms (/api/admin/* and /api/v1/admin/*, through the real path normaliser),
//   - that a refused call is answered once and carries no payload, and that an unrelated path/method never gets the 403,
//   - that the real credentials the supervisor uses (the main agent's token, the operator token, the legacy dashboard
//     token) resolve to a caller the check lets through, and a tenant admin's token does not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get STORE_DIR() { return join(state.root, 'store') },
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  agentConfigRoot: (name: string) => (name === 'main-agent' ? state.root : join(state.root, 'agents', name)),
}))

import { initDatabase, insertApiToken } from '../db.js'
import { issueAgentToken, issueOperatorToken } from '../agent-tokens.js'
import { resolveAuth } from '../web/auth-gate.js'
import { resolveRole, resolveTenantId } from '../web/authz.js'
import { normalizePath } from '../web/routes/versioning.js'
import { isGlobalAdmin } from '../web/routes/global-admin.js'
import { tryHandleDbContext } from '../web/routes/db-context.js'
import { tryHandleRerankStats } from '../web/routes/rerank-stats.js'
import { tryHandleOtelExportStatus } from '../web/routes/otel-export-status.js'
import { tryHandleTenantGateStatus } from '../web/routes/tenant-gate-status.js'
import { tryHandleBrowserEnroll } from '../web/routes/browser-enroll.js'
import type { RouteContext, RouteHandler } from '../web/routes/types.js'

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'global-admin-diag-'))
  mkdirSync(join(state.root, 'store'), { recursive: true })
  initDatabase(':memory:')
})
afterEach(() => { rmSync(state.root, { recursive: true, force: true }) })

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// A caller shape: the role and the tenant scope the gate resolved for the request.
interface Caller { role?: string; tenantId?: string | null; kind?: 'token' | 'session' | 'device' | 'federation' }
/** The helper takes a typed Role; the refused cases deliberately include a role string outside the union. */
const asCtx = (c: Caller) => ({ role: c.role, tenantId: c.tenantId, auth: { kind: c.kind ?? 'token' } }) as unknown as RouteContext
const GLOBAL_SESSION: Caller = { role: 'admin', tenantId: null, kind: 'session' }
const DEFAULT_TENANT_ADMIN: Caller = { role: 'admin', tenantId: 'default' }
const UNRESOLVED_TENANT_ADMIN: Caller = { role: 'admin', tenantId: undefined }
const TENANT_ADMIN: Caller = { role: 'admin', tenantId: 'tenant-a' }
const REFUSED: Array<[string, Caller]> = [
  ['tenant admin', TENANT_ADMIN],
  ['viewer with a null tenant', { role: 'viewer', tenantId: null }],
  ['viewer in the default tenant', { role: 'viewer', tenantId: 'default' }],
  ['read_only with a null tenant', { role: 'read_only', tenantId: null }],
  ['agent with a null tenant', { role: 'agent', tenantId: null }],
  ['fleet_agent with a null tenant', { role: 'fleet_agent', tenantId: null }],
  ['unknown role with a null tenant', { role: 'superuser', tenantId: null }],
  ['no role at all', { role: undefined, tenantId: null }],
  ['admin device key in the default tenant', { role: 'admin', tenantId: 'default', kind: 'device' }],
  ['admin federation peer with a null tenant', { role: 'admin', tenantId: null, kind: 'federation' }],
  ['admin federation peer in the default tenant', { role: 'admin', tenantId: 'default', kind: 'federation' }],
  ['admin device key with a null tenant', { role: 'admin', tenantId: null, kind: 'device' }],
  // The tenant id is compared exactly: no trimming, no prefix match.
  ['admin of a tenant id with a leading space', { role: 'admin', tenantId: ' default' }],
  ['admin of a tenant id with a trailing space', { role: 'admin', tenantId: 'default ' }],
  ['admin of a tenant id that only starts with default', { role: 'admin', tenantId: 'default-x' }],
  ['admin of a tenant id in another case', { role: 'admin', tenantId: 'DEFAULT' }],
]

interface Result { handled: boolean; status: number; body: any; ends: number }

/** Drive a handler the way web.ts does: normalise the raw path first, so /api/v1/... reaches it as /api/... */
async function call(handler: RouteHandler, method: string, rawPath: string, caller: Caller): Promise<Result> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, body: null as any, ends: 0 }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      out.ends++
      if (b) out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b)
    },
  }
  const norm = normalizePath(rawPath)
  const url = new URL(`http://localhost:3420${rawPath}`)
  const ctx = { req, res, path: norm.path, method, url, apiVersion: norm.apiVersion, role: caller.role, tenantId: caller.tenantId, auth: { kind: caller.kind ?? 'token' } } as unknown as RouteContext
  const handled = await handler(ctx)
  return { handled, status: out.status, body: out.body, ends: out.ends }
}

const ENDPOINTS: Array<{ name: string; handler: RouteHandler; segment: string; payloadKey: string }> = [
  { name: 'db-context', handler: tryHandleDbContext, segment: 'db-context', payloadKey: 'sites' },
  { name: 'rerank-stats', handler: tryHandleRerankStats, segment: 'rerank-stats', payloadKey: 'calls' },
  { name: 'otel-export-status', handler: tryHandleOtelExportStatus, segment: 'otel-export-status', payloadKey: 'now' },
  { name: 'tenant-gate-status', handler: tryHandleTenantGateStatus, segment: 'tenant-gate-status', payloadKey: 'migrations' },
]
const PREFIXES = ['/api/admin', '/api/v1/admin']

describe('isGlobalAdmin', () => {
  it('lets a global admin through: a null scope, an unresolved scope, and the default tenant (every bearer token resolves to a string)', () => {
    expect(isGlobalAdmin(asCtx(GLOBAL_SESSION))).toBe(true)
    expect(isGlobalAdmin(asCtx(UNRESOLVED_TENANT_ADMIN))).toBe(true)
    expect(isGlobalAdmin(asCtx(DEFAULT_TENANT_ADMIN))).toBe(true)
  })

  it.each(REFUSED)('refuses %s', (_label, caller) => {
    expect(isGlobalAdmin(asCtx(caller))).toBe(false)
  })

  it('a null tenant alone is not enough: the role decides (a viewer starts with a null tenant)', () => {
    expect(isGlobalAdmin(asCtx({ role: 'viewer', tenantId: null }))).toBe(false)
  })

  it('the admin role alone is not enough: a named tenant other than default is refused', () => {
    expect(isGlobalAdmin(asCtx({ role: 'admin', tenantId: 'tenant-a' }))).toBe(false)
    expect(isGlobalAdmin(asCtx({ role: 'admin', tenantId: '' }))).toBe(false)
    expect(isGlobalAdmin(asCtx({ role: 'admin', tenantId: 'Default' }))).toBe(false)
  })
})

describe.each(ENDPOINTS)('$name', ({ handler, segment, payloadKey }) => {
  describe.each(PREFIXES)('on %s', (prefix) => {
    const path = `${prefix}/${segment}`

    it.each([['global admin', GLOBAL_SESSION], ['default-tenant admin (the token lane)', DEFAULT_TENANT_ADMIN], ['admin with an unresolved scope', UNRESOLVED_TENANT_ADMIN]])('answers 200 with its payload to a %s', async (_l, caller) => {
      const r = await call(handler, 'GET', path, caller)
      expect(r.handled).toBe(true)
      expect(r.status).toBe(200)
      expect(r.ends).toBe(1)
      expect(r.body[payloadKey]).toBeDefined()
      expect(r.body.error).toBeUndefined()
    })

    it.each(REFUSED)('answers 403 once, with no payload, to %s', async (_l, caller) => {
      const r = await call(handler, 'GET', path, caller)
      expect(r.handled).toBe(true)
      expect(r.status).toBe(403)
      expect(r.ends).toBe(1)
      expect(r.body).toEqual({ error: 'forbidden', hint: 'Global admin only' })
    })

    it('leaves an unrelated method or path alone, even for a refused caller (no stray 403)', async () => {
      for (const [method, p] of [['POST', path], ['GET', `${path}s`], ['GET', `${prefix}/tenants`]] as const) {
        const r = await call(handler, method, p, TENANT_ADMIN)
        expect(r.handled, `${method} ${p}`).toBe(false)
        expect(r.ends, `${method} ${p}`).toBe(0)
      }
    })
  })
})

describe('the credentials the supervisor really uses', () => {
  async function resolve(bearer: string, dashboardToken = 'f'.repeat(64)): Promise<Caller> {
    const req = { headers: { authorization: `Bearer ${bearer}` } } as any
    const url = new URL('http://127.0.0.1:3420/api/admin/db-context')
    const auth = await resolveAuth(req, url, '/api/admin/db-context', 'GET', dashboardToken, true)
    expect(auth.kind).toBe('token')
    return { role: resolveRole(auth), tenantId: resolveTenantId(auth) }
  }
  const read = (p: string) => readFileSync(p, 'utf-8').trim()

  it('the main agent token (agent-api.sh --token main) resolves to an admin the check lets through, on every endpoint', async () => {
    const raw = read((await issueAgentToken('main-agent')).path)
    const caller = await resolve(raw)
    expect(caller.role).toBe('admin')
    // A bearer token always carries a string tenant, never null: the check must accept that string for the supervisor.
    expect(caller.tenantId).toBe('default')
    expect(isGlobalAdmin(asCtx(caller))).toBe(true)
    for (const e of ENDPOINTS) {
      for (const prefix of PREFIXES) expect((await call(e.handler, 'GET', `${prefix}/${e.segment}`, caller)).status, `${prefix}/${e.segment}`).toBe(200)
    }
  })

  it('the operator token (the rollout check script) resolves to an admin the check lets through', async () => {
    const raw = read((await issueOperatorToken()).path)
    const caller = await resolve(raw)
    expect(caller.role).toBe('admin')
    expect(isGlobalAdmin(asCtx(caller))).toBe(true)
    expect((await call(tryHandleTenantGateStatus, 'GET', '/api/admin/tenant-gate-status', caller)).status).toBe(200)
  })

  it('the legacy dashboard token (no api_tokens row) resolves to an admin the check lets through', async () => {
    const caller = await resolve('f'.repeat(64))
    expect(caller).toEqual({ role: 'admin', tenantId: 'default' })
    expect(isGlobalAdmin(asCtx(caller))).toBe(true)
  })

  it('a tenant admin token (role admin, tenant-a) is refused on every endpoint', async () => {
    const raw = 'c'.repeat(64)
    await insertApiToken({ tokenHash: sha(raw), name: 'tenant-a-admin', role: 'admin', tenantId: 'tenant-a', createdAt: Math.floor(Date.now() / 1000), expiresAt: null })
    const caller = await resolve(raw)
    expect(caller).toEqual({ role: 'admin', tenantId: 'tenant-a' })
    expect(isGlobalAdmin(asCtx(caller))).toBe(false)
    for (const e of ENDPOINTS) {
      for (const prefix of PREFIXES) expect((await call(e.handler, 'GET', `${prefix}/${e.segment}`, caller)).status, `${prefix}/${e.segment}`).toBe(403)
    }
  })

  it('a viewer token in the default tenant is refused', async () => {
    const raw = 'd'.repeat(64)
    await insertApiToken({ tokenHash: sha(raw), name: 'viewer-default', role: 'viewer', tenantId: 'default', createdAt: Math.floor(Date.now() / 1000), expiresAt: null })
    const caller = await resolve(raw)
    expect(isGlobalAdmin(asCtx(caller))).toBe(false)
  })
})

describe('one predicate for both users', () => {
  const GRANTED: Array<[string, Caller]> = [
    ['global session', GLOBAL_SESSION],
    ['default-tenant admin token', DEFAULT_TENANT_ADMIN],
    ['unresolved-scope admin token', UNRESOLVED_TENANT_ADMIN],
  ]

  it.each([...GRANTED, ...REFUSED])('the browser enrollment code route and the diagnostics agree on %s', async (_l, caller) => {
    const diag = await call(tryHandleDbContext, 'GET', '/api/admin/db-context', caller)
    const { ctx, out } = enrollCtx(caller)
    await tryHandleBrowserEnroll(ctx)
    expect(out.status === 201, 'enroll code issued').toBe(diag.status === 200)
    expect(isGlobalAdmin(asCtx(caller))).toBe(diag.status === 200)
  })

  it('browser-enroll.ts imports the shared predicate and keeps no copy of its own', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const enroll = readFileSync(join(dir, '../web/routes/browser-enroll.ts'), 'utf-8')
    expect(enroll).toContain("import { isGlobalAdmin } from './global-admin.js'")
    expect(enroll).not.toMatch(/function isGlobalAdmin/)
    for (const f of ['db-context', 'rerank-stats', 'otel-export-status', 'tenant-gate-status']) {
      const src = readFileSync(join(dir, `../web/routes/${f}.ts`), 'utf-8')
      expect(src, f).toContain("import { requireGlobalAdmin } from './global-admin.js'")
      expect(src, f).not.toMatch(/ctx\.role\s*[!=]==?\s*'admin'/)
    }
  })
})

function enrollCtx(caller: Caller): { ctx: RouteContext; out: { status: number } } {
  const req = new EventEmitter() as any
  req.method = 'POST'
  req.headers = {}
  const out = { status: 200 }
  const res = { setHeader() {}, writeHead(s: number) { out.status = s }, end() {} } as any
  const url = new URL('http://localhost:3420/api/admin/browser-enroll-codes')
  const ctx = { req, res, path: url.pathname, method: 'POST', url, role: caller.role, tenantId: caller.tenantId, auth: { kind: caller.kind ?? 'token' } } as unknown as RouteContext
  return { ctx, out }
}

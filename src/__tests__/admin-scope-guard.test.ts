import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'

// The admin-scope guard: an admin-ROLE caller whose database context is not privileged (the bearer: role admin, tenant `default`,
// so a tenant context on PostgreSQL) gets 403 `admin_session_required` on the routes that reach a privileged-only table, before the
// route runs. These cells pin the decision matrix with a stub backend that only has to SAY it is PostgreSQL; the real handlers
// against a real policy are in pg/admin-scope-guard.pg.test.ts. Fixtures are neutral.

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

import {
  ADMIN_SCOPE_ROUTES,
  ADMIN_SESSION_REQUIRED_CODE,
  ADMIN_SESSION_REQUIRED_HINT,
  adminScopeRouteFor,
  answerAdminScopeRefusal,
  dispatchBehindAdminScopeGuard,
} from '../web/admin-scope-guard.js'
import { runAs, getDbContextStats, resetDbContextStats } from '../db/context.js'
import { runAsRequest } from '../db/background-jobs.js'
import { useDbxBackend, type Dbx } from '../db/facade.js'
import type { RouteContext } from '../web/routes/types.js'

const here = dirname(fileURLToPath(import.meta.url))

/** A backend that only has to report the dialect: the guard reads the dialect and the running context, never the database. */
const stubBackend = {} as Dbx

interface Out { status: number; body: Record<string, unknown> | null }
function fakeRes(out: Out): http.ServerResponse {
  return {
    writeHead(s: number) { out.status = s },
    end(b?: string) { out.body = b ? JSON.parse(b) as Record<string, unknown> : null },
    setHeader() {}, headersSent: false,
  } as unknown as http.ServerResponse
}

interface Who { role: string; kind: 'token' | 'session'; tenantId: string | null }
const BEARER: Who = { role: 'admin', kind: 'token', tenantId: 'default' }
const GLOBAL_ADMIN_SESSION: Who = { role: 'admin', kind: 'session', tenantId: null }
const TENANT_ADMIN_SESSION: Who = { role: 'admin', kind: 'session', tenantId: 'tenant-t1' }

/** Runs the guard the way web.ts does: inside the request's database context. */
async function guard(method: string, path: string, who: Who): Promise<{ refused: boolean; out: Out }> {
  const out: Out = { status: 200, body: null }
  const ctx = {
    req: {} as http.IncomingMessage, res: fakeRes(out), path, method, url: new URL(`http://localhost:3420${path}`),
    role: who.role, tenantId: who.tenantId ?? undefined, auth: { kind: who.kind },
  } as unknown as RouteContext
  const refused = await runAsRequest({ authenticated: true, role: who.role, tenantId: who.tenantId }, () => Promise.resolve(answerAdminScopeRefusal(ctx)))
  return { refused, out }
}

beforeEach(() => { useDbxBackend(stubBackend, 'pg'); resetDbContextStats(); loggerMock.warn.mockClear() })
afterEach(() => { useDbxBackend(null) })

const GUARDED: Array<[string, string]> = [
  ['POST', '/api/settings'],
  ['PUT', '/api/model-fallback'],
  ['POST', '/api/terminal-input'],
  ['PUT', '/api/federation/peers'],
  ['POST', '/api/federation/peers'],
  ['PATCH', '/api/federation/peers/peer-a'],
  ['DELETE', '/api/federation/peers/peer-a'],
  ['POST', '/api/federation/peers/peer-a/rotate-inbound-token'],
  ['POST', '/api/federation/enabled'],
  ['POST', '/api/federation/routing-mode'],
  ['POST', '/api/federation/remove'],
  ['GET', '/api/auth/users'],
]

describe('a bearer (admin role, tenant database context) on PostgreSQL', () => {
  it.each(GUARDED)('%s %s: 403 forbidden with code admin_session_required and a fixed hint', async (method, path) => {
    const { refused, out } = await guard(method, path, BEARER)
    expect(refused).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: 'forbidden', code: ADMIN_SESSION_REQUIRED_CODE, hint: ADMIN_SESSION_REQUIRED_HINT })
    expect(ADMIN_SESSION_REQUIRED_CODE).toBe('admin_session_required')
  })

  it('the answer carries nothing of the SQL, the table or the policy', () => {
    expect(ADMIN_SESSION_REQUIRED_HINT).not.toMatch(/system_config|dashboard_users|policy|row-level|42501|SELECT|INSERT/i)
  })

  it('the refusal is logged at warn with the route (no id) and counted per route', async () => {
    await guard('DELETE', '/api/federation/peers/peer-a', BEARER)
    await guard('DELETE', '/api/federation/peers/peer-b', BEARER)
    expect(loggerMock.warn).toHaveBeenCalledTimes(2)
    const meta = loggerMock.warn.mock.calls[0][0] as Record<string, unknown>
    expect(meta).toMatchObject({ event: 'admin-scope-refusal', route: 'DELETE /api/federation/peers', kind: 'token', dbRole: 'tenant' })
    expect(JSON.stringify(meta)).not.toContain('peer-a')
    expect(getDbContextStats().rlsRefusals).toMatchObject({ 'DELETE /api/federation/peers': 2 })
  })
})

describe('the guard grants and removes nothing for anyone else', () => {
  it.each(GUARDED)('%s %s: a global admin SESSION (the unrestricted context) passes untouched', async (method, path) => {
    const { refused, out } = await guard(method, path, GLOBAL_ADMIN_SESSION)
    expect(refused).toBe(false)
    expect(out.body).toBeNull()
  })

  it('SQLite: nothing is guarded, the bearer keeps working there (no row-level security to refuse it)', async () => {
    useDbxBackend(null)
    for (const [method, path] of GUARDED) {
      const { refused, out } = await guard(method, path, BEARER)
      expect(refused, `${method} ${path}`).toBe(false)
      expect(out.body).toBeNull()
    }
  })

  it('a caller whose role is not admin is left to the route\'s own gate (the answer it always had)', async () => {
    for (const role of ['fleet_agent', 'agent', 'read_only', 'viewer']) {
      for (const [method, path] of GUARDED) {
        const { refused } = await guard(method, path, { role, kind: 'token', tenantId: 'default' })
        expect(refused, `${role} ${method} ${path}`).toBe(false)
      }
    }
  })

  it('a system job context is privileged and passes', async () => {
    const out: Out = { status: 200, body: null }
    const ctx = { res: fakeRes(out), path: '/api/settings', method: 'POST', role: 'admin', auth: { kind: 'token' } } as unknown as RouteContext
    expect(await runAs.system('boot-sequence', () => Promise.resolve(answerAdminScopeRefusal(ctx)))).toBe(false)
  })

  it('the users list: a tenant-admin SESSION is not refused (its own tenant\'s users are a real answer), a tenant-admin bearer is', async () => {
    expect((await guard('GET', '/api/auth/users', TENANT_ADMIN_SESSION)).refused).toBe(false)
    expect((await guard('GET', '/api/auth/users', BEARER)).refused).toBe(true)
  })

  it('the writers: a tenant-admin SESSION is refused too (the database refuses it anyway, now with the explicit code)', async () => {
    expect((await guard('POST', '/api/settings', TENANT_ADMIN_SESSION)).refused).toBe(true)
  })

  it.each([
    ['GET', '/api/settings'], ['GET', '/api/model-fallback'], ['GET', '/api/terminal-input'], ['GET', '/api/federation/peers'],
    ['GET', '/api/federation/peers/peer-a/inbound-token'], ['POST', '/api/federation/inbox'], ['POST', '/api/federation/refresh'],
    ['POST', '/api/auth/users'], ['DELETE', '/api/skills/sql/global%2Fx'], ['GET', '/api/auth/users/extra'], ['POST', '/api/settingsx'],
    ['PUT', '/api/settings'], ['PATCH', '/api/federation/peers'], ['GET', '/api/model-fallback/x'],
  ])('%s %s is not a guarded route', async (method, path) => {
    expect(adminScopeRouteFor(method, path)).toBeUndefined()
    expect((await guard(method, path, BEARER)).refused).toBe(false)
  })
})

describe('the dispatch composition web.ts runs', () => {
  it('the route runs only when the guard did not answer', async () => {
    const dispatch = vi.fn().mockResolvedValue(true)
    const out: Out = { status: 200, body: null }
    const mk = (path: string): RouteContext => ({ res: fakeRes(out), path, method: 'POST', role: 'admin', auth: { kind: 'token' } }) as unknown as RouteContext
    const who = { authenticated: true, role: 'admin', tenantId: 'default' as string | null }
    expect(await runAsRequest(who, () => dispatchBehindAdminScopeGuard(mk('/api/settings'), dispatch))).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(out.status).toBe(403)
    expect(await runAsRequest(who, () => dispatchBehindAdminScopeGuard(mk('/api/agents'), dispatch))).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('web.ts wraps the dispatch in the guard INSIDE runAsRequest (the decision reads the request context)', () => {
    const src = readFileSync(join(here, '..', 'web.ts'), 'utf8')
    expect(src).toMatch(/runAsRequest\([^\n]*\(\) => dispatchBehindAdminScopeGuard\(routeCtx, \(\) => dispatcher\.dispatch\(routeCtx\)\)\)/)
    expect(src).not.toMatch(/\(\) => dispatcher\.dispatch\(routeCtx\)\)\n/)
  })
})

// Drift guard: a route file that calls a system_config writer is a route the guard must know. The set below is the route files
// the table was built from; a new file that writes system_config (or a writer function added to one of them) fails here and
// has to be decided: add the route to ADMIN_SCOPE_ROUTES, or say why it is not needed.
describe('drift: every route file that writes system_config is accounted for', () => {
  const WRITERS = /\b(setSystemConfig|setSystemConfigMany|updateSystemConfig|deleteSystemConfig|setOverride|writeModelFallbackConfig|writeModelFallbackFieldsRaw|writeTerminalInputEnabled|writeFederationConfig|mutateFederationConfig|setFederationEnabledPreservingFile|setFederationRoutingModePreservingFile|setFederationConfigRaw|updateFederationConfigRaw|deleteFederationConfigRaw)\(/
  const ACCOUNTED: Record<string, string> = {
    'settings.ts': 'POST /api/settings',
    'model-fallback.ts': 'PUT /api/model-fallback',
    'agent-terminal.ts': 'POST /api/terminal-input',
    'federation.ts': 'peers PUT/POST/PATCH/DELETE, rotate-inbound-token, enabled, routing-mode, remove',
  }
  const routesDir = join(here, '..', 'web', 'routes')

  it('the route files that call a writer are exactly the accounted ones', () => {
    const found = readdirSync(routesDir).filter((f) => f.endsWith('.ts') && WRITERS.test(readFileSync(join(routesDir, f), 'utf8'))).sort()
    expect(found).toEqual(Object.keys(ACCOUNTED).sort())
  })

  it('every accounted route file has at least one entry in the table', () => {
    const paths = ADMIN_SCOPE_ROUTES.map((r) => r.path.source)
    expect(paths.some((p) => p.includes('settings'))).toBe(true)
    expect(paths.some((p) => p.includes('model-fallback'))).toBe(true)
    expect(paths.some((p) => p.includes('terminal-input'))).toBe(true)
    expect(paths.filter((p) => p.includes('federation')).length).toBeGreaterThanOrEqual(7)
  })

  it('every federation method+path that the route file branches on for a write is in the table', () => {
    const src = readFileSync(join(routesDir, 'federation.ts'), 'utf8')
    const writes = [...src.matchAll(/path === '(\/api\/federation\/[a-z-]+)' && method === '(PUT|POST|PATCH|DELETE)'/g)].map((m) => `${m[2]} ${m[1]}`)
    // Not dashboard writers of system_config: the peer inbox (a peer's own token), the poller refresh, the restart.
    const NOT_SYSTEM_CONFIG = new Set(['POST /api/federation/inbox', 'POST /api/federation/refresh', 'POST /api/federation/apply'])
    for (const w of writes) {
      if (NOT_SYSTEM_CONFIG.has(w)) continue
      const [method, path] = w.split(' ')
      expect(adminScopeRouteFor(method, path), w).toBeDefined()
    }
    expect(writes.length).toBeGreaterThanOrEqual(6)
  })
})

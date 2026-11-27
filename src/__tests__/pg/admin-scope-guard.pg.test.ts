// The admin-scope guard against real PostgreSQL with forced row-level security, the backend booted as the APP role (`npm run test:pg`).
//
// The main-agent bearer is role `admin` with the tenant `default`, so its request context is a TENANT one: the privileged-only
// tables (system_config, every tenant's dashboard_users) refuse its writes (42501) and show it ZERO dashboard users. The cells run
// the REAL route handlers inside `runAsRequest` behind `dispatchBehindAdminScopeGuard` (the composition web.ts runs) and answer a
// thrown error the way the request handler does, then read the result through the admin pool, the oracle. Fixtures are neutral.
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { runAsRequest } from '../../db/background-jobs.js'
import { runAs } from '../../db/context.js'
import { loadSystemConfigCacheAsync } from '../../db/config-cache.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { answerRlsRefusal } from '../../web/rls-refusal-response.js'
import { ADMIN_SESSION_REQUIRED_CODE, dispatchBehindAdminScopeGuard } from '../../web/admin-scope-guard.js'
import type { RouteContext } from '../../web/routes/types.js'
import { tryHandleAuth } from '../../web/routes/auth.js'
import { tryHandleSettings } from '../../web/routes/settings.js'
import { tryHandleModelFallback } from '../../web/routes/model-fallback.js'
import { tryHandleAgentTerminal } from '../../web/routes/agent-terminal.js'
import { tryHandleFederation } from '../../web/routes/federation.js'
import { normalizePath } from '../../web/routes/versioning.js'

let db: PgTestDb
beforeAll(async () => { db = await createPgTestDb(); setBackend(db.appDbx(), 'pg') })
afterAll(async () => { setBackend(null); await db.close() })

interface Who { role: string; tenantId: string | null; kind: 'token' | 'session' }
const MAIN_BEARER: Who = { role: 'admin', tenantId: 'default', kind: 'token' }
const GLOBAL_ADMIN_SESSION: Who = { role: 'admin', tenantId: null, kind: 'session' }
const TENANT_ADMIN_SESSION: Who = { role: 'admin', tenantId: 'tenant-t1', kind: 'session' }

/** The chain of route handlers the dispatcher would try, in web.ts order for these files. */
async function chain(ctx: RouteContext): Promise<boolean> {
  for (const h of [tryHandleAuth, tryHandleSettings, tryHandleModelFallback, tryHandleAgentTerminal, tryHandleFederation]) {
    if (await h(ctx)) return true
  }
  return false
}

async function call(method: string, reqPath: string, who: Who, body?: unknown, opts: { guard?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {} as Record<string, string> })
  const out = { status: 200, body: {} as Record<string, unknown> }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = { raw: String(b) } } },
    setHeader() {}, headersSent: false,
  } as never
  const url = new URL(`http://localhost:3420${reqPath}`)
  const { path } = normalizePath(url.pathname)
  const ctx = {
    req, res, path, method, url, role: who.role, tenantId: who.tenantId ?? undefined,
    auth: who.kind === 'token' ? { kind: 'token', tokenName: 'probe' } : { kind: 'session', user: 'user-a' },
  } as unknown as RouteContext
  const dispatch = (): Promise<boolean> => chain(ctx)
  try {
    await runAsRequest({ authenticated: true, role: who.role, tenantId: who.tenantId }, () => opts.guard === false ? dispatch() : dispatchBehindAdminScopeGuard(ctx, dispatch))
  } catch (err) {
    // The catch of the request handler: a database refusal is 403, anything else the generic 500.
    if (!answerRlsRefusal(err, res, method, path)) { out.status = 500; out.body = { error: 'internal_error' } }
  }
  return out
}

const snapshot = async (): Promise<string> => JSON.stringify((await db.pool.query("SELECT key, value FROM system_config WHERE key NOT LIKE 'boot%' ORDER BY key")).rows)
const logRows = async (): Promise<number> => Number((await db.pool.query('SELECT count(*) AS n FROM config_change_log')).rows[0].n)

beforeEach(async () => {
  await db.pool.query('DELETE FROM system_config')
  await db.pool.query('DELETE FROM config_change_log')
  await db.pool.query('DELETE FROM dashboard_users')
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('default', 'Default', 1), ('tenant-t1', 'Tenant 1', 1) ON CONFLICT DO NOTHING")
  // three users: a global admin (no tenant), a tenant-t1 user, a default-tenant user
  await db.pool.query(`INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id) VALUES
    ('user-admin', 'x', 1, 1, 'admin', NULL),
    ('user-t1', 'x', 1, 1, 'agent', 'tenant-t1'),
    ('user-default', 'x', 1, 1, 'agent', 'default')`)
  // the boot loads the synchronous system_config cache the stores read; the cells do it the same way, as a system job
  await runAs.system('boot-sequence', () => loadSystemConfigCacheAsync())
})

const WRITERS: Array<{ name: string; method: string; path: string; body: unknown }> = [
  { name: 'POST /api/settings', method: 'POST', path: '/api/settings', body: { key: 'DASHBOARD_LANG', value: 'en' } },
  { name: 'PUT /api/model-fallback', method: 'PUT', path: '/api/model-fallback', body: { enabled: true, chain: ['model-a', 'model-b'] } },
  { name: 'POST /api/terminal-input', method: 'POST', path: '/api/terminal-input', body: { enabled: true } },
  { name: 'PUT /api/federation/peers', method: 'PUT', path: '/api/federation/peers', body: { enabled: false } },
  { name: 'POST /api/federation/enabled', method: 'POST', path: '/api/federation/enabled', body: { enabled: false } },
]

describe('the main-agent bearer on the privileged-only writers', () => {
  it.each(WRITERS)('$name: 403 with code admin_session_required, and nothing is written', async (w) => {
    const before = await snapshot()
    const logsBefore = await logRows()
    const r = await call(w.method, w.path, MAIN_BEARER, w.body)
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: 'forbidden', code: ADMIN_SESSION_REQUIRED_CODE })
    expect(JSON.stringify(r.body)).not.toMatch(/system_config|policy|row-level|42501/)
    expect(await snapshot()).toBe(before)
    expect(await logRows()).toBe(logsBefore)
  })

  it('a malformed body is refused before it is read (403, not 400): the bearer can never succeed here', async () => {
    const r = await call('POST', '/api/settings', MAIN_BEARER, { value: 'en' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe(ADMIN_SESSION_REQUIRED_CODE)
  })
})

describe('the same writers with a global admin SESSION work (the guard grants nothing and removes nothing)', () => {
  it('POST /api/settings writes system_config and the change journal', async () => {
    const r = await call('POST', '/api/settings', GLOBAL_ADMIN_SESSION, { key: 'DASHBOARD_LANG', value: 'en' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, key: 'DASHBOARD_LANG', value: 'en' })
    expect(await snapshot()).toContain('"value":"en"')
    expect(await logRows()).toBe(1)
  })

  it('PUT /api/model-fallback writes its keys', async () => {
    const r = await call('PUT', '/api/model-fallback', GLOBAL_ADMIN_SESSION, { enabled: true, chain: ['model-a', 'model-b'] })
    expect(r.status).toBe(200)
    expect(await snapshot()).toContain('model-a')
  })

  it('POST /api/terminal-input flips the switch', async () => {
    const r = await call('POST', '/api/terminal-input', GLOBAL_ADMIN_SESSION, { enabled: true })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ enabled: true })
    expect(await snapshot()).toContain('"value":"1"')
  })

  it.each([WRITERS[3], WRITERS[4]])('$name is not answered by the guard (the route runs and writes)', async (w) => {
    const r = await call(w.method, w.path, GLOBAL_ADMIN_SESSION, w.body)
    expect(r.body.code).not.toBe(ADMIN_SESSION_REQUIRED_CODE)
    expect(r.status).not.toBe(403)
    expect(r.status).not.toBe(500)
  })
})

describe('GET /api/auth/users', () => {
  const names = (r: { body: Record<string, unknown> }): string[] => (r.body.users as Array<{ username: string }>).map((u) => u.username).sort()

  it('a global admin session sees every user', async () => {
    const r = await call('GET', '/api/auth/users', GLOBAL_ADMIN_SESSION)
    expect(r.status).toBe(200)
    expect(names(r)).toEqual(['user-admin', 'user-default', 'user-t1'])
  })

  it('the bearer is refused with 403 admin_session_required, not shown a list', async () => {
    const r = await call('GET', '/api/auth/users', MAIN_BEARER)
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: 'forbidden', code: ADMIN_SESSION_REQUIRED_CODE })
    expect(r.body.users).toBeUndefined()
  })

  it('without the guard the bearer\'s answer is a FALSE SUCCESS: 200 with the users the policy shows its tenant (the admin and tenant-t1 are invisible)', async () => {
    const r = await call('GET', '/api/auth/users', MAIN_BEARER, undefined, { guard: false })
    expect(r.status).toBe(200)
    expect(names(r)).not.toContain('user-admin')
    expect(names(r)).not.toContain('user-t1')
    expect(names(r).length).toBeLessThan(3)
  })

  it('a tenant-admin SESSION keeps its own answer: the users of its tenant, not a 403', async () => {
    const r = await call('GET', '/api/auth/users', TENANT_ADMIN_SESSION)
    expect(r.status).toBe(200)
    expect(names(r)).toEqual(['user-t1'])
  })
})

describe('without the guard (the mutant) the refusals are the ones the issue describes', () => {
  it('POST /api/settings by the bearer: the route swallows the database refusal into a 500', async () => {
    const r = await call('POST', '/api/settings', MAIN_BEARER, { key: 'DASHBOARD_LANG', value: 'en' }, { guard: false })
    expect(r.status).toBe(500)
    expect(r.body.code).toBeUndefined()
  })

  it('POST /api/terminal-input by the bearer: only the generic 403, no code that names the way out', async () => {
    const r = await call('POST', '/api/terminal-input', MAIN_BEARER, { enabled: true }, { guard: false })
    expect(r.status).toBe(403)
    expect(r.body.code).toBeUndefined()
  })
})

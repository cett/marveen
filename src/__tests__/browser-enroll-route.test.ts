// Browser enrollment end to end at the route level, against a real (in-memory) api_tokens table:
// a code is traded for a named, revocable admin token that the auth gate then resolves.
import { beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getDb, getApiTokenRowById, revokeApiToken } from '../db.js'
import { tryHandleBrowserEnroll } from '../web/routes/browser-enroll.js'
import { tryHandleAdminTokens } from '../web/routes/tokens.js'
import { resolveApiToken, requiresAuth } from '../web/auth-gate.js'
import { _resetEnrollCodesForTest, issueEnrollCode } from '../web/browser-enroll-codes.js'
import type { RouteContext } from '../web/routes/types.js'

interface Out { status: number; body: any; headers: Record<string, string> }

function makeCtx(method: string, path: string, body: object | string | undefined, extra: Partial<RouteContext> = {}): { ctx: RouteContext; out: Out } {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  const buf = typeof body === 'string' ? Buffer.from(body) : body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: Out = { status: 200, body: null, headers: {} }
  const res = {
    setHeader(k: string, v: string) { out.headers[k] = v },
    writeHead(s: number) { out.status = s },
    end(b?: any) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path, method, url, role: 'admin', tenantId: 'default', auth: { kind: 'token' }, ...extra } as RouteContext, out }
}

async function run(method: string, path: string, body?: object, extra: Partial<RouteContext> = {}): Promise<Out & { handled: boolean }> {
  const { ctx, out } = makeCtx(method, path, body, extra)
  const handled = await tryHandleBrowserEnroll(ctx)
  return { ...out, handled }
}

const enroll = (code: unknown) => run('POST', '/api/auth/enroll-browser', { code })
const issue = (extra: Partial<RouteContext> = {}) => run('POST', '/api/admin/browser-enroll-codes', {}, extra)

beforeEach(() => {
  initDatabase(':memory:')
  _resetEnrollCodesForTest()
})

describe('POST /api/auth/enroll-browser', () => {
  it('is a public path, for POST only', () => {
    expect(requiresAuth('/api/auth/enroll-browser', 'POST')).toBe(false)
    expect(requiresAuth('/api/auth/enroll-browser', 'GET')).toBe(true)
    expect(requiresAuth('/api/admin/browser-enroll-codes', 'POST')).toBe(true)
  })

  it('trades a code for a named admin token the gate resolves', async () => {
    const { code } = issueEnrollCode()
    const r = await enroll(code)
    expect(r.status).toBe(201)
    expect(r.body.token).toMatch(/^[0-9a-f]{64}$/)
    expect(r.body.name).toMatch(/^browser \d{4}-\d{2}-\d{2} [0-9a-f]{4}$/)

    const resolved = await resolveApiToken(r.body.token)
    expect(resolved).toMatchObject({ found: true, role: 'admin', tenantId: 'default', name: r.body.name })

    const row = (await getApiTokenRowById(r.body.id))!
    expect(row.expires_at).toBeNull()
    expect(row.revoked_at).toBeNull()
    expect(row.token_hash).not.toBe(r.body.token) // only the hash is stored
  })

  it('works once: a replay of the same code is refused and mints nothing', async () => {
    const { code } = issueEnrollCode()
    expect((await enroll(code)).status).toBe(201)
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }
    const again = await enroll(code)
    expect(again.status).toBe(401)
    expect(again.body.token).toBeUndefined()
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n).toBe(before.n)
  })

  it('refuses a wrong code, a missing code and a non-string code', async () => {
    issueEnrollCode()
    for (const bad of ['nope', '', undefined, 12345, null, { a: 1 }]) {
      const r = await enroll(bad)
      expect(r.status).toBe(401)
      expect(r.body).toMatchObject({ error: 'unauthorized' })
    }
  })

  it('refuses a malformed body', async () => {
    const { ctx, out } = makeCtx('POST', '/api/auth/enroll-browser', '{not json')
    await tryHandleBrowserEnroll(ctx)
    expect(out.status).toBe(400)
  })

  it('throttles repeated wrong codes with 429 and Retry-After, but still accepts a live code', async () => {
    const { code } = issueEnrollCode()
    for (let i = 0; i < 10; i++) expect((await enroll(`wrong-${i}`)).status).toBe(401)
    const blocked = await enroll('wrong-again')
    expect(blocked.status).toBe(429)
    expect(blocked.body).toMatchObject({ error: 'limit_exceeded' })
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0)
    // spraying wrong codes must not lock the legitimate enrollment out
    expect((await enroll(code)).status).toBe(201)
  })

  it('mints a token that is revoked alone: the gate then refuses it, the others stay valid', async () => {
    const a = await enroll(issueEnrollCode().code)
    const b = await enroll(issueEnrollCode().code)
    await revokeApiToken(a.body.id, Math.floor(Date.now() / 1000))
    expect(await resolveApiToken(a.body.token)).toEqual({ found: false, registeredButInvalid: true })
    expect(await resolveApiToken(b.body.token)).toMatchObject({ found: true })
  })

  it('shows up in the token list and revokes through the admin route', async () => {
    const r = await enroll(issueEnrollCode().code)
    const list = makeCtx('GET', '/api/admin/tokens', undefined)
    await tryHandleAdminTokens(list.ctx)
    expect(list.out.body.map((t: { id: number }) => t.id)).toContain(r.body.id)
    expect(JSON.stringify(list.out.body)).not.toContain(r.body.token)

    const del = makeCtx('DELETE', `/api/admin/tokens/${r.body.id}/revoke`, undefined)
    await tryHandleAdminTokens(del.ctx)
    expect(del.out.body).toEqual({ revoked: true, id: r.body.id })
    expect(await resolveApiToken(r.body.token)).toEqual({ found: false, registeredButInvalid: true })
  })
})

describe('POST /api/admin/browser-enroll-codes', () => {
  it('issues a code a browser can then spend', async () => {
    const r = await issue()
    expect(r.status).toBe(201)
    expect(typeof r.body.code).toBe('string')
    expect(r.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect((await enroll(r.body.code)).status).toBe(201)
  })

  it('issues for the shared token, an admin session and a default-tenant admin token', async () => {
    expect((await issue({ auth: { kind: 'token' } })).status).toBe(201)
    expect((await issue({ auth: { kind: 'session', user: 'op' }, tenantId: null })).status).toBe(201)
    expect((await issue({ auth: { kind: 'token', tokenName: 'ci' }, tenantId: 'default' })).status).toBe(201)
  })

  it('refuses every principal that is not a global admin, and issues no code', async () => {
    const cases: Array<Partial<RouteContext>> = [
      { role: 'viewer' },
      { role: 'agent' },
      { role: 'fleet_agent' },
      { role: 'admin', tenantId: 'acme' }, // a tenant-scoped admin must not mint a default-tenant admin token
      { auth: { kind: 'device', device: 'phone' }, role: 'agent' },
      { auth: { kind: 'federation', peer: 'p' }, role: 'agent' },
      { auth: undefined },
    ]
    for (const c of cases) {
      const r = await issue(c)
      expect(r.status).toBe(403)
      expect(r.body.code).toBeUndefined()
    }
  })

  it('does not handle other paths or methods', async () => {
    expect((await run('GET', '/api/admin/browser-enroll-codes')).handled).toBe(false)
    expect((await run('GET', '/api/auth/enroll-browser')).handled).toBe(false)
    expect((await run('POST', '/api/auth/login', {})).handled).toBe(false)
  })
})

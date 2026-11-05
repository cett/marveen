// A token with an empty / whitespace / unknown tenant_id. Every token writer refuses it (the route with a 400,
// insertApiToken and rotateApiToken by throwing), and a row that is already bad (hand-written, or made before the
// check) is a 403 at the gate over real HTTP, never the 500 the request context's non-empty id check used to throw
// and never a fallback to the 'default' tenant (that would be a privilege escalation).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  initDatabase, insertApiToken, rotateApiToken, listApiTokenRows, getApiTokenRowById, createTenant, dbx,
  assertValidTokenTenant, InvalidTokenTenantError,
} from '../db.js'
import { tryHandleAdminTokens } from '../web/routes/tokens.js'
import { resolveAuth, answerInvalidTenantToken } from '../web/auth-gate.js'
import { checkPermission, resolveTenantId } from '../web/authz.js'
import { runAsRequest } from '../db/background-jobs.js'
import type { RouteContext } from '../web/routes/types.js'

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex')
const NOW = Math.floor(Date.now() / 1000)
const DASHBOARD_TOKEN = 'd'.repeat(64)

// The tenants of the boundary table: '' / spaces / tab-newline / Unicode spaces (NBSP, EM SPACE, IDEOGRAPHIC SPACE),
// which the SQL trim() does not strip but JS trim() does.
const BLANKS = ['', '   ', '\t\n', '\u00a0', '\u2003', '\u3000 ']

/** A hand-written row, the way an old or tampered db could hold one: the writers refuse these, so it is raw SQL. */
async function rawTokenRow(raw: string, name: string, tenantId: string, role = 'admin'): Promise<void> {
  await dbx.run('INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)', sha(raw), name, role, tenantId, NOW)
}

function call(method: string, path: string, body: object): Promise<{ status: number; body: any }> {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: any) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path, method, url, role: 'admin', auth: { kind: 'session', user: 'admin-user' } } as RouteContext
  return tryHandleAdminTokens(ctx).then(() => out)
}
const create = (body: object) => call('POST', '/api/admin/tokens', body)

beforeEach(async () => {
  initDatabase(':memory:')
  await createTenant('acme', 'Acme')
})

describe('assertValidTokenTenant: the one check of every token writer', () => {
  it.each(BLANKS.map((b) => [JSON.stringify(b), b]))('blank tenant %s: blank', async (_l, t) => {
    await expect(assertValidTokenTenant(t)).rejects.toMatchObject({ name: 'InvalidTokenTenantError', reason: 'blank' })
  })
  it.each([[undefined], [null], [0], [42], [true], [{}], [[]]])('non-string %j: not_string', async (t) => {
    await expect(assertValidTokenTenant(t)).rejects.toMatchObject({ reason: 'not_string' })
  })
  it.each([['no-such-tenant'], [' acme'], ['acme '], ['ACME'], ['acme\u00a0']])('unknown tenant %j: unknown', async (t) => {
    await expect(assertValidTokenTenant(t)).rejects.toMatchObject({ reason: 'unknown' })
  })
  it("'default' and an existing tenant pass, returned as they are", async () => {
    await expect(assertValidTokenTenant('default')).resolves.toBe('default')
    await expect(assertValidTokenTenant('acme')).resolves.toBe('acme')
  })
})

describe('the writers: insertApiToken and rotateApiToken refuse a bad tenant themselves', () => {
  it.each([...BLANKS.map((b) => [JSON.stringify(b), b]), ['unknown', 'no-such-tenant']])('insertApiToken(%s): throws, nothing stored', async (_l, tenantId) => {
    await expect(insertApiToken({ tokenHash: sha('x'), name: 'x', role: 'admin', tenantId, createdAt: NOW, expiresAt: null }))
      .rejects.toBeInstanceOf(InvalidTokenTenantError)
    expect(await listApiTokenRows()).toHaveLength(0)
  })

  it("insertApiToken: 'default' and an existing tenant still store", async () => {
    expect((await insertApiToken({ tokenHash: sha('a'), name: 'a', role: 'admin', tenantId: 'default', createdAt: NOW, expiresAt: null })).tenant_id).toBe('default')
    expect((await insertApiToken({ tokenHash: sha('b'), name: 'b', role: 'viewer', tenantId: 'acme', createdAt: NOW, expiresAt: null })).tenant_id).toBe('acme')
  })

  it.each([['empty', ''], ['spaces', '  '], ['EM SPACE', '\u2003'], ['unknown', 'gone-tenant']])('rotateApiToken of a row with a %s tenant: throws and the old token stays active', async (_l, tenantId) => {
    await rawTokenRow('old-bad', 'old-bad', tenantId)
    const old = (await listApiTokenRows())[0]
    await expect(rotateApiToken(old, sha('new-hash'), NOW, null)).rejects.toBeInstanceOf(InvalidTokenTenantError)
    const after = await getApiTokenRowById(old.id)
    expect(after?.revoked_at).toBeNull()
    expect(await listApiTokenRows()).toHaveLength(1)
  })

  // The tenant lookup of a rotation runs on the transaction handle, not on the facade (on PostgreSQL a facade call is
  // another connection, outside the transaction that revokes and inserts). The control: insertApiToken, which has no
  // transaction, DOES reach the facade with the same lookup, so the spy would see it.
  it('rotateApiToken looks the tenant up on the transaction handle, never on the facade', async () => {
    const tenantLookups = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => String(c[0]).includes('FROM tenants')).length
    const old = await insertApiToken({ tokenHash: sha('rot-handle'), name: 'rot-handle', role: 'admin', tenantId: 'acme', createdAt: NOW, expiresAt: null })
    const getSpy = vi.spyOn(dbx, 'get')
    try {
      await insertApiToken({ tokenHash: sha('control'), name: 'control', role: 'admin', tenantId: 'acme', createdAt: NOW, expiresAt: null })
      expect(tenantLookups(getSpy)).toBe(1)
      getSpy.mockClear()
      await rotateApiToken(old, sha('rot-handle-next'), NOW, null)
      expect(tenantLookups(getSpy)).toBe(0)
    } finally {
      getSpy.mockRestore()
    }
  })

  it('rotateApiToken of a good row still rotates, tenant carried over', async () => {
    const old = await insertApiToken({ tokenHash: sha('old-good'), name: 'old-good', role: 'admin', tenantId: 'acme', createdAt: NOW, expiresAt: null })
    const next = await rotateApiToken(old, sha('new-good'), NOW, null)
    expect(next.tenant_id).toBe('acme')
    expect((await getApiTokenRowById(old.id))?.revoked_at).toBe(NOW)
  })
})

describe('POST /api/admin/tokens and the rotate route', () => {
  it.each(BLANKS.map((b) => [JSON.stringify(b), b]))('tenant_id %s: 400 invalid_value, nothing stored', async (_l, tenant_id) => {
    const out = await create({ name: 'bad-tenant', role: 'admin', tenant_id })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'tenant_id' })
    expect(await listApiTokenRows()).toHaveLength(0)
  })

  it('a tenant_id that is not a string: 400', async () => {
    for (const tenant_id of [0, 42, true, {}, []]) {
      const out = await create({ name: 'bad-type', role: 'admin', tenant_id })
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'tenant_id' })
    }
    expect(await listApiTokenRows()).toHaveLength(0)
  })

  it('a tenant that does not exist: 400 invalid_value, nothing stored', async () => {
    const out = await create({ name: 'ghost', role: 'admin', tenant_id: 'no-such-tenant' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'tenant_id' })
    expect(await listApiTokenRows()).toHaveLength(0)
  })

  it('an omitted or null tenant_id is the neutral default: 201', async () => {
    const omitted = await create({ name: 'omitted', role: 'admin' })
    expect(omitted.status).toBe(201)
    expect(omitted.body.tenant_id).toBe('default')
    const nulled = await create({ name: 'nulled', role: 'admin', tenant_id: null })
    expect(nulled.status).toBe(201)
    expect(nulled.body.tenant_id).toBe('default')
  })

  it("'default' and an existing tenant (padded with spaces) work: 201 with the trimmed id", async () => {
    expect((await create({ name: 'def', role: 'admin', tenant_id: 'default' })).status).toBe(201)
    const out = await create({ name: 'acme-admin', role: 'admin', tenant_id: '  acme  ' })
    expect(out.status).toBe(201)
    expect(out.body.tenant_id).toBe('acme')
  })

  it('rotating a hand-written row with a blank tenant: 400 invalid_value, the old token stays active', async () => {
    await rawTokenRow('rot-bad', 'rot-bad', '  ')
    const old = (await listApiTokenRows())[0]
    const out = await call('POST', `/api/admin/tokens/${old.id}/rotate`, {})
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'tenant_id' })
    expect((await getApiTokenRowById(old.id))?.revoked_at).toBeNull()
  })

  it('rotating a good row through the route still works: 200', async () => {
    const old = await insertApiToken({ tokenHash: sha('rot-good'), name: 'rot-good', role: 'admin', tenantId: 'acme', createdAt: NOW, expiresAt: null })
    const out = await call('POST', `/api/admin/tokens/${old.id}/rotate`, {})
    expect(out.status).toBe(200)
    expect(out.body.tenant_id).toBe('acme')
  })
})

function bearerReq(raw: string): http.IncomingMessage {
  return { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
}

describe('a token row that already has a blank tenant (resolveAuth, RBAC)', () => {
  it.each(BLANKS.map((b) => [JSON.stringify(b), b]))('tenant %s: resolveAuth names no tenant', async (_l, tenantId) => {
    await rawTokenRow('bad-row', 'bad-row', tenantId)
    const auth = await resolveAuth(bearerReq('bad-row'), new URL('http://x/api/memories'), '/api/memories', 'GET', DASHBOARD_TOKEN, true)
    expect(auth).toEqual({ kind: 'token', role: 'admin', tokenName: 'bad-row', tenantInvalid: true })
    expect('tenantId' in auth).toBe(false)
  })

  it('the RBAC check refuses it with 403 for every method and path', () => {
    const auth = { kind: 'token' as const, role: 'admin' as const, tokenName: 'bad-row', tenantInvalid: true }
    for (const [method, path] of [['GET', '/api/memories'], ['POST', '/api/admin/tokens'], ['GET', '/api/kanban']]) {
      expect(checkPermission(auth, method, path)).toMatchObject({ allowed: false, status: 403 })
    }
  })

  it('a good row is untouched: no tenantInvalid flag, its own tenant', async () => {
    await insertApiToken({ tokenHash: sha('good-row'), name: 'good-row', role: 'admin', tenantId: 'acme', createdAt: NOW, expiresAt: null })
    const auth = await resolveAuth(bearerReq('good-row'), new URL('http://x/api/memories'), '/api/memories', 'GET', DASHBOARD_TOKEN, true)
    expect(auth).toEqual({ kind: 'token', role: 'admin', tenantId: 'acme', tokenName: 'good-row' })
  })

  it("a default-tenant token is untouched: it keeps the 'default' scope", async () => {
    await insertApiToken({ tokenHash: sha('def-row'), name: 'def-row', role: 'admin', tenantId: 'default', createdAt: NOW, expiresAt: null })
    const auth = await resolveAuth(bearerReq('def-row'), new URL('http://x/api/memories'), '/api/memories', 'GET', DASHBOARD_TOKEN, true)
    expect(auth).toEqual({ kind: 'token', role: 'admin', tenantId: 'default', tokenName: 'def-row' })
  })

  it('a bad row with the dashboard token hash does not fall through to the file-token lane', async () => {
    await rawTokenRow(DASHBOARD_TOKEN, 'dashboard-copy', '')
    const auth = await resolveAuth(bearerReq(DASHBOARD_TOKEN), new URL('http://x/api/memories'), '/api/memories', 'GET', DASHBOARD_TOKEN, true)
    expect(auth).toMatchObject({ kind: 'token', tenantInvalid: true })
  })

  it("the negative that matters: a token without a tenant is never given the 'default' scope by the gate", async () => {
    await rawTokenRow('bad-row', 'bad-row', '')
    const auth = await resolveAuth(bearerReq('bad-row'), new URL('http://x/api/memories'), '/api/memories', 'GET', DASHBOARD_TOKEN, true)
    // resolveTenantId alone WOULD answer 'default' for it: that is why the gate answers before it is ever asked.
    expect(resolveTenantId(auth)).toBe('default')
    const res = { writeHead: () => undefined, end: () => undefined } as unknown as http.ServerResponse
    expect(answerInvalidTenantToken(auth, '/api/memories', 'GET', res)).toBe(true)
  })

  it('pins why the gate is needed: opening the request context with an empty tenant throws', () => {
    expect(() => runAsRequest({ authenticated: true, role: 'admin', tenantId: '' }, () => 1)).toThrow(/non-empty id/)
  })
})

// The gate over a real HTTP connection, wired the way web.ts wires it: resolveAuth, answerInvalidTenantToken, then
// the route (here a stand-in that opens the request context, which is where the 500 used to come from).
describe('over real HTTP: a bad row is a 403, not a 500, and the request does not run on', () => {
  let server: http.Server
  let port: number
  let reached = 0

  beforeEach(async () => {
    reached = 0
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
          const auth = await resolveAuth(req, url, url.pathname, req.method ?? 'GET', DASHBOARD_TOKEN, true)
          if (auth.kind === 'none') { res.writeHead(401); res.end('{}'); return }
          if (answerInvalidTenantToken(auth, url.pathname, req.method ?? 'GET', res)) return
          const tenantId = resolveTenantId(auth)
          runAsRequest({ authenticated: true, role: 'admin', tenantId }, () => { reached++ })
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
        } catch {
          res.writeHead(500); res.end('{}')
        }
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const get = (raw: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/memories', headers: { authorization: `Bearer ${raw}` } }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    }).on('error', reject)
  })

  it.each([['empty', ''], ['spaces', '   '], ['EM SPACE', '\u2003']])('%s tenant: 403 forbidden, the route never ran', async (_l, tenantId) => {
    await rawTokenRow('http-bad', 'http-bad', tenantId)
    const r = await get('http-bad')
    expect(r.status).toBe(403)
    expect(JSON.parse(r.body)).toMatchObject({ error: 'forbidden' })
    expect(reached).toBe(0)
  })

  it('a default-tenant admin token: 200, the route ran', async () => {
    await insertApiToken({ tokenHash: sha('http-good'), name: 'http-good', role: 'admin', tenantId: 'default', createdAt: NOW, expiresAt: null })
    const r = await get('http-good')
    expect(r.status).toBe(200)
    expect(reached).toBe(1)
  })
})

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// No config.js mock needed here (unlike costops-budgets-routes.test.ts) --
// this route is DB-only, it never touches STORE_DIR. initDatabase(':memory:')
// still needs a real path for its own bookkeeping.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'egress-allowlist-routes-test-'))

import { initDatabase } from '../db.js'
import { tryHandleEgressAllowlist } from '../web/routes/egress-allowlist.js'

function makeCtx(opts: {
  method: string
  path: string
  body?: object
  role?: RouteContext['role']
  tenantId?: string | null
}): { ctx: RouteContext; status: () => number; body: () => any } {
  const raw = opts.body ? JSON.stringify(opts.body) : ''
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: {
      req: em as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      path: url.pathname,
      method: opts.method,
      url,
      auth: { kind: 'session', user: 'tester' },
      role: opts.role,
      tenantId: opts.tenantId,
    } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeEach(() => {
  initDatabase(':memory:')
})

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('GET /api/egress-allowlist', () => {
  it('admin with no ?tenant sees the full migration-seeded set, reshaped for the hook', async () => {
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(ctx)
    const b = body()
    expect(b.rows).toHaveLength(206)
    expect(b.domains).toHaveLength(206)
    expect(b.domains).toContain('github.com')
    expect(b.prefixes).toEqual([])
    expect(b.quarantine_domains).toEqual([])
  })

  it('non-admin sees only their own tenant, not the fleet-wide default seed', async () => {
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'viewer', tenantId: 'eszter' })
    await tryHandleEgressAllowlist(ctx)
    expect(body().rows).toEqual([])
  })
})

describe('POST /api/egress-allowlist', () => {
  it('admin adds a domain to the default tenant', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/egress-allowlist', role: 'admin',
      body: { value: 'partner.example.com', type: 'domain' },
    })
    await tryHandleEgressAllowlist(ctx)
    expect(status()).toBe(201)
    expect(body().ok).toBe(true)

    const { ctx: getCtx, body: getBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(getCtx)
    expect(getBody().domains).toContain('partner.example.com')
  })

  it('non-admin POST is rejected with 403, never silently written -- a tenant-scoped write would still expand what EVERY tenant\'s WebFetch calls can reach, since the hook enforces the cross-tenant union', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/egress-allowlist', role: 'viewer', tenantId: 'eszter',
      body: { value: 'eszter-only.example.com', type: 'domain' },
    })
    await tryHandleEgressAllowlist(ctx)
    expect(status()).toBe(403)
    expect(body().error).toBe('forbidden')

    const { ctx: adminCtx, body: adminBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(adminCtx)
    expect(adminBody().rows.some((r: any) => r.value === 'eszter-only.example.com')).toBe(false)
  })

  it('rejects an IP literal / localhost as a domain (same guard as the quarantine-reader render)', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/egress-allowlist', role: 'admin',
      body: { value: '169.254.169.254', type: 'domain' },
    })
    await tryHandleEgressAllowlist(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('invalid_value')
  })

  it('rejects an unknown type', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/egress-allowlist', role: 'admin',
      body: { value: 'example.com', type: 'bogus' },
    })
    await tryHandleEgressAllowlist(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('invalid_value')
  })

  it('a duplicate insert is a no-op success, not a conflict', async () => {
    const one = makeCtx({ method: 'POST', path: '/api/egress-allowlist', role: 'admin', body: { value: 'github.com', type: 'domain' } })
    await tryHandleEgressAllowlist(one.ctx)
    expect(one.status()).toBe(201)

    const { ctx: getCtx, body: getBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(getCtx)
    // Still 206 -- github.com was already seeded, INSERT OR IGNORE didn't duplicate it.
    expect(getBody().rows).toHaveLength(206)
  })
})

describe('DELETE /api/egress-allowlist/:id', () => {
  it('admin deletes any tenant\'s row', async () => {
    const { ctx: getCtx, body: getBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(getCtx)
    const target = getBody().rows[0]

    const del = makeCtx({ method: 'DELETE', path: `/api/egress-allowlist/${target.id}`, role: 'admin' })
    await tryHandleEgressAllowlist(del.ctx)
    expect(del.status()).toBe(200)

    const { ctx: after, body: afterBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(after)
    expect(afterBody().rows).toHaveLength(205)
  })

  it('non-admin DELETE is rejected with 403, regardless of tenant', async () => {
    const { ctx: getCtx, body: getBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(getCtx)
    const target = getBody().rows[0] // tenant_id: 'default'

    const del = makeCtx({ method: 'DELETE', path: `/api/egress-allowlist/${target.id}`, role: 'viewer', tenantId: 'eszter' })
    await tryHandleEgressAllowlist(del.ctx)
    expect(del.status()).toBe(403)
    expect(del.body().error).toBe('forbidden')

    const { ctx: after, body: afterBody } = makeCtx({ method: 'GET', path: '/api/egress-allowlist', role: 'admin' })
    await tryHandleEgressAllowlist(after)
    expect(afterBody().rows).toHaveLength(206) // untouched
  })
})

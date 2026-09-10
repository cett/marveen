// #751 step 4: src/web/routes/fleet.ts (export/import HTTP wiring around the
// already-tested crypto/serialization in fleet-transfer.ts) was at 0%.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => {
  class MockUserFacingError extends Error {}
  return {
    exportFleet: vi.fn(),
    importFleet: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    MockUserFacingError,
  }
})


vi.mock('../logger.js', () => ({ logger: mocks.logger }))
vi.mock('../web/fleet-transfer.js', () => ({
  exportFleet: mocks.exportFleet,
  importFleet: mocks.importFleet,
  MIN_VAULT_PASSWORD_LEN: 8,
  UserFacingError: mocks.MockUserFacingError,
}))

import { tryHandleFleet } from '../web/routes/fleet.js'

function makeCtx(opts: { method: string; path: string; headers?: Record<string, string>; body?: object | string; bodyError?: boolean }): {
  ctx: RouteContext; status: () => number; headers: () => Record<string, any>; rawBody: () => Buffer | undefined
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = opts.headers ?? {}
  setImmediate(() => {
    if (opts.bodyError) { em.emit('error', new Error('boom')); return }
    if (raw) em.emit('data', Buffer.from(raw))
    em.emit('end')
  })
  let code = 200
  let resHeaders: Record<string, any> = {}
  let endArg: Buffer | string | undefined
  const res = {
    writeHead: (c: number, h?: Record<string, any>) => { code = c; if (h) resHeaders = { ...resHeaders, ...h } },
    setHeader: (k: string, v: any) => { resHeaders[k] = v },
    end: (d?: Buffer | string) => { endArg = d },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    headers: () => resHeaders,
    rawBody: () => (endArg === undefined ? undefined : (Buffer.isBuffer(endArg) ? endArg : Buffer.from(endArg))),
  }
}

describe('tryHandleFleet -- GET /api/fleet/export', () => {
  it('exports and returns an attachment with the right headers', async () => {
    mocks.exportFleet.mockReturnValueOnce({ data: '{"ok":true}', exportedAt: '2026-09-09T12:00:00.000Z' })
    const { ctx, status, headers, rawBody } = makeCtx({ method: 'GET', path: '/api/fleet/export' })
    const handled = await tryHandleFleet(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(headers()['Content-Disposition']).toBe('attachment; filename="fleet-export-2026-09-09.json"')
    expect(rawBody()?.toString()).toBe('{"ok":true}')
    expect(mocks.exportFleet).toHaveBeenCalledWith({ vaultPassword: undefined })
  })

  it('passes the X-Vault-Password header through when long enough', async () => {
    mocks.exportFleet.mockReturnValueOnce({ data: '{}', exportedAt: '2026-09-09T12:00:00.000Z' })
    const { ctx } = makeCtx({ method: 'GET', path: '/api/fleet/export', headers: { 'x-vault-password': 'longenough' } })
    await tryHandleFleet(ctx)
    expect(mocks.exportFleet).toHaveBeenCalledWith({ vaultPassword: 'longenough' })
  })

  it('returns 400 when the vault password header is too short', async () => {
    const { ctx, status, headers } = makeCtx({ method: 'GET', path: '/api/fleet/export', headers: { 'x-vault-password': 'short' } })
    await tryHandleFleet(ctx)
    expect(status()).toBe(400)
    expect(headers()['Content-Type']).toMatch(/^application\/json/)
    expect(mocks.exportFleet).not.toHaveBeenCalled()
  })

  it('returns 400 invalid_value when exportFleet throws a UserFacingError', async () => {
    mocks.exportFleet.mockImplementationOnce(() => { throw new mocks.MockUserFacingError('vault locked') })
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/fleet/export' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(400)
  })

  it('returns 500 internal_error when exportFleet throws a generic error', async () => {
    mocks.exportFleet.mockImplementationOnce(() => { throw new Error('disk full') })
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/fleet/export' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(500)
  })
})

describe('tryHandleFleet -- POST /api/fleet/import', () => {
  it('returns 400 when the vault password header is too short', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/fleet/import', headers: { 'x-vault-password': 'x' } })
    await tryHandleFleet(ctx)
    expect(status()).toBe(400)
    expect(mocks.importFleet).not.toHaveBeenCalled()
  })

  it('returns 400 parse_error when the body cannot be read', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/fleet/import', bodyError: true })
    await tryHandleFleet(ctx)
    expect(status()).toBe(400)
    expect(mocks.importFleet).not.toHaveBeenCalled()
  })

  it('returns 200 on a clean apply, forwarding apply=true and the raw body', async () => {
    mocks.importFleet.mockReturnValueOnce({ ok: true })
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/fleet/import?apply=true', body: '{"agents":[]}' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(200)
    expect(mocks.importFleet).toHaveBeenCalledWith('{"agents":[]}', { vaultPassword: undefined, apply: true })
  })

  it('returns 400 for a dry run that reports errors', async () => {
    mocks.importFleet.mockReturnValueOnce({ dryRun: true, errors: ['bad shape'] })
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/fleet/import', body: '{}' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(400)
  })

  it('returns 200 for a dry run with no errors', async () => {
    mocks.importFleet.mockReturnValueOnce({ dryRun: true, errors: [] })
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/fleet/import', body: '{}' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(200)
  })

  it('returns 500 internal_error when importFleet throws', async () => {
    mocks.importFleet.mockImplementationOnce(() => { throw new Error('corrupt') })
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/fleet/import', body: '{}' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(500)
  })
})

describe('tryHandleFleet -- unmatched routes', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/other' })
    expect(await tryHandleFleet(ctx)).toBe(false)
  })

  it('returns false for /api/fleet/export with the wrong method', async () => {
    const { ctx } = makeCtx({ method: 'POST', path: '/api/fleet/export' })
    expect(await tryHandleFleet(ctx)).toBe(false)
  })
})

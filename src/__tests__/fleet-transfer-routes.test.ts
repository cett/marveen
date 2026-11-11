// #751 step 4: src/web/routes/fleet.ts (export/import HTTP wiring around the
// already-tested crypto/serialization in fleet-transfer.ts) was at 0%.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => {
  class MockUserFacingError extends Error {}
  class MockImportConflictError extends Error {}
  class MockAutonomyImportRefusedError extends Error {}
  return {
    exportFleet: vi.fn(),
    importFleet: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    MockUserFacingError,
    MockImportConflictError,
    MockAutonomyImportRefusedError,
    humanSessionOf: vi.fn(),
  }
})
vi.mock('../web/approval-human-only.js', () => ({ humanSessionOf: (req: unknown) => mocks.humanSessionOf(req) }))


vi.mock('../logger.js', () => ({ logger: mocks.logger }))
vi.mock('../web/fleet-transfer.js', () => ({
  exportFleet: mocks.exportFleet,
  importFleet: mocks.importFleet,
  MIN_VAULT_PASSWORD_LEN: 8,
  UserFacingError: mocks.MockUserFacingError,
  ImportConflictError: mocks.MockImportConflictError,
  AutonomyImportRefusedError: mocks.MockAutonomyImportRefusedError,
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
    // no session cookie, no auth in this fixture: the apply goes in without a human session and under the system actor
    expect(mocks.importFleet).toHaveBeenCalledWith('{"agents":[]}', { vaultPassword: undefined, apply: true, humanSession: false, actor: 'system' })
  })

  describe('the autonomy rows of an apply', () => {
    it('a request with a dashboard session is passed on as humanSession, with the session user as the actor', async () => {
      mocks.humanSessionOf.mockResolvedValueOnce({ user: 'owner' })
      mocks.importFleet.mockReturnValueOnce({ ok: true })
      const { ctx } = makeCtx({ method: 'POST', path: '/api/fleet/import?apply=true', body: '{"agents":[]}' })
      ctx.auth = { kind: 'session', user: 'owner' } as RouteContext['auth']
      await tryHandleFleet(ctx)
      expect(mocks.importFleet).toHaveBeenCalledWith('{"agents":[]}', { vaultPassword: undefined, apply: true, humanSession: true, actor: 'owner' })
    })

    it('a token request is passed on as no human session, with the token name as the actor', async () => {
      mocks.humanSessionOf.mockResolvedValueOnce(null)
      mocks.importFleet.mockReturnValueOnce({ ok: true })
      const { ctx } = makeCtx({ method: 'POST', path: '/api/fleet/import?apply=true', body: '{"agents":[]}' })
      ctx.auth = { kind: 'token', tokenName: 'main-token' } as RouteContext['auth']
      await tryHandleFleet(ctx)
      expect(mocks.importFleet).toHaveBeenCalledWith('{"agents":[]}', { vaultPassword: undefined, apply: true, humanSession: false, actor: 'main-token' })
    })

    it('a dry run does not look for a session at all', async () => {
      mocks.importFleet.mockReturnValueOnce({ dryRun: true, errors: [] })
      const { ctx } = makeCtx({ method: 'POST', path: '/api/fleet/import', body: '{"agents":[]}' })
      await tryHandleFleet(ctx)
      expect(mocks.humanSessionOf).not.toHaveBeenCalled()
      expect(mocks.importFleet).toHaveBeenCalledWith('{"agents":[]}', expect.objectContaining({ apply: false, humanSession: false }))
    })

    it('a refusal for the missing session is a 403 forbidden with the human_session_required code', async () => {
      mocks.importFleet.mockImplementationOnce(() => { throw Object.assign(new mocks.MockAutonomyImportRefusedError('widens skill_patch'), { kind: 'human_session_required' }) })
      const { ctx, status, rawBody } = makeCtx({ method: 'POST', path: '/api/fleet/import?apply=true', body: '{"agents":[]}' })
      await tryHandleFleet(ctx)
      expect(status()).toBe(403)
      expect(JSON.parse(rawBody()!.toString())).toMatchObject({ error: 'forbidden', code: 'human_session_required', hint: 'widens skill_patch' })
    })

    it('an invalid autonomy row is a 400 invalid_value naming the field', async () => {
      mocks.importFleet.mockImplementationOnce(() => { throw Object.assign(new mocks.MockAutonomyImportRefusedError('autonomy row "x": level must be an integer from 1 to 3'), { kind: 'invalid_value', field: 'level' }) })
      const { ctx, status, rawBody } = makeCtx({ method: 'POST', path: '/api/fleet/import?apply=true', body: '{"agents":[]}' })
      await tryHandleFleet(ctx)
      expect(status()).toBe(400)
      expect(JSON.parse(rawBody()!.toString())).toMatchObject({ error: 'invalid_value', field: 'level' })
    })
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

  it('returns 409 conflict with the hint when the import cannot run (a backup left behind, an import in progress), and does not log it as a failure', async () => {
    mocks.importFleet.mockImplementationOnce(() => { throw new mocks.MockImportConflictError('stale backup: restore or remove it') })
    mocks.logger.error.mockClear()
    const { ctx, status, rawBody } = makeCtx({ method: 'POST', path: '/api/fleet/import', body: '{}' })
    await tryHandleFleet(ctx)
    expect(status()).toBe(409)
    expect(JSON.parse(rawBody()!.toString())).toEqual({ error: 'conflict', hint: 'stale backup: restore or remove it' })
    expect(mocks.logger.error).not.toHaveBeenCalled()
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

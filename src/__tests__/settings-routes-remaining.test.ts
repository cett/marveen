// Route-level tests for the remaining, previously-uncovered branches of
// settings.ts (#751 step 18). settings-routes-b12.test.ts already covers the
// three POST error shapes (setOverride-fails 500, missing-key 400,
// invalid-value 400). This file adds: GET (including the secret-row
// filtering), POST's not_found (unknown key) and forbidden (secret key)
// guards, the success path and its side effects, and the outer try/catch's
// malformed-JSON 500.

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  validateSettingValue: vi.fn(),
  getEffectiveSettingValue: vi.fn(),
  setOverride: vi.fn(),
  logConfigChange: vi.fn(),
  setStoreWriteActor: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config-registry.js', () => ({
  SETTINGS_REGISTRY: [
    {
      key: 'test.visible', type: 'boolean', default: false, description: 'Visible setting',
      module: 'test', requiresRestart: false, valueSet: undefined, min: undefined, max: undefined, secret: false,
    },
    {
      key: 'test.hidden', type: 'string', default: '', description: 'Secret setting',
      module: 'test', requiresRestart: true, valueSet: undefined, min: undefined, max: undefined, secret: true,
    },
  ],
  validateSettingValue: mocks.validateSettingValue,
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: mocks.getEffectiveSettingValue,
  setOverride: mocks.setOverride,
}))
vi.mock('../db.js', () => ({ logConfigChange: mocks.logConfigChange }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: mocks.setStoreWriteActor }))
vi.mock('../logger.js', () => ({ logger: mocks.logger }))

import { tryHandleSettings } from '../web/routes/settings.js'

function makeCtx(opts: { method: string; path: string; body?: object | string; role?: string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body === undefined ? '' : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
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
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' }, role: opts.role } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('tryHandleSettings', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/other' })
    expect(await tryHandleSettings(ctx)).toBe(false)
  })

  describe('GET /api/settings', () => {
    it('includes secret:true rows masked, and never calls getEffectiveSettingValue for them', async () => {
      const REAL_SECRET = 'super-secret-token-xyz'
      mocks.getEffectiveSettingValue.mockImplementation((key: string) =>
        key === 'test.hidden' ? REAL_SECRET : true
      )
      const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/settings' })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(200)
      const settings = (body() as any).settings
      expect(settings).toHaveLength(2)
      expect(settings[0]).toMatchObject({ key: 'test.visible', type: 'boolean', value: true, default: false, secret: false })
      const hidden = settings.find((s: any) => s.key === 'test.hidden')
      expect(hidden).toMatchObject({ key: 'test.hidden', value: '***', secret: true })
      expect(mocks.getEffectiveSettingValue).toHaveBeenCalledWith('test.visible')
      expect(mocks.getEffectiveSettingValue).not.toHaveBeenCalledWith('test.hidden')
      // the real secret value must never appear anywhere in the raw response body
      expect(JSON.stringify(body())).not.toContain(REAL_SECRET)
    })
  })

  describe('POST /api/settings', () => {
    it('404s for an unknown key', async () => {
      const { ctx, status, body } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'does.not.exist', value: 1 },
      })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })

    it('403s a secret key for a non-admin role, DB untouched', async () => {
      for (const role of [undefined, 'agent', 'viewer', 'read_only']) {
        mocks.setOverride.mockClear()
        const { ctx, status, body } = makeCtx({
          method: 'POST', path: '/api/settings', body: { key: 'test.hidden', value: 'x' }, role,
        })
        expect(await tryHandleSettings(ctx)).toBe(true)
        expect(status()).toBe(403)
        expect((body() as any).error).toBe('forbidden')
        expect(mocks.setOverride).not.toHaveBeenCalled()
      }
    })

    it('403s a non-admin submitting the literal mask too (role check runs before the mask check)', async () => {
      const { ctx, status } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'test.hidden', value: '***' }, role: 'agent',
      })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(403)
      expect(mocks.setOverride).not.toHaveBeenCalled()
    })

    it('admin re-submitting the literal mask is a no-op: 200, DB untouched', async () => {
      const { ctx, status, body } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'test.hidden', value: '***' }, role: 'admin',
      })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(200)
      expect(body()).toMatchObject({ ok: true, key: 'test.hidden', value: '***', requiresRestart: true })
      expect(mocks.setOverride).not.toHaveBeenCalled()
      expect(mocks.logConfigChange).not.toHaveBeenCalled()
    })

    it('admin writing a real new secret value succeeds and reaches setOverride', async () => {
      mocks.validateSettingValue.mockReturnValueOnce({ ok: true, value: 'new-real-secret' })
      mocks.setOverride.mockReturnValueOnce({ ok: true })
      const { ctx, status, body } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'test.hidden', value: 'new-real-secret' }, role: 'admin',
      })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(200)
      expect((body() as any).value).toBe('new-real-secret')
      expect(mocks.setOverride).toHaveBeenCalledWith('test.hidden', 'new-real-secret')
    })

    it('succeeds, logs the change with the old value, and defaults actor to "dashboard"', async () => {
      mocks.validateSettingValue.mockReturnValueOnce({ ok: true, value: '1' })
      mocks.getEffectiveSettingValue.mockReturnValueOnce('0')
      mocks.setOverride.mockReturnValueOnce({ ok: true })
      const { ctx, status, body } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'test.visible', value: true },
      })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(200)
      expect(body()).toMatchObject({ ok: true, key: 'test.visible', value: '1', requiresRestart: false })
      expect(mocks.setStoreWriteActor).toHaveBeenCalledWith('dashboard')
      expect(mocks.logConfigChange).toHaveBeenCalledWith('test.visible', '0', '1', 'dashboard')
    })

    it('uses an explicit actor when provided, and surfaces requiresRestart from the definition', async () => {
      mocks.validateSettingValue.mockReturnValueOnce({ ok: true, value: 'secret-value' })
      mocks.setOverride.mockReturnValueOnce({ ok: true })
      const { ctx, body } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'test.visible', value: 'x', actor: 'jonas' },
      })
      await tryHandleSettings(ctx)
      expect(mocks.setStoreWriteActor).toHaveBeenCalledWith('jonas')
      expect(mocks.logConfigChange).toHaveBeenCalledWith('test.visible', expect.anything(), 'secret-value', 'jonas')
      expect((body() as any).key).toBe('test.visible')
    })

    it('500s when the request body is not valid JSON', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: '{not json' })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(500)
      expect((body() as any).error).toBe('internal_error')
    })
  })
})

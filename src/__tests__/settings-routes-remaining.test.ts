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

function makeCtx(opts: { method: string; path: string; body?: object | string }): {
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
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
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
    it('filters out secret:true rows entirely and shapes the rest', async () => {
      mocks.getEffectiveSettingValue.mockReturnValue(true)
      const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/settings' })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(200)
      const settings = (body() as any).settings
      expect(settings).toHaveLength(1)
      expect(settings[0]).toMatchObject({ key: 'test.visible', type: 'boolean', value: true, default: false })
      expect(settings.some((s: any) => s.key === 'test.hidden')).toBe(false)
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

    it('403s when the key is marked secret', async () => {
      const { ctx, status, body } = makeCtx({
        method: 'POST', path: '/api/settings', body: { key: 'test.hidden', value: 'x' },
      })
      expect(await tryHandleSettings(ctx)).toBe(true)
      expect(status()).toBe(403)
      expect((body() as any).error).toBe('forbidden')
      expect(mocks.setOverride).not.toHaveBeenCalled()
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

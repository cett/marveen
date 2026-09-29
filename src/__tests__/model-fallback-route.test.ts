import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

import { initDatabase, getSystemConfig } from '../db.js'
import { tryHandleModelFallback } from '../web/routes/model-fallback.js'
import { defaultChainForInstall } from '../web/model-fallback-store.js'

function makeCtx(opts: { method: string; path: string; body?: object; rawBody?: string; role?: RouteContext['role'] }): {
  ctx: RouteContext; status: () => number; body: () => any
} {
  const raw = opts.rawBody !== undefined ? opts.rawBody : (opts.body ? JSON.stringify(opts.body) : '')
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
      auth: { kind: 'session', user: 'owner' },
      role: opts.role,
    } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('model-fallback route -- auth gate', () => {
  it('rejects a non-admin caller with 403 on every method', async () => {
    for (const method of ['GET', 'PUT']) {
      const { ctx, status, body } = makeCtx({ method, path: '/api/model-fallback', role: 'viewer' as any })
      await tryHandleModelFallback(ctx)
      expect(status()).toBe(403)
      expect(body().error).toBe('forbidden')
    }
  })

  it('ignores an unrelated path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/other', role: 'admin' })
    expect(await tryHandleModelFallback(ctx)).toBe(false)
  })
})

describe('GET /api/model-fallback', () => {
  it('returns disabled defaults with the install chain when nothing was ever configured', async () => {
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/model-fallback', role: 'admin' })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ enabled: false, chain: defaultChainForInstall(), revertAfterMinutes: 330 })
  })
})

describe('PUT /api/model-fallback', () => {
  it('persists a valid partial update and returns the merged config', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'PUT',
      path: '/api/model-fallback',
      role: 'admin',
      body: { enabled: true, chain: ['a', 'b'], revertAfterMinutes: 45 },
    })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ enabled: true, chain: ['a', 'b'], revertAfterMinutes: 45 })

    const { ctx: getCtx, body: getBody } = makeCtx({ method: 'GET', path: '/api/model-fallback', role: 'admin' })
    await tryHandleModelFallback(getCtx)
    expect(getBody()).toEqual({ enabled: true, chain: ['a', 'b'], revertAfterMinutes: 45 })
  })

  it('rejects invalid JSON', async () => {
    const { ctx, status, body } = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', rawBody: 'not json' })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(400)
    expect(body().error).toBe('parse_error')
  })

  it('rejects a non-boolean enabled', async () => {
    const { ctx, status, body } = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { enabled: 'yes' } })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(400)
    expect(body()).toEqual({ error: 'invalid_value', field: 'enabled', hint: 'enabled must be a boolean' })
  })

  it('rejects a chain that is not an array of non-empty strings', async () => {
    const { ctx, status, body } = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { chain: ['a', ''] } })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(400)
    expect(body().field).toBe('chain')
  })

  it('rejects a single-entry chain', async () => {
    const { ctx, status, body } = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { chain: ['only-one'] } })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(400)
    expect(body().hint).toContain('at least a primary')
  })

  it('rejects a non-positive revertAfterMinutes', async () => {
    const { ctx, status, body } = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { revertAfterMinutes: 0 } })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(400)
    expect(body().field).toBe('revertAfterMinutes')
  })

  it('is a partial merge: an omitted field keeps its previously stored value', async () => {
    const first = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { enabled: true, chain: ['x', 'y'] } })
    await tryHandleModelFallback(first.ctx)

    const second = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { revertAfterMinutes: 90 } })
    await tryHandleModelFallback(second.ctx)
    expect(second.body()).toEqual({ enabled: true, chain: ['x', 'y'], revertAfterMinutes: 90 })
  })

  it('an enabled-only PUT on a fresh install does not bake the computed default chain into system_config', async () => {
    const { ctx, status, body } = makeCtx({ method: 'PUT', path: '/api/model-fallback', role: 'admin', body: { enabled: true } })
    await tryHandleModelFallback(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ enabled: true, chain: defaultChainForInstall(), revertAfterMinutes: 330 })
    expect(getSystemConfig('model_fallback_chain')).toBeUndefined()
    expect(getSystemConfig('model_fallback_revert_after_minutes')).toBeUndefined()
  })
})

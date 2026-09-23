// Real (non-mocked) integration test for the /api/settings route against the
// actual SETTINGS_REGISTRY, the real settings-store.ts (DB-only write path)
// and a real in-memory DB. settings-routes-b12/remaining.test.ts already
// cover the route's branch logic with a synthetic mocked registry -- this
// file proves the real new registry entries (MAIN_AGENT_ID, CHANNEL_PROVIDER,
// WEB_PORT, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID) behave correctly end to end.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleSettings } from '../web/routes/settings.js'
import { initDatabase, getSystemConfig } from '../db.js'
import { existsSync } from 'node:fs'
import { OVERRIDES_PATH } from '../settings-store.js'

function makeCtx(opts: { method: string; path: string; body?: object }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
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
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('POST /api/settings: DB-only write for the new non-secret keys', () => {
  it('WEB_PORT: writes to system_config, never to config-overrides.json', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'WEB_PORT', value: 8080 } })
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect((body() as any).requiresRestart).toBe(true)

    const row = getSystemConfig('WEB_PORT')
    expect(row?.value).toBe('8080')
    expect(row?.source).toBe('db')
    expect(existsSync(OVERRIDES_PATH)).toBe(false)
  })

  it('CHANNEL_PROVIDER: accepts a valid provider and persists it to the DB', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'CHANNEL_PROVIDER', value: 'slack' } })
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect(getSystemConfig('CHANNEL_PROVIDER')?.value).toBe('slack')
  })

  it('CHANNEL_PROVIDER: rejects an unsupported provider and writes nothing', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'CHANNEL_PROVIDER', value: 'whatsapp' } })
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
    expect(getSystemConfig('CHANNEL_PROVIDER')).toBeUndefined()
  })

  it('MAIN_AGENT_ID: writes to the DB and is immediately visible via GET', async () => {
    const post = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'MAIN_AGENT_ID', value: 'acmeai' } })
    expect(await tryHandleSettings(post.ctx)).toBe(true)
    expect(post.status()).toBe(200)

    const get = makeCtx({ method: 'GET', path: '/api/settings' })
    expect(await tryHandleSettings(get.ctx)).toBe(true)
    const settings = (get.body() as any).settings as { key: string; value: unknown }[]
    expect(settings.find((s) => s.key === 'MAIN_AGENT_ID')?.value).toBe('acmeai')
  })
})

describe('POST /api/settings: secret keys stay closed after the DB-only write path change', () => {
  it('TELEGRAM_BOT_TOKEN is still 403 (never gained a write path)', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'TELEGRAM_BOT_TOKEN', value: 'x' } })
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(403)
    expect((body() as any).error).toBe('forbidden')
    expect(getSystemConfig('TELEGRAM_BOT_TOKEN')).toBeUndefined()
  })

  it('ALLOWED_CHAT_ID is still 403 (never gained a write path)', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'ALLOWED_CHAT_ID', value: '12345' } })
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(403)
    expect(getSystemConfig('ALLOWED_CHAT_ID')).toBeUndefined()
  })
})

describe('GET /api/settings: secret keys stay excluded', () => {
  it('does not list TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID', async () => {
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/settings' })
    expect(await tryHandleSettings(ctx)).toBe(true)
    const keys = ((body() as any).settings as { key: string }[]).map((s) => s.key)
    expect(keys).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(keys).not.toContain('ALLOWED_CHAT_ID')
    expect(keys).toContain('MAIN_AGENT_ID')
    expect(keys).toContain('WEB_PORT')
    expect(keys).toContain('CHANNEL_PROVIDER')
  })
})

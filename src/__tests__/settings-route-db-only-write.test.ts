// Real (non-mocked) integration test for the /api/settings route against the
// actual SETTINGS_REGISTRY, the real settings-store.ts (DB-only write path)
// and a real in-memory DB. settings-routes-b12/remaining.test.ts already
// cover the route's branch logic with a synthetic mocked registry -- this
// file proves the real new registry entries (MAIN_AGENT_ID, CHANNEL_PROVIDER,
// WEB_PORT, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID) behave correctly end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Per-test STORE_DIR isolation (test-stability follow-up). STORE_DIR is
// a module-level const in config.ts, resolved once (from MARVEEN_STORE_DIR)
// at import time -- a statically imported db.js/routes/settings.js would
// keep pointing at whatever STORE_DIR (and whatever `db` connection) they
// resolved on the FIRST import, before any test ran. vi.resetModules() +
// dynamic re-import of BOTH modules together (same reset generation) keeps
// tryHandleSettings and getSystemConfig pointed at the SAME `db` connection
// this test's initDatabase() call just (re)initialized.
//
// Before this, this file shared the real worktree store/ directory with
// db-system-config.test.ts and settings-store.test.ts across concurrently-
// running worker processes -- a demonstrated flaky race (reproduced on the
// pre-this-change baseline too: 4 of 5 stress runs failed there from this
// exact cross-file contention).
let dbMod: typeof import('../db.js')
let routesMod: typeof import('../web/routes/settings.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'settings-route-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  ;[dbMod, routesMod] = await Promise.all([import('../db.js'), import('../web/routes/settings.js')])
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

// S8B retired config-overrides.json entirely -- settings-store.ts no longer
// exports a path constant for it. This local path just proves the route
// never (re-)creates the file, computed the same way db-system-config.test.ts
// does for the same reason.
function overridesPath(): string {
  return join(storeDir, 'config-overrides.json')
}

function makeCtx(opts: { method: string; path: string; body?: object; role?: string }): {
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
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' }, role: opts.role } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('POST /api/settings: DB-only write for the new non-secret keys', () => {
  it('WEB_PORT: writes to system_config, never to config-overrides.json', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'WEB_PORT', value: 8080 } })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect((body() as any).requiresRestart).toBe(true)

    const row = dbMod.getSystemConfig('WEB_PORT')
    expect(row?.value).toBe('8080')
    expect(row?.source).toBe('db')
    expect(existsSync(overridesPath())).toBe(false)
  })

  it('CHANNEL_PROVIDER: accepts a valid provider and persists it to the DB', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'CHANNEL_PROVIDER', value: 'slack' } })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect(dbMod.getSystemConfig('CHANNEL_PROVIDER')?.value).toBe('slack')
  })

  it('CHANNEL_PROVIDER: rejects an unsupported provider and writes nothing', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'CHANNEL_PROVIDER', value: 'whatsapp' } })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
    expect(dbMod.getSystemConfig('CHANNEL_PROVIDER')).toBeUndefined()
  })

  it('MAIN_AGENT_ID: writes to the DB and is immediately visible via GET', async () => {
    const post = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'MAIN_AGENT_ID', value: 'acmeai' } })
    expect(await routesMod.tryHandleSettings(post.ctx)).toBe(true)
    expect(post.status()).toBe(200)

    const get = makeCtx({ method: 'GET', path: '/api/settings' })
    expect(await routesMod.tryHandleSettings(get.ctx)).toBe(true)
    const settings = (get.body() as any).settings as { key: string; value: unknown }[]
    expect(settings.find((s) => s.key === 'MAIN_AGENT_ID')?.value).toBe('acmeai')
  })
})

describe('POST /api/settings: secret keys require admin role (S6)', () => {
  it('TELEGRAM_BOT_TOKEN: 403 for a non-admin caller, DB untouched', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'TELEGRAM_BOT_TOKEN', value: 'x' } })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(403)
    expect((body() as any).error).toBe('forbidden')
    expect(dbMod.getSystemConfig('TELEGRAM_BOT_TOKEN')).toBeUndefined()
  })

  it('ALLOWED_CHAT_ID: 403 for a non-admin caller, DB untouched', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/settings', body: { key: 'ALLOWED_CHAT_ID', value: '12345' } })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(403)
    expect(dbMod.getSystemConfig('ALLOWED_CHAT_ID')).toBeUndefined()
  })

  it('TELEGRAM_BOT_TOKEN: admin can write a real value, persisted to the DB', async () => {
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/settings', body: { key: 'TELEGRAM_BOT_TOKEN', value: 'real-bot-token' }, role: 'admin',
    })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect((body() as any).value).toBe('real-bot-token')
    expect(dbMod.getSystemConfig('TELEGRAM_BOT_TOKEN')?.value).toBe('real-bot-token')
  })

  it('TELEGRAM_BOT_TOKEN: admin re-submitting the literal mask is a no-op, real value untouched', async () => {
    const write = makeCtx({
      method: 'POST', path: '/api/settings', body: { key: 'TELEGRAM_BOT_TOKEN', value: 'real-bot-token' }, role: 'admin',
    })
    await routesMod.tryHandleSettings(write.ctx)

    const maskWriteback = makeCtx({
      method: 'POST', path: '/api/settings', body: { key: 'TELEGRAM_BOT_TOKEN', value: '***' }, role: 'admin',
    })
    expect(await routesMod.tryHandleSettings(maskWriteback.ctx)).toBe(true)
    expect(maskWriteback.status()).toBe(200)
    expect(dbMod.getSystemConfig('TELEGRAM_BOT_TOKEN')?.value).toBe('real-bot-token')
  })
})

describe('GET /api/settings: secret keys are listed masked (S6)', () => {
  it('lists TELEGRAM_BOT_TOKEN/ALLOWED_CHAT_ID with the *** mask, never the real value', async () => {
    const write = makeCtx({
      method: 'POST', path: '/api/settings', body: { key: 'TELEGRAM_BOT_TOKEN', value: 'real-bot-token' }, role: 'admin',
    })
    await routesMod.tryHandleSettings(write.ctx)

    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/settings' })
    expect(await routesMod.tryHandleSettings(ctx)).toBe(true)
    const settings = (body() as any).settings as { key: string; value: unknown; secret: boolean }[]
    const token = settings.find((s) => s.key === 'TELEGRAM_BOT_TOKEN')
    expect(token).toMatchObject({ value: '***', secret: true })
    const chatId = settings.find((s) => s.key === 'ALLOWED_CHAT_ID')
    expect(chatId).toMatchObject({ value: '***', secret: true })
    expect(JSON.stringify(body())).not.toContain('real-bot-token')

    const keys = settings.map((s) => s.key)
    expect(keys).toContain('MAIN_AGENT_ID')
    expect(keys).toContain('WEB_PORT')
    expect(keys).toContain('CHANNEL_PROVIDER')
  })
})

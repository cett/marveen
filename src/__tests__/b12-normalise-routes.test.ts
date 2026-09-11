import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// ── mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../logger.js', () => ({ logger: mocks.logger }))
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return { ...orig, existsSync: mocks.existsSync }
})
vi.mock('../db.js', () => ({
  queryAuditLog: vi.fn().mockReturnValue({ entries: [], total: 0 }),
  saveAgentMemory: vi.fn(),
  appendDailyLog: vi.fn(),
  getDailyLog: vi.fn().mockReturnValue(null),
  getDailyLogDates: vi.fn().mockReturnValue([]),
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue(null),
}))
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  OLLAMA_URL: null,
  APP_TZ: 'Europe/Budapest',
}))

// ── helper ───────────────────────────────────────────────────────────────────

function makeCtx(opts: { method: string; path: string; body?: object | string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = {}
  em.url = opts.path
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res, path: url.pathname, method: opts.method, url } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('B12 normalise -- audit-log', () => {
  it('returns invalid_value + 400 for non-numeric "from" param', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/audit-log?from=abc' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('invalid_value')
    expect((body() as any).field).toBe('from')
  })

  it('accepts source=hook and passes it through to queryAuditLog (fleet-audit trail)', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const db = await import('../db.js')
    const settings = await import('../settings-store.js')
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/audit-log?source=agent,hook' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(200)
    expect(vi.mocked(db.queryAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['agent', 'hook'] })
    )
  })

  it('silently drops an unknown source value rather than erroring', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const db = await import('../db.js')
    const settings = await import('../settings-store.js')
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/audit-log?source=hook,bogus' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(200)
    expect(vi.mocked(db.queryAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['hook'] })
    )
  })

  it('defaults offset to 0 and passes it through to queryAuditLog', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const db = await import('../db.js')
    const settings = await import('../settings-store.js')
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/audit-log?source=hook' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(200)
    expect(vi.mocked(db.queryAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 })
    )
  })

  it('passes an explicit offset through to queryAuditLog', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const db = await import('../db.js')
    const settings = await import('../settings-store.js')
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/audit-log?source=hook&offset=400' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(200)
    expect(vi.mocked(db.queryAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 400 })
    )
  })

  it('rejects a non-numeric offset with 400', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const settings = await import('../settings-store.js')
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/audit-log?offset=abc' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(400)
    expect((body() as any).field).toBe('offset')
  })

  it('rejects a negative offset with 400', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const settings = await import('../settings-store.js')
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/audit-log?offset=-5' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(400)
    expect((body() as any).field).toBe('offset')
  })

  it('responds with the real total (not the page length) alongside offset/limit', async () => {
    const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')
    const db = await import('../db.js')
    const settings = await import('../settings-store.js')
    vi.mocked(db.queryAuditLog).mockReturnValueOnce({ entries: [{ id: 1 }] as any, total: 7000 })
    vi.mocked(settings.getEffectiveSettingValue).mockReturnValueOnce(200) // AUDIT_LOG_MAX_ENTRIES
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/audit-log?source=hook&offset=200&limit=200' })
    await tryHandleAuditLog(ctx)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ total: 7000, offset: 200, limit: 200 })
  })
})

describe('B12 normalise -- daily-log', () => {
  it('returns required + 400 + field:content for empty content', async () => {
    const { tryHandleDailyLog } = await import('../web/routes/daily-log.js')
    const { ctx, status, body } = makeCtx({
      method: 'POST',
      path: '/api/daily-log',
      body: { content: '' },
    })
    await tryHandleDailyLog(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('required')
    expect((body() as any).field).toBe('content')
  })
})

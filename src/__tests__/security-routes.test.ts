// Coverage for security routes: bridge enrollment (#751 step 23).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const bridgeEnrollFn = vi.fn()
const logConfigChangeFn = vi.fn()
const notifySecurityEventFn = vi.fn()
const readBodyFn = vi.fn()

vi.mock('/src/web/bridge-enroll.js', () => ({
  bridgeEnroll: (...args: unknown[]) => bridgeEnrollFn(...(args as [])),
  sshDirOverride: vi.fn().mockReturnValue(false),
  RemoteEnrollError: class RemoteEnrollError extends Error { },
}))

vi.mock('/src/db.js', () => ({
  logConfigChange: (...args: unknown[]) => logConfigChangeFn(...(args as [])),
}))

vi.mock('/src/notify.js', () => ({
  notifySecurityEvent: (...args: unknown[]) => notifySecurityEventFn(...(args as [])),
}))

vi.mock('/src/web/http-helpers.js', () => ({
  readBody: (...args: unknown[]) => readBodyFn(...(args as [])),
  json: vi.fn((res: any, body: any, status: number) => {
    res.writeHead(status)
    res.end(JSON.stringify(body))
  }),
}))

import { tryHandleSecurity } from '../web/routes/security.js'

function makeCtx(method: string = 'GET', path: string = '/api/test', auth?: { kind: string }): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: {
      req, res, path: url.pathname, method, url,
      role: 'user' as any,
      tenantId: 'default',
      auth: auth as any,
    } as RouteContext,
    out,
  }
}

describe('security routes (bridge enrollment)', () => {
  // resetAllMocks (not clearAllMocks): clearAllMocks only wipes call history,
  // it leaves queued mockResolvedValueOnce() values in place. The two 403
  // tests below queue a readBody() value that the route never consumes (it
  // short-circuits on the auth check before reaching readBody), so with
  // clearAllMocks that leftover value silently rolled into the NEXT test's
  // readBody() call, drifting every subsequent test's queue by one.
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns false for non-POST requests', async () => {
    const { ctx } = makeCtx('GET', '/api/security/bridge-enroll', { kind: 'token' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(false)
  })

  it('returns false for non-matching path', async () => {
    const { ctx } = makeCtx('POST', '/api/other', { kind: 'token' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(false)
  })

  it('returns 403 when auth is undefined', async () => {
    readBodyFn.mockResolvedValueOnce(Buffer.from('{}'))
    const { ctx, out } = makeCtx('POST', '/api/security/bridge-enroll')
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 403 when auth kind is not token/session', async () => {
    readBodyFn.mockResolvedValueOnce(Buffer.from('{}'))
    const { ctx, out } = makeCtx('POST', '/api/security/bridge-enroll', { kind: 'api_key' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(true)
    expect(out.status).toBe(403)
  })

  it('returns 400 for invalid JSON body', async () => {
    readBodyFn.mockResolvedValueOnce(Buffer.from('invalid json'))
    const { ctx, out } = makeCtx('POST', '/api/security/bridge-enroll', { kind: 'token' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('parse_error')
  })

  it('returns 400 when key_line is missing', async () => {
    readBodyFn.mockResolvedValueOnce(Buffer.from(JSON.stringify({ name: 'device' })))
    const { ctx, out } = makeCtx('POST', '/api/security/bridge-enroll', { kind: 'token' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('key_line')
  })

  it('returns 400 for invalid device name', async () => {
    readBodyFn.mockResolvedValueOnce(Buffer.from(JSON.stringify({
      key_line: 'ssh-ed25519 AAAA... marveen-remote:uuid',
      name: 'invalid@name',
    })))
    const { ctx, out } = makeCtx('POST', '/api/security/bridge-enroll', { kind: 'token' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('name')
  })

  it('returns 201 on successful enrollment', async () => {
    bridgeEnrollFn.mockResolvedValueOnce({
      bundle: 'bundle_data',
      action: 'new_device' as const,
      deviceKeyId: 'device-key-123',
      replacedDeviceKey: undefined,
      installId: 'install-456',
      host: 'example.com',
      hostKeySource: 'provided',
      warnings: [],
    })
    readBodyFn.mockResolvedValueOnce(Buffer.from(JSON.stringify({
      key_line: 'ssh-ed25519 AAAA... marveen-remote:uuid',
      name: 'MyDevice',
      ssh_port: 2222,
    })))

    const { ctx, out } = makeCtx('POST', '/api/security/bridge-enroll', { kind: 'token' })
    const result = await tryHandleSecurity(ctx)
    expect(result).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body.ok).toBe(true)
  })
})

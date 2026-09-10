// Route-level tests for src/web/routes/connectors-hu.ts (connectors.hu CLI
// install/configure/status wrapper). node:child_process.execFile and
// node:fs.existsSync are mocked -- these routes only ever shell out to an
// external CLI and touch the vault, they own no DB state of their own.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const state = vi.hoisted(() => ({
  handler: (_file: string, _args: string[]): { err: Error | null; stdout: string; stderr: string } =>
    ({ err: null, stdout: '', stderr: '' }),
}))

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: unknown, opts: unknown, cb?: unknown) => {
    const actualArgs = Array.isArray(args) ? (args as string[]) : []
    const actualCb = (typeof opts === 'function' ? opts : cb) as (err: Error | null, stdout: string, stderr: string) => void
    const { err, stdout, stderr } = state.handler(file, actualArgs)
    actualCb(err, stdout, stderr)
  },
}))

vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const mockGetSecret = vi.fn<(id: string) => string | null>()
const mockSetSecret = vi.fn()
vi.mock('../web/vault.js', () => ({
  getSecret: (...args: [string]) => mockGetSecret(...args),
  setSecret: (...args: [string, string, string]) => mockSetSecret(...args),
}))

import { existsSync } from 'node:fs'
import { tryHandleConnectorsHu } from '../web/routes/connectors-hu.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSecret.mockReturnValue(null)
  vi.mocked(existsSync).mockReturnValue(false)
  state.handler = () => ({ err: null, stdout: '', stderr: '' })
})

function makeCtx(method: string, path: string, body?: object | string): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext, out }
}

describe('GET /api/connectors-hu/status', () => {
  it('reports not installed / not configured when the CLI is nowhere to be found', async () => {
    state.handler = () => ({ err: new Error('not found'), stdout: '', stderr: '' })
    const { ctx, out } = makeCtx('GET', '/api/connectors-hu/status')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, installed: false, configured: false })
  })

  it('falls back to the local-bin path when `which` finds nothing', async () => {
    state.handler = (file) => file === '/usr/bin/which' ? { err: new Error('not found'), stdout: '', stderr: '' } : { err: null, stdout: '', stderr: '' }
    vi.mocked(existsSync).mockReturnValue(true)
    mockGetSecret.mockReturnValue('a-token')
    const { ctx, out } = makeCtx('GET', '/api/connectors-hu/status')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).installed).toBe(true)
    expect((out.body as any).configured).toBe(true)
  })

  it('reports installed+configured+version when the CLI resolves via which', async () => {
    state.handler = (file, args) => {
      if (file === '/usr/bin/which') return { err: null, stdout: '/usr/local/bin/connectors\n', stderr: '' }
      if (file === 'connectors' && args[0] === '--version') return { err: null, stdout: 'v1.2.3\n', stderr: '' }
      return { err: null, stdout: '', stderr: '' }
    }
    mockGetSecret.mockReturnValue('a-token')
    const { ctx, out } = makeCtx('GET', '/api/connectors-hu/status')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, installed: true, configured: true, version: 'v1.2.3' })
  })

  it('500s when an unexpected error is thrown', async () => {
    mockGetSecret.mockImplementation(() => { throw new Error('vault unavailable') })
    const { ctx, out } = makeCtx('GET', '/api/connectors-hu/status')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(500)
    expect((out.body as any).ok).toBe(false)
  })
})

describe('POST /api/connectors-hu/install', () => {
  it('reports success and the install output', async () => {
    state.handler = (file) => file === '/bin/sh' ? { err: null, stdout: 'installed ok', stderr: '' } : { err: null, stdout: '', stderr: '' }
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/install')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    expect((out.body as any).output).toContain('installed ok')
  })

  it('reports failure without throwing when the install script exits non-zero', async () => {
    state.handler = (file) => file === '/bin/sh' ? { err: new Error('exit 1'), stdout: '', stderr: 'boom' } : { err: null, stdout: '', stderr: '' }
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/install')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(false)
  })

  it('500s when the shell-out itself throws', async () => {
    state.handler = () => { throw new Error('spawn failed') }
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/install')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(500)
    expect((out.body as any).ok).toBe(false)
  })
})

describe('POST /api/connectors-hu/configure', () => {
  it('rejects a missing token', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/configure', { token: '  ' })
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(400)
    expect(mockSetSecret).not.toHaveBeenCalled()
  })

  it('saves the token and skips sync when the CLI is not installed', async () => {
    state.handler = () => ({ err: new Error('not found'), stdout: '', stderr: '' })
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/configure', { token: 'secret-tok' })
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect(mockSetSecret).toHaveBeenCalledWith('CONNECTORS_HU_TOKEN', 'connectors.hu API token', 'secret-tok')
    expect((out.body as any).configured).toBe(true)
    expect((out.body as any).syncOutput).toMatch(/not installed/i)
  })

  it('saves the token and syncs when the CLI is installed', async () => {
    state.handler = (file, args) => {
      if (file === '/usr/bin/which') return { err: null, stdout: '/usr/local/bin/connectors\n', stderr: '' }
      if (file === 'connectors' && args[0] === 'sync') return { err: null, stdout: 'synced 12 items', stderr: '' }
      return { err: null, stdout: '', stderr: '' }
    }
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/configure', { token: 'secret-tok' })
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    expect((out.body as any).syncOutput).toContain('synced 12 items')
  })

  it('reports ok:false when the sync command fails', async () => {
    state.handler = (file, args) => {
      if (file === '/usr/bin/which') return { err: null, stdout: '/usr/local/bin/connectors\n', stderr: '' }
      if (file === 'connectors' && args[0] === 'sync') return { err: new Error('sync failed'), stdout: '', stderr: 'boom' }
      return { err: null, stdout: '', stderr: '' }
    }
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/configure', { token: 'secret-tok' })
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(false)
    expect((out.body as any).configured).toBe(true)
  })

  it('500s on a malformed JSON body', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors-hu/configure', '{not json')
    await tryHandleConnectorsHu(ctx)
    expect(out.status).toBe(500)
    expect((out.body as any).ok).toBe(false)
    expect(mockSetSecret).not.toHaveBeenCalled()
  })
})

// GET /api/admin/rerank-stats: the rerank fallback counter, admin only, named in the RBAC table.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { tryHandleRerankStats } from '../web/routes/rerank-stats.js'
import { ENDPOINT_PERMISSION_TABLE } from '../web/rbac.js'
import { rerank, _setRerankBackendForTests } from '../reranker.js'
import type { RerankBackend } from '../reranker-backend.js'
import type { RouteContext } from '../web/routes/types.js'

function call(method: string, path: string, role = 'admin'): Promise<{ handled: boolean; status: number; body: any }> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role, tenantId: null } as unknown as RouteContext
  return tryHandleRerankStats(ctx).then((handled) => ({ handled, status: out.status, body: out.body }))
}

const failing: RerankBackend = {
  mode: 'worker',
  score: () => Promise.reject(new Error('worker is gone')),
  state: () => ({ workerState: 'down', loadMs: null }),
  dispose: async () => {},
}

beforeEach(() => { _setRerankBackendForTests(failing) })

describe('GET /api/admin/rerank-stats', () => {
  it('reports the calls, the fallbacks by reason and the worker state', async () => {
    await rerank('q', [{ id: 1, content: 'a' } as any, { id: 2, content: 'b' } as any])
    const r = await call('GET', '/api/admin/rerank-stats')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      mode: 'worker', workerState: 'down', calls: 1, reranked: 0, fallbackTotal: 1,
      fallbacks: { timeout: 0, queue_full: 0, error: 1, unavailable: 0 },
    })
    expect(typeof r.body.now).toBe('number')
    expect(typeof r.body.startedAt).toBe('number')
  })

  it('refuses a caller that is not an admin even when the gate let it through (shadow mode)', async () => {
    const r = await call('GET', '/api/admin/rerank-stats', 'viewer')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
    expect(r.body.calls).toBeUndefined()
  })

  it('only handles GET on its own path', async () => {
    expect((await call('POST', '/api/admin/rerank-stats')).handled).toBe(false)
    expect((await call('GET', '/api/admin/rerank-statss')).handled).toBe(false)
  })

  it('is named in the RBAC table as admin only, on both prefixes', () => {
    for (const p of ['/api/admin/rerank-stats', '/api/v1/admin/rerank-stats']) {
      const hit = ENDPOINT_PERMISSION_TABLE.find((e) => 'pathPattern' in e && e.pathPattern === p && !e.prefix)
      expect(hit, p).toMatchObject({ method: 'GET', permission: 'admin:all' })
    }
  })
})

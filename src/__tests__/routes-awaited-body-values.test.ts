/**
 * The route answers with the RESOLVED rows of an async db function. A dropped `await` in
 * `json(res, await fn())` or `payload.versions = await fn()` serializes a Promise as `{}`; tsc and
 * lint do not see it there (the value is only passed on), so the body is asserted here.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/token-usage.js', () => ({
  collectTokenUsage: vi.fn(),
  getTokenSummary: vi.fn(),
  getTokenTimeline: vi.fn(),
  getTokenDetails: vi.fn(),
  getModelDistribution: vi.fn().mockResolvedValue([{ model: 'm-1', calls: 3 }]),
  getToolStats: vi.fn().mockResolvedValue([{ tool: 't-1', calls: 4 }]),
  correlateWithKanban: vi.fn(),
}))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    getMemoryById: vi.fn().mockResolvedValue({
      id: 7, agent_id: 'agent-a', content: 'c', keywords: 'k', category: 'warm',
      created_at: 1, accessed_at: 1, embedding: null, embedding_blob: null,
    }),
    getMemoryVersions: vi.fn().mockResolvedValue([{ version: 2, content: 'newer' }, { version: 1, content: 'older' }]),
    recordMemoryRead: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { tryHandleTokenUsage } from '../web/routes/token-usage.js'
import { tryHandleMemories } from '../web/routes/memories.js'

function makeCtx(method: string, path: string, params: Record<string, string> = {}): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = { 'accept-encoding': '' }
  setImmediate(() => { req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead: (s: number) => { out.status = s },
    end: (b?: string) => { try { out.body = JSON.parse(b ?? 'null') } catch { out.body = b } },
    setHeader: vi.fn(),
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('routes answer with the resolved db rows, not a serialized Promise', () => {
  it('GET /api/token-usage/model-dist', async () => {
    const { ctx, out } = makeCtx('GET', '/api/token-usage/model-dist')
    expect(await tryHandleTokenUsage(ctx)).toBe(true)
    expect(out.body).toEqual([{ model: 'm-1', calls: 3 }])
  })

  it('GET /api/token-usage/tool-stats', async () => {
    const { ctx, out } = makeCtx('GET', '/api/token-usage/tool-stats')
    expect(await tryHandleTokenUsage(ctx)).toBe(true)
    expect(out.body).toEqual([{ tool: 't-1', calls: 4 }])
  })

  it('GET /api/memories/:id/versions', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories/7/versions')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.body).toEqual([{ version: 2, content: 'newer' }, { version: 1, content: 'older' }])
  })

  it('GET /api/memories/:id?include=versions carries the version rows', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories/7', { include: 'versions' })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.body.id).toBe(7)
    expect(out.body.versions).toEqual([{ version: 2, content: 'newer' }, { version: 1, content: 'older' }])
  })
})

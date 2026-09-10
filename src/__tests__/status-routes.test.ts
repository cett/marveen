import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/http-helpers.js')>()
  return {
    ...actual,
    jsonMaybeGzip: vi.fn().mockImplementation((_req: unknown, res: any, data: unknown) => {
      res.writeHead(200)
      res.end(JSON.stringify(data))
    }),
  }
})

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { tryHandleStatus } from '../web/routes/status.js'

function makeCtx(method: string, path: string): { ctx: RouteContext; status: () => number; body: () => any } {
  const em = new EventEmitter() as any
  em.headers = {}
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

function rssWith(items: string): string {
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`
}

function rssItem(opts: { title?: string; description?: string; pubDate?: string; link?: string } = {}): string {
  const { title = 'Some incident', description = 'We are investigating.', pubDate = 'Mon, 01 Sep 2026 10:00:00 +0000', link = 'https://status.claude.com/incidents/1' } = opts
  return `<item><title>${title}</title><description>${description}</description><pubDate>${pubDate}</pubDate><link>${link}</link></item>`
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetchSequence(rssText: string, componentsResponse: { ok: boolean; body?: unknown }) {
  fetchMock
    .mockResolvedValueOnce({ text: async () => rssText } as any)
    .mockResolvedValueOnce({
      ok: componentsResponse.ok,
      json: async () => componentsResponse.body,
    } as any)
}

describe('status route -- unrelated path', () => {
  it('returns false for a non-matching path', async () => {
    const { ctx } = makeCtx('GET', '/api/not-status')
    expect(await tryHandleStatus(ctx)).toBe(false)
  })
})

describe('GET /api/status', () => {
  it('parses RSS items and reports degraded when an incident is active', async () => {
    mockFetchSequence(
      rssWith(rssItem({ description: 'We are currently investigating this issue.' })),
      { ok: true, body: { components: [{ name: 'API', status: 'operational', group: false }] } },
    )
    const { ctx, status, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(status()).toBe(200)
    const out = body()
    expect(out.overall).toBe('degraded')
    expect(out.incidents).toHaveLength(1)
    expect(out.incidents[0].status).toBe('investigating')
    expect(out.components).toEqual([{ name: 'API', status: 'operational' }])
  })

  it('reports operational when every incident is resolved', async () => {
    mockFetchSequence(
      rssWith(rssItem({ description: 'This incident has been resolved.' })),
      { ok: true, body: { components: [] } },
    )
    const { ctx, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(body().overall).toBe('operational')
    expect(body().incidents[0].status).toBe('resolved')
  })

  it('classifies monitoring and identified statuses', async () => {
    mockFetchSequence(
      rssWith(rssItem({ description: 'A fix has been identified.' }) + rssItem({ title: 'Second', description: 'We are monitoring the fix.' })),
      { ok: true, body: { components: [] } },
    )
    const { ctx, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    const statuses = body().incidents.map((i: any) => i.status)
    expect(statuses).toEqual(['identified', 'monitoring'])
  })

  it('decodes HTML entities and strips real tags from the description', async () => {
    mockFetchSequence(
      rssWith(rssItem({ description: '<p>Status: ok &amp; slow &apos;API&apos;</p>' })),
      { ok: true, body: { components: [] } },
    )
    const { ctx, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(body().incidents[0].description).toBe("Status: ok & slow 'API'")
  })

  it('drops group containers and keeps only leaf components', async () => {
    mockFetchSequence(
      rssWith(''),
      { ok: true, body: { components: [{ name: 'Group', status: 'operational', group: true }, { name: 'Leaf', status: 'operational', group: false }] } },
    )
    const { ctx, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(body().components).toEqual([{ name: 'Leaf', status: 'operational' }])
  })

  it('returns empty components (not a failure) when the components fetch response is not ok', async () => {
    mockFetchSequence(rssWith(''), { ok: false })
    const { ctx, status, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(status()).toBe(200)
    expect(body().components).toEqual([])
  })

  it('returns empty components when the components fetch itself throws', async () => {
    fetchMock
      .mockResolvedValueOnce({ text: async () => rssWith('') } as any)
      .mockRejectedValueOnce(new Error('network down'))
    const { ctx, status, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(status()).toBe(200)
    expect(body().components).toEqual([])
    expect(body().overall).toBe('operational')
  })

  it('falls back to an "unknown" status payload when the RSS fetch itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('DNS failure'))
    const { ctx, status, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ overall: 'unknown', components: [], incidents: [], error: 'internal_error' })
  })

  it('caps incidents to the 15 most recent', async () => {
    const items = Array.from({ length: 20 }, (_, i) => rssItem({ title: `Incident ${i}`, description: 'We are investigating.' })).join('')
    mockFetchSequence(rssWith(items), { ok: true, body: { components: [] } })
    const { ctx, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(body().incidents).toHaveLength(15)
  })
})

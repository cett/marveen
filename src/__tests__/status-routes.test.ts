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

  it('de-duplicates leaf components that share a name across parent groups', async () => {
    mockFetchSequence(
      rssWith(''),
      {
        ok: true,
        body: {
          components: [
            { name: 'API', status: 'operational', group: false },
            { name: 'API', status: 'operational', group: false },
            { name: 'API', status: 'degraded_performance', group: false },
          ],
        },
      },
    )
    const { ctx, body } = makeCtx('GET', '/api/status')
    await tryHandleStatus(ctx)
    expect(body().components).toEqual([{ name: 'API', status: 'operational' }])
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

// The route reads the feed with plain string searches (literalBlocks) and strips tags with
// stripAngleTags; the lazy patterns they replaced were quadratic. These tests go through
// tryHandleStatus, so they protect the WIRING (items, fields, trim, entity decode, tag strip,
// status classification), not just the helpers. The old parser is kept as the oracle.
function oldParseFeed(rssText: string) {
  const items: any[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match
  while ((match = itemRegex.exec(rssText)) !== null) {
    const itemXml = match[1]
    const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || ''
    const description = itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || ''
    const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || ''
    const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || ''
    const cleanDesc = description
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'")
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    let status = 'investigating'
    if (cleanDesc.toLowerCase().includes('resolved')) status = 'resolved'
    else if (cleanDesc.toLowerCase().includes('monitoring')) status = 'monitoring'
    else if (cleanDesc.toLowerCase().includes('identified')) status = 'identified'
    items.push({ title, description: cleanDesc, pubDate, link, status })
  }
  return items.slice(0, 15)
}

async function incidentsFor(rssText: string): Promise<any[]> {
  mockFetchSequence(rssText, { ok: true, body: { components: [] } })
  const { ctx, body } = makeCtx('GET', '/api/status')
  await tryHandleStatus(ctx)
  return body().incidents
}

describe('GET /api/status feed parsing (wiring)', () => {
  const feeds: Record<string, string> = {
    'every field, padded with whitespace': rssWith(
      '<item><title>\n  Padded title \n</title><description> <p>Body &amp; more</p> </description><pubDate> Mon, 01 Sep 2026 </pubDate><link> https://x.test/1 </link></item>',
    ),
    'missing fields': rssWith('<item><title>Only a title</title></item><item></item>'),
    'escaped tags in the description': rssWith(rssItem({ description: '&lt;b&gt;Resolved&lt;/b&gt; the issue' })),
    'a field with no closer': rssWith('<item><title>No closer<description>d</description></item>'),
    'an unclosed item after a closed one': rssWith(rssItem() + '<item><title>Never closed</title>'),
    'a nested opener inside an item': rssWith('<item><item><title>Inner</title></item>'),
    'text outside items': 'junk<item><title>A</title></item>junk<item><title>B</title></item>tail',
    'not a feed': 'plain text, no markup',
    'empty': '',
  }

  for (const [name, feed] of Object.entries(feeds)) {
    it(`gives what the old parser gave: ${name}`, async () => {
      expect(await incidentsFor(feed)).toEqual(oldParseFeed(feed))
    })
  }

  it('reads title, pubDate and link trimmed and the description cleaned, through the route', async () => {
    const [i] = await incidentsFor(feeds['every field, padded with whitespace'])
    expect(i).toMatchObject({
      title: 'Padded title',
      description: 'Body & more',
      pubDate: 'Mon, 01 Sep 2026',
      link: 'https://x.test/1',
      status: 'investigating',
    })
  })

  it('answers a 550 kB feed of openers and no closer in under 300 ms', async () => {
    const shapes = ['<item>'.repeat(91_700), '<item><title>'.repeat(42_300), '<item>' + '<description>'.repeat(42_300) + '</item>', '<a '.repeat(183_400)]
    for (const feed of shapes) {
      mockFetchSequence(feed, { ok: true, body: { components: [] } })
      const { ctx, status } = makeCtx('GET', '/api/status')
      const t = performance.now()
      await tryHandleStatus(ctx)
      expect(performance.now() - t).toBeLessThan(300)
      expect(status()).toBe(200)
    }
  })
})

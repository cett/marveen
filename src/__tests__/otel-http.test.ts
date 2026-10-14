// OTel H6a: the dashboard's HTTP server telemetry (src/otel-http.ts): the route template, the W3C trace id, what
// is recorded (always the histogram, a span only for the slow and the failed), and the real server wiring.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import { initDatabase, getDb, getOtelTrace, upsertOtelSpan, closeOtelSpan } from '../db.js'
import { collectRegistryMetrics, resetMetricValues } from '../otel-metrics.js'
import { spansToOtelJson } from '../otel-exporter.js'
import {
  instrumentHttpRequest, httpRouteTemplate, httpMethod, traceIdFromTraceparent, recordHttpRequest, resetSeenRoutes, MAX_DISTINCT_ROUTES, SLOW_REQUEST_SECONDS,
} from '../otel-http.js'

beforeAll(() => initDatabase(':memory:'))
beforeEach(() => {
  resetMetricValues()
  resetSeenRoutes()
  getDb().exec("DELETE FROM otel_spans WHERE operation = 'http.server'")
})

const metric = () => collectRegistryMetrics().find((m) => m.name === 'http.server.request.duration')
const attrMap = (p: any) => Object.fromEntries(p.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]))
const httpSpans = () => getDb().prepare("SELECT * FROM otel_spans WHERE operation = 'http.server'").all() as any[]

function upsertSessionSpan() {
  getDb().exec("DELETE FROM otel_spans WHERE trace_id = 'session-a'")
  upsertOtelSpan({ trace_id: 'session-a', span_id: 'span-1', parent_span_id: null, agent_id: 'agent-a', operation: 'tool.Bash', start_ms: 1, attributes: null })
  closeOtelSpan('session-a', 'span-1', 2, 'ok')
}

describe('httpRouteTemplate', () => {
  it('keeps the resource and the fixed words and turns ids and names into {id}', () => {
    expect(httpRouteTemplate('/api/kanban')).toBe('/api/kanban')
    expect(httpRouteTemplate('/api/kanban/8f2c1a90')).toBe('/api/kanban/{id}')
    expect(httpRouteTemplate('/api/memories/42/versions')).toBe('/api/memories/{id}/versions')
    expect(httpRouteTemplate('/api/schedules/tick-status')).toBe('/api/schedules/tick-status')
    expect(httpRouteTemplate('/api/schedules/my-secret-nightly-job')).toBe('/api/schedules/{id}')
  })

  it('never lets a name, an id or a search term through', () => {
    for (const secret of ['agent-secret-name', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'hunter2', 'john.doe@example.invalid']) {
      const route = httpRouteTemplate(`/api/skills/${secret}/run`)
      expect(route).not.toContain(secret)
    }
    expect(httpRouteTemplate('/api/not-a-known-resource/x')).toBe('/api/{id}/{id}')
  })

  it('is case-insensitive for the words it keeps and bounded in depth', () => {
    expect(httpRouteTemplate('/api/KANBAN/Search')).toBe('/api/kanban/search')
    expect(httpRouteTemplate('/api/kanban/' + 'a/'.repeat(40))).toBe('/api/kanban/{id}/{id}/{id}/{id}/{id}')
  })

  it('puts everything that is not the API into one bucket', () => {
    expect(httpRouteTemplate('/')).toBe('static')
    expect(httpRouteTemplate('/app.js')).toBe('static')
    expect(httpRouteTemplate('/avatars/some-user.png')).toBe('static')
    expect(httpRouteTemplate('/api')).toBe('static')
  })

  it('stops at a cap of distinct templates and answers /other for new ones, keeping the ones it knows', () => {
    const known = httpRouteTemplate('/api/kanban')
    for (let i = 0; i < MAX_DISTINCT_ROUTES + 50; i++) httpRouteTemplate('/api/' + 'tokens/'.repeat(1) + 'x'.repeat(1) + '/' + 'q'.repeat((i % 5) + 1) + '/' + 'status/'.repeat((i % 3) + 1) + String(i))
    // the generated shapes collapse onto a few templates; force distinct ones through the resource+static grid
    resetSeenRoutes()
    const words = ['agents', 'kanban', 'memories', 'skills', 'tokens', 'users', 'tenants', 'schedules', 'messages', 'workspace']
    const sub = ['status', 'search', 'stats', 'run', 'export', 'import', 'history', 'versions', 'comments', 'sync', 'log', 'login', 'me', 'set']
    let other = 0
    for (const a of words) for (const b of sub) for (const c of sub) for (const d of sub.slice(0, 6)) {
      if (httpRouteTemplate(`/api/${a}/${b}/${c}/${d}`) === '/other') other++
    }
    expect(other).toBeGreaterThan(0)
    expect(httpRouteTemplate('/api/agents/status/search/stats')).toBeDefined()
    expect(known).toBe('/api/kanban')
  })
})

describe('the span export', () => {
  const span = (over: Record<string, unknown>) => ({
    trace_id: 't', span_id: 's', parent_span_id: null, agent_id: 'agent-a', operation: 'x', start_ms: 1, end_ms: 2,
    status: 'ok', attributes: null, tenant_id: 'tenant-a', ...over,
  }) as any
  it('sends a w3c- trace id as it is only for the http.server spans the server wrote itself', () => {
    const tid = '4bf92f3577b34da6a3ce929d0e0e4736'
    const mine = span({ operation: 'http.server', trace_id: `w3c-${tid}`, attributes: JSON.stringify({ http_method: 'GET', http_route: '/api/x', http_status: 500 }) })
    const forged = span({ operation: 'tool.Bash', trace_id: `w3c-${tid}`, attributes: null, span_id: 'forged' })
    const ids = (JSON.parse(JSON.stringify(spansToOtelJson([mine, forged], 'ns', { serviceInstanceId: 'i' }))).resourceSpans as any[])
      .flatMap((r) => r.scopeSpans[0].spans).map((s: any) => s.traceId)
    expect(ids).toContain(tid)
    expect(ids.filter((i: string) => i === tid)).toHaveLength(1) // the forged one is hashed like any id
  })
})

describe('httpMethod', () => {

  it('passes the known methods and turns anything else into _OTHER', () => {
    expect(httpMethod('get')).toBe('GET')
    expect(httpMethod('PATCH')).toBe('PATCH')
    expect(httpMethod('PROPFIND')).toBe('_OTHER')
    expect(httpMethod('')).toBe('_OTHER')
  })
})

describe('traceIdFromTraceparent', () => {
  const tid = '4bf92f3577b34da6a3ce929d0e0e4736'
  it('takes the trace id of a valid header', () => {
    expect(traceIdFromTraceparent(`00-${tid}-00f067aa0ba902b7-01`)).toBe(`w3c-${tid}`)
    expect(traceIdFromTraceparent(`  00-${tid.toUpperCase()}-00F067AA0BA902B7-00 `)).toBe(`w3c-${tid}`)
  })
  it('ignores anything malformed, zero or not a string', () => {
    for (const bad of [undefined, null, 5, '', 'garbage', `01-${tid}-00f067aa0ba902b7-01`, `00-${tid}-00f067aa0ba902b7`,
      `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `00-${tid}-${'0'.repeat(16)}-01`, `00-${tid.slice(1)}-00f067aa0ba902b7-01`,
      `00-${tid}-00f067aa0ba902b7-01-extra`, `00-${tid}x-00f067aa0ba902b7-01`, ['a', 'b']]) {
      expect(traceIdFromTraceparent(bad), String(bad)).toBeNull()
    }
  })
})

describe('recordHttpRequest', () => {
  it('records every request in the histogram with the method, the TEMPLATE and the status, and no span for a fast success', () => {
    recordHttpRequest({ method: 'get', path: '/api/kanban/card-123', status: 200, seconds: 0.03 })
    const p = (metric()!.histogram!.dataPoints as any[])[0]
    expect(attrMap(p)).toEqual({ 'http.request.method': 'GET', 'http.route': '/api/kanban/{id}', 'http.response.status_code': '200' })
    expect(p.count).toBe('1')
    expect(httpSpans()).toHaveLength(0)
  })

  it('uses the conventional bounds in seconds', () => {
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 200, seconds: 0.2 })
    const p = (metric()!.histogram!.dataPoints as any[])[0]
    expect(p.explicitBounds).toEqual([0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10])
    expect(p.bucketCounts[6]).toBe('1') // 0.2 s: the <= 0.25 bucket
  })

  it('writes a span for a server error and for a slow request, none for a client error', () => {
    recordHttpRequest({ method: 'POST', path: '/api/messages', status: 500, seconds: 0.01 })
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 200, seconds: SLOW_REQUEST_SECONDS })
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 404, seconds: 0.01 })
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 200, seconds: SLOW_REQUEST_SECONDS - 0.01 })
    const spans = httpSpans()
    expect(spans.map((s) => s.status).sort()).toEqual(['error', 'ok'])
    expect(spans.every((s) => s.end_ms >= s.start_ms)).toBe(true)
  })

  it('exports the span as a SERVER span named by the template, never by the raw path', () => {
    recordHttpRequest({ method: 'GET', path: '/api/skills/secret-skill-name/run', status: 503, seconds: 0.5 })
    const [row] = httpSpans()
    const json = JSON.stringify(spansToOtelJson([row], 'ns-a', { serviceInstanceId: 'inst-a' }))
    const span = (JSON.parse(json).resourceSpans[0].scopeSpans[0].spans as any[])[0]
    expect(span.kind).toBe(2)
    expect(span.name).toBe('GET /api/skills/{id}/run')
    expect(json).not.toContain('secret-skill-name')
    const attrs = Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]))
    expect(attrs).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/api/skills/{id}/run', 'http.response.status_code': '503' })
    expect(span.status.code).toBe(2)
  })

  it('joins the trace of a valid traceparent and starts its own for a missing or bad one', () => {
    const tid = '4bf92f3577b34da6a3ce929d0e0e4736'
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 500, seconds: 0.1, traceparent: `00-${tid}-00f067aa0ba902b7-01`, authenticated: true })
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 500, seconds: 0.1, traceparent: 'nonsense', authenticated: true })
    const rows = httpSpans()
    expect(rows).toHaveLength(2)
    const exported = JSON.parse(JSON.stringify(spansToOtelJson(rows, 'ns-a', { serviceInstanceId: 'i' }))).resourceSpans
      .flatMap((r: any) => r.scopeSpans[0].spans) as any[]
    const ids = exported.map((s) => s.traceId)
    expect(ids).toContain(tid)
    const other = ids.find((i: string) => i !== tid)!
    expect(other).toMatch(/^[0-9a-f]{32}$/)
    expect(getOtelTrace(`w3c-${tid}`).length).toBe(1)
  })

  it('contract with the hooks: the trace id of a session is sha256(session id)[:32], which is what they send as traceparent', () => {
    // pinned in scripts/__tests__/dashboard-api-traceparent.test.py as FIXED_TRACE
    upsertSessionSpan()
    const [row] = getDb().prepare("SELECT * FROM otel_spans WHERE trace_id = 'session-a'").all() as any[]
    const exported = JSON.parse(JSON.stringify(spansToOtelJson([row], 'ns-a', { serviceInstanceId: 'i' })))
    expect(exported.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe('fa57a52dbf08190218529730a3e99db6')
  })

  it('ignores the traceparent of a caller without credentials: the span gets a trace of its own', () => {
    const tid = '4bf92f3577b34da6a3ce929d0e0e4736'
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 500, seconds: 0.1, traceparent: `00-${tid}-00f067aa0ba902b7-01` })
    recordHttpRequest({ method: 'GET', path: '/api/overview', status: 500, seconds: 0.1, traceparent: `00-${tid}-00f067aa0ba902b7-01`, authenticated: false })
    const ids = httpSpans().map((s) => s.trace_id)
    expect(ids).toHaveLength(2)
    expect(ids.some((i: string) => i.includes(tid))).toBe(false)
  })

  it('names only the resource for an answer that says no, and such answers never grow the set of known templates', () => {
    for (let i = 0; i < MAX_DISTINCT_ROUTES + 100; i++) {
      recordHttpRequest({ method: 'GET', path: `/api/kanban/${'status/'.repeat(i % 3)}x${i}/${i}`, status: i % 2 ? 401 : 404, seconds: 0.001 })
    }
    const routes = new Set(((metric()!.histogram!.dataPoints as any[]).map(attrMap)).map((a) => a['http.route']))
    expect([...routes]).toEqual(['/api/kanban'])
    // the cap is untouched: a real route still gets its full template
    expect(httpRouteTemplate('/api/kanban/card-1/comments')).toBe('/api/kanban/{id}/comments')
  })

  it('leaves the whole cap for real routes however many refused requests came first', () => {
    const resources = ['activity', 'admin', 'agents', 'approvals', 'artifacts', 'audit', 'auth', 'autonomy', 'backups', 'blackboard', 'kanban', 'memories', 'messages', 'skills', 'tokens', 'users']
    for (const r of resources) recordHttpRequest({ method: 'GET', path: `/api/${r}/x/y`, status: 401, seconds: 0.001 })
    const sub = ['status', 'search', 'stats', 'run', 'export', 'import', 'history', 'versions', 'comments', 'sync', 'log', 'login', 'me', 'set']
    const distinct = new Set<string>()
    outer: for (const a of resources) for (const b of sub) for (const c of sub) {
      const t = httpRouteTemplate(`/api/${a}/${b}/${c}`)
      if (t === '/other') break outer
      distinct.add(t)
    }
    expect(distinct.size).toBe(MAX_DISTINCT_ROUTES)
  })

  it('does not report which paths exist: a 404 under a known resource looks like a 401', () => {
    recordHttpRequest({ method: 'GET', path: '/api/kanban/nonexistent/deep/path', status: 404, seconds: 0.001 })
    recordHttpRequest({ method: 'GET', path: '/api/kanban/some-card', status: 401, seconds: 0.001 })
    const routes = (metric()!.histogram!.dataPoints as any[]).map(attrMap).map((a) => a['http.route'])
    expect(new Set(routes)).toEqual(new Set(['/api/kanban']))
  })

  it('counts a status outside 100-599 as 0 and a hostile method as _OTHER, and never throws', () => {
    expect(() => recordHttpRequest({ method: 'PROPFIND', path: '/api/x', status: 9999, seconds: 0.1 })).not.toThrow()
    const p = (metric()!.histogram!.dataPoints as any[])[0]
    expect(attrMap(p)['http.request.method']).toBe('_OTHER')
    expect(attrMap(p)['http.response.status_code']).toBe('0')
    expect(() => recordHttpRequest({ method: 'GET', path: undefined as unknown as string, status: 200, seconds: NaN })).not.toThrow()
  })
})

describe('instrumentHttpRequest on a real HTTP server', () => {
  async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, authenticated = false) {
    const server = http.createServer((req, res) => {
      instrumentHttpRequest(req, res, req.method || 'GET', new URL(req.url || '/', 'http://x').pathname, { authenticated })
      handler(req, res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { server, port: (server.address() as net.AddressInfo).port }
  }
  const points = () => ((metric()?.histogram?.dataPoints ?? []) as any[]).map((p) => ({ a: attrMap(p), count: p.count }))

  it('measures an answered request with the template of the route and the status, never the path or the query', async () => {
    const { server, port } = await serve((_req, res) => { res.writeHead(401); res.end('no') })
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/kanban/some-card-name?q=secret-search-term`)).text()
      await new Promise((r) => setTimeout(r, 30))
      const hit = points().find((p) => p.a['http.route'] === '/api/kanban')
      expect(hit?.a).toEqual({ 'http.request.method': 'GET', 'http.route': '/api/kanban', 'http.response.status_code': '401' })
      expect(JSON.stringify(collectRegistryMetrics())).not.toMatch(/some-card-name|secret-search-term/)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('puts the span of a failed request into the trace of the traceparent it came with', async () => {
    const tid = '4bf92f3577b34da6a3ce929d0e0e4736'
    const { server, port } = await serve((_req, res) => { res.writeHead(500); res.end('boom') }, true)
    const stranger = await serve((_req, res) => { res.writeHead(500); res.end('boom') }, false)
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { traceparent: `00-${tid}-00f067aa0ba902b7-01` } })).text()
      await new Promise((r) => setTimeout(r, 30))
      expect(httpSpans().map((s) => s.trace_id)).toEqual([`w3c-${tid}`])
      getDb().exec("DELETE FROM otel_spans WHERE operation = 'http.server'")
      await (await fetch(`http://127.0.0.1:${stranger.port}/api/overview`, { headers: { traceparent: `00-${tid}-00f067aa0ba902b7-01` } })).text()
      await new Promise((r) => setTimeout(r, 30))
      expect(httpSpans().map((s) => s.trace_id).some((i: string) => i.includes(tid))).toBe(false)
    } finally {
      await new Promise((r) => server.close(r))
      await new Promise((r) => stranger.server.close(r))
    }
  })

  it('does not count an event stream or a request the client abandoned', async () => {
    const { server, port } = await serve((req, res) => {
      if (req.url === '/api/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: 1\n\n'); return }
      // never answered: the client gives up
    })
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/stream`)).text()
      const ctl = new AbortController()
      const pending = fetch(`http://127.0.0.1:${port}/api/overview`, { signal: ctl.signal }).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 30))
      ctl.abort()
      await pending
      await new Promise((r) => setTimeout(r, 50))
      expect(points()).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })

  it('is what the dashboard server calls first in its handler', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')
    const handler = src.slice(src.indexOf('http.createServer(async (req, res) => {'))
    expect(handler.slice(0, 900)).toContain('instrumentHttpRequest(req, res, method, path, httpTrust)')
    // the caller counts as authenticated once resolveAuth found a principal, not before
    expect(src).toMatch(/resolveAuth\(req, url, path, method, DASHBOARD_TOKEN, true\)\n\s+httpTrust\.authenticated = auth\.kind !== 'none'/)
  })
})

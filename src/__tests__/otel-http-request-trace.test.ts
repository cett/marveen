// The request trace (assignRequestTrace): the route's db context and the http.server span share one trace_id/span_id,
// and a stranger's traceparent steers neither. Companion to otel-http.test.ts.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import { initDatabase, getDb } from '../db.js'
import { resetMetricValues } from '../otel-metrics.js'
import { instrumentHttpRequest, assignRequestTrace, recordHttpRequest, resetSeenRoutes, type HttpTrust } from '../otel-http.js'
import { currentTrace } from '../db/context.js'
import { runAsRequest } from '../db/background-jobs.js'

beforeAll(() => initDatabase(':memory:'))
beforeEach(() => {
  resetMetricValues()
  resetSeenRoutes()
  getDb().exec("DELETE FROM otel_spans WHERE operation = 'http.server'")
})

const httpSpans = () => getDb().prepare("SELECT * FROM otel_spans WHERE operation = 'http.server'").all() as any[]
const TID = '4bf92f3577b34da6a3ce929d0e0e4736'
const TRACEPARENT = `00-${TID}-00f067aa0ba902b7-01`

// The same wiring the dashboard handler has: instrument first, the trust set after the auth gate, the trace assigned,
// the route run in the request context carrying it. `seen` is what a writer inside the route would read.
async function serveLikeDashboard(authenticated: boolean, status = 500) {
  const seen: Array<ReturnType<typeof currentTrace>> = []
  const server = http.createServer((req, res) => {
    const trust: HttpTrust = { authenticated: false }
    instrumentHttpRequest(req, res, req.method || 'GET', new URL(req.url || '/', 'http://x').pathname, trust)
    trust.authenticated = authenticated
    const trace = assignRequestTrace(req, trust)
    void runAsRequest({ authenticated, role: 'admin', tenantId: null, trace }, async () => {
      await new Promise((r) => setTimeout(r, 2))
      seen.push(currentTrace())
      res.writeHead(status)
      res.end('x')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, port: (server.address() as net.AddressInfo).port }
}
const stop = (s: http.Server) => new Promise((r) => s.close(r))

describe('the request trace: one trace for the route and the http.server span', () => {
  it('the trace the route runs in is the trace_id and span_id of its http.server span', async () => {
    const { server, seen, port } = await serveLikeDashboard(false)
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/overview`)).text()
      await new Promise((r) => setTimeout(r, 40))
      const spans = httpSpans()
      expect(spans).toHaveLength(1)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({ traceId: spans[0].trace_id, spanId: spans[0].span_id })
      expect(spans[0].trace_id).toMatch(/^[0-9a-f]{32}$/)
      expect(spans[0].span_id).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      await stop(server)
    }
  })

  it('joins the trace of a traceparent that came with credentials, in the route and in the span alike', async () => {
    const { server, seen, port } = await serveLikeDashboard(true)
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { traceparent: TRACEPARENT } })).text()
      await new Promise((r) => setTimeout(r, 40))
      expect(seen[0]?.traceId).toBe(`w3c-${TID}`)
      expect(httpSpans().map((s) => [s.trace_id, s.span_id])).toEqual([[seen[0]!.traceId, seen[0]!.spanId]])
    } finally {
      await stop(server)
    }
  })

  it('ignores the traceparent of a caller without credentials: neither the route nor the span lands in its trace', async () => {
    const { server, seen, port } = await serveLikeDashboard(false)
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { traceparent: TRACEPARENT } })).text()
      await new Promise((r) => setTimeout(r, 40))
      expect(JSON.stringify(seen)).not.toContain(TID)
      expect(JSON.stringify(httpSpans())).not.toContain(TID)
      expect(seen[0]?.traceId).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      await stop(server)
    }
  })

  it('gives every request its own ids, also when no span is written (a fast success)', async () => {
    const { server, seen, port } = await serveLikeDashboard(true, 200)
    try {
      await (await fetch(`http://127.0.0.1:${port}/api/overview`)).text()
      await (await fetch(`http://127.0.0.1:${port}/api/overview`)).text()
      await new Promise((r) => setTimeout(r, 40))
      expect(httpSpans()).toEqual([])
      expect(seen).toHaveLength(2)
      expect(seen[0]!.traceId).not.toBe(seen[1]!.traceId)
      expect(seen[0]!.spanId).not.toBe(seen[1]!.spanId)
    } finally {
      await stop(server)
    }
  })

  it('stores on the trust exactly what it returns, and does not take over an all-zero traceparent', () => {
    const req = { headers: { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` } } as unknown as http.IncomingMessage
    const trust: HttpTrust = { authenticated: true }
    const trace = assignRequestTrace(req, trust)
    expect(trace).toEqual({ traceId: trust.traceId, spanId: trust.spanId })
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('a request that ended before the auth gate (no ids on the trust) still records its span with ids of its own', async () => {
    await recordHttpRequest({ method: 'GET', path: '/api/overview', status: 500, seconds: 0.01, authenticated: false })
    const spans = httpSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].trace_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('uses the given ids only when both are there', async () => {
    await recordHttpRequest({ method: 'GET', path: '/api/overview', status: 500, seconds: 0.01, traceId: 'only-a-trace-id' })
    expect(httpSpans()[0].trace_id).not.toBe('only-a-trace-id')
  })

  it('is wired in the dashboard handler: assigned right after the trust is set, handed to runAsRequest', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/httpTrust\.authenticated = auth\.kind !== 'none'[^\n]*\n\s+const requestTrace = assignRequestTrace\(req, httpTrust\)/)
    expect(src).toMatch(/runAsRequest\(\{[^\n]*trace: requestTrace \}, \(\) => dispatcher\.dispatch\(routeCtx\)\)/)
  })
})

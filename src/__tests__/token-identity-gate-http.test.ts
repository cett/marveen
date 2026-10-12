// The T4-7 enforce gate over a real HTTP connection: the 403 for a body that names another agent, and
// a body over the size cap of the route that follows. The gate runs the same way web.ts runs it (auth,
// counter, answerIdentityRefusal, then the route), minus the rest of the server.
//
// The 413 itself is checked against a stand-in response: readBody destroys the socket of a request over
// its cap (so a real client sees the connection close, for the routes as for the gate), which leaves no
// response to read over HTTP.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { initDatabase, insertApiToken } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { answerIdentityRefusal, observeTokenUsage, resetTokenShadowForTests } from '../web/token-shadow.js'
import { readBody, SCHEDULE_BODY_MAX_BYTES } from '../web/http-helpers.js'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const SHARED = 'the-file-token'

let server: http.Server
let port: number
let reached: Buffer[]

beforeEach(async () => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
  insertApiToken({
    tokenHash: sha('tok-alpha'), name: 'fleet_agent:alpha', role: 'fleet_agent', tenantId: 'default',
    createdAt: Math.floor(Date.now() / 1000) - 10, expiresAt: null, agentId: 'alpha',
  })
  reached = []
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const auth = resolveAuth(req, url, url.pathname, req.method ?? 'GET', SHARED, true)
    observeTokenUsage(req, auth, req.method ?? 'GET', url.pathname, url)
    if (await answerIdentityRefusal(req, res)) return
    // The route behind the gate: it reads the body again, with its own cap.
    try {
      reached.push(await readBody(req, url.pathname === '/api/schedules' ? { maxBytes: SCHEDULE_BODY_MAX_BYTES } : {}))
    } catch {
      return // over the route's own cap: the connection is gone, as in production
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function post(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: 'Bearer tok-alpha', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('the enforce gate over HTTP', () => {
  it('answers 403 to a body that names another agent, and the route is not reached', async () => {
    const res = await post('/api/daily-log', JSON.stringify({ agent_id: 'beta', content: 'x' }))
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden', hint: 'A token may only act as its own agent' })
    expect(reached).toHaveLength(0)
  })

  it('lets a body that names the caller through, and the route reads the same bytes', async () => {
    const payload = JSON.stringify({ agent_id: 'alpha', content: 'x' })
    const res = await post('/api/daily-log', payload)
    expect(res.status).toBe(200)
    expect(reached.map((b) => b.toString())).toEqual([payload])
  })

  it('still reads and refuses a large body on a route with no tighter cap', async () => {
    const res = await post('/api/daily-log', JSON.stringify({ agent_id: 'beta', pad: 'x'.repeat(SCHEDULE_BODY_MAX_BYTES * 2) }))
    expect(res.status).toBe(403)
  })

  it('never lets a schedule body over its cap reach the route', async () => {
    const outcome = await post('/api/schedules', JSON.stringify({ agent: 'alpha', pad: 'x'.repeat(SCHEDULE_BODY_MAX_BYTES + 10) }))
      .then((r) => r.status, () => 'closed')
    expect(outcome).not.toBe(200)
    expect(reached).toHaveLength(0)
  })

  it('does not take a schedule body just under its cap for too large', async () => {
    const res = await post('/api/schedules', JSON.stringify({ agent: 'alpha', pad: 'x'.repeat(SCHEDULE_BODY_MAX_BYTES - 100) }))
    expect(res.status).toBe(200)
  })
})

describe('the enforce gate and a body over the cap of its route', () => {
  /** A request that sends `bytes` of JSON naming the caller, and a response that records the answer. */
  async function overCap(path: string, bytes: number) {
    const req = new EventEmitter() as unknown as http.IncomingMessage
    req.method = 'POST'
    req.headers = { authorization: 'Bearer tok-alpha' }
    ;(req as unknown as { destroy: () => void }).destroy = () => {}
    const body = Buffer.from(JSON.stringify({ agent: 'alpha', pad: 'x'.repeat(bytes) }))
    setImmediate(() => { req.emit('data', body); req.emit('end') })
    const url = new URL(`http://localhost:3420${path}`)
    observeTokenUsage(req, resolveAuth(req, url, url.pathname, 'POST', SHARED, true), 'POST', url.pathname, url)
    const sent: { status?: number; body?: string } = {}
    const res = {
      writeHead: (status: number) => { sent.status = status },
      end: (b: string) => { sent.body = b },
    } as unknown as http.ServerResponse
    const answered = await answerIdentityRefusal(req, res)
    return { answered, sent }
  }

  it('answers the 413 of the route, not a thrown error', async () => {
    const { answered, sent } = await overCap('/api/schedules', SCHEDULE_BODY_MAX_BYTES + 10)
    expect(answered).toBe(true)
    expect(sent.status).toBe(413)
    expect(JSON.parse(sent.body ?? '')).toEqual({ error: 'limit_exceeded', hint: `Request body too large (max ${SCHEDULE_BODY_MAX_BYTES} bytes)` })
  })

  it('lets a body under the cap on to the route', async () => {
    const { answered, sent } = await overCap('/api/schedules', 100)
    expect(answered).toBe(false)
    expect(sent.status).toBeUndefined()
  })
})

// The T4-7 enforce gate over a real HTTP connection: the 403 for a body that names another agent, and
// a body over the size cap of the route that follows. The gate runs the same way web.ts runs it (auth,
// counter, answerIdentityRefusal, then the route), minus the rest of the server.
//
// readBody drains (and drops) the rest of a request over its cap instead of destroying the socket, so
// the route's own 413 -- written in the catch below, exactly as a real route writes it -- reaches a real
// client instead of a bare connection reset.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { initDatabase, insertApiToken } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { answerIdentityRefusal, observeTokenUsage, resetTokenShadowForTests } from '../web/token-shadow.js'
import { readBody, RequestBodyTooLargeError, SCHEDULE_BODY_MAX_BYTES, OVERFLOW_DRAIN_GRACE_MS } from '../web/http-helpers.js'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const SHARED = 'the-file-token'

let server: http.Server
let port: number
let reached: Buffer[]

beforeEach(async () => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
  await insertApiToken({
    tokenHash: sha('tok-alpha'), name: 'fleet_agent:alpha', role: 'fleet_agent', tenantId: 'default',
    createdAt: Math.floor(Date.now() / 1000) - 10, expiresAt: null, agentId: 'alpha',
  })
  reached = []
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const auth = await resolveAuth(req, url, url.pathname, req.method ?? 'GET', SHARED, true)
    observeTokenUsage(req, auth, req.method ?? 'GET', url.pathname, url)
    if (await answerIdentityRefusal(req, res)) return
    // The route behind the gate: it reads the body again, with its own cap, and answers its own
    // 413 on overflow exactly as a real route does (schedules.ts, skills.ts, skill-sync.ts).
    try {
      reached.push(await readBody(req, url.pathname === '/api/schedules' ? { maxBytes: SCHEDULE_BODY_MAX_BYTES } : {}))
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'limit_exceeded', hint: `Request body too large (max ${err.limit} bytes)` }))
      }
      return
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

  it('never lets a schedule body over its cap reach the route, and the real client sees the 413', async () => {
    const res = await post('/api/schedules', JSON.stringify({ agent: 'alpha', pad: 'x'.repeat(SCHEDULE_BODY_MAX_BYTES + 10) }))
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body)).toEqual({ error: 'limit_exceeded', hint: `Request body too large (max ${SCHEDULE_BODY_MAX_BYTES} bytes)` })
    expect(reached).toHaveLength(0)
  })

  it('does not take a schedule body just under its cap for too large', async () => {
    const res = await post('/api/schedules', JSON.stringify({ agent: 'alpha', pad: 'x'.repeat(SCHEDULE_BODY_MAX_BYTES - 100) }))
    expect(res.status).toBe(200)
  })

  it('closes the socket of a client that announces more than it ever sends, well inside the grace window', async () => {
    // A raw socket, not http.request: we need to declare a Content-Length far larger than what we
    // actually write, then go silent -- the shape that used to hold the connection for Node's full
    // default requestTimeout (5 minutes) once readBody stopped destroy()ing it on overflow.
    const overBody = Buffer.from(JSON.stringify({ agent: 'alpha', pad: 'x'.repeat(SCHEDULE_BODY_MAX_BYTES + 100) }))
    const announced = overBody.length * 4
    const head = `POST /api/schedules HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer tok-alpha\r\nContent-Type: application/json\r\nContent-Length: ${announced}\r\n\r\n`

    const socket = net.connect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const started = Date.now()
    socket.write(head)
    socket.write(overBody) // over the route's cap, but still far short of the announced length
    // Deliberately no more writes and no socket.end(): the silent-client scenario.

    const received: Buffer[] = []
    socket.on('data', (c: Buffer) => received.push(c))
    const closedAt = await new Promise<number>((resolve, reject) => {
      socket.once('close', () => resolve(Date.now()))
      setTimeout(() => reject(new Error('socket was not closed within the test window')), OVERFLOW_DRAIN_GRACE_MS + 5_000)
    })

    const response = Buffer.concat(received).toString()
    expect(response).toContain(' 413 ')
    expect(response).toContain('limit_exceeded')
    // The grace window is the bound, not a lower bound we also have to clear: closing sooner (e.g.
    // on the client's own disconnect) is fine too, only taking the full 5 minutes is the bug.
    expect(closedAt - started).toBeLessThan(OVERFLOW_DRAIN_GRACE_MS + 2_000)
  }, OVERFLOW_DRAIN_GRACE_MS + 10_000)
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
    observeTokenUsage(req, await resolveAuth(req, url, url.pathname, 'POST', SHARED, true), 'POST', url.pathname, url)
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

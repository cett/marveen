// A truncated or malformed JSON body is the caller's mistake: the top-level handler answers 400 parse_error
// (isInvalidJsonBodyError) instead of a 500 that would also be recorded as an error span. An unrelated
// SyntaxError must stay a 500.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readBody, json, isInvalidJsonBodyError } from '../web/http-helpers.js'

let server: http.Server
let port: number

// The shape web.ts gives a route: the route throws, the catch classifies.
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? ''
      if (url === '/parses-body') {
        const body = await readBody(req)
        JSON.parse(body.toString())
        json(res, { ok: true })
      } else if (url === '/other-syntax-error') {
        await readBody(req)
        JSON.parse('{ not the body')
        json(res, { ok: true })
      } else if (url === '/regex-syntax-error') {
        await readBody(req)
        new RegExp('(')
        json(res, { ok: true })
      } else if (url === '/never-read-body') {
        JSON.parse('{ not the body')
      } else {
        throw new Error('boom')
      }
    } catch (err) {
      if (isInvalidJsonBodyError(err, req)) {
        json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
        return
      }
      json(res, { error: 'internal_error', hint: 'Szerver hiba' }, 500)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

async function post(path: string, body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

describe('invalid JSON request body', () => {
  it('a truncated body answers 400 parse_error', async () => {
    const r = await post('/parses-body', '{"from":"a","to":"b","content":"cut off')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('parse_error')
  })

  it('an empty body answers 400 parse_error', async () => {
    const r = await post('/parses-body', '')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('parse_error')
  })

  it('a valid body is untouched', async () => {
    const r = await post('/parses-body', '{"a":1}')
    expect(r.status).toBe(200)
  })

  it('a SyntaxError from a JSON.parse that is not the body stays a 500 when the body is valid', async () => {
    const r = await post('/other-syntax-error', '{"a":1}')
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('internal_error')
  })

  it('a SyntaxError that is not from JSON.parse stays a 500 even with a broken body', async () => {
    const r = await post('/regex-syntax-error', '{ broken')
    expect(r.status).toBe(500)
  })

  it('a handler that never read the body stays a 500', async () => {
    const r = await post('/never-read-body', '{ broken')
    expect(r.status).toBe(500)
  })

  it('a plain Error stays a 500', async () => {
    const r = await post('/boom', '{ broken')
    expect(r.status).toBe(500)
  })
})

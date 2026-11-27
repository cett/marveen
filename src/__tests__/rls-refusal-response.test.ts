import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A database refusal (SQLSTATE 42501: a row-level policy WITH CHECK or a missing grant) that no route handled used to
// answer 500 internal_error. It is now 403 forbidden with a FIXED hint, logged at warn with the route and the SQLSTATE, and
// counted per route (db-context stats `rlsRefusals`). The cells drive a real HTTP socket with a handler that throws the
// error the pg driver throws, shaped like the catch in web.ts, and pin that wiring against web.ts itself (a source cell, since
// the catch is not callable on its own).

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))

import { answerRlsRefusal, refusalRouteKey, RLS_REFUSAL_HINT } from '../web/rls-refusal-response.js'
import { json } from '../web/http-helpers.js'
import { getDbContextStats, resetDbContextStats } from '../db/context.js'

/** The error node-postgres throws for a policy violation: SQLSTATE in `code`, the table in `table`, the policy text in `message`. */
function pgRefusal(table = 'skill_revisions'): Error & { code: string; table: string } {
  return Object.assign(new Error(`new row violates row-level security policy for table "${table}"`), { code: '42501', table })
}

let server: http.Server | null = null
async function serve(op: () => unknown, method = 'DELETE', reqPath = '/api/skills/sql/global%2Fsome-skill'): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  // The same shape as the catch in web.ts: the vault answer is not under test here, the 42501 answer first, then the generic 500.
  server = http.createServer((_req, res) => {
    void (async () => {
      try {
        await op()
        json(res, { ok: true })
      } catch (err) {
        if (answerRlsRefusal(err, res, method, reqPath)) return
        json(res, { error: 'internal_error', hint: 'Szerver hiba' }, 500)
      }
    })()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const r = await fetch(`http://127.0.0.1:${port}/`)
  const text = await r.text()
  return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> }
}

beforeEach(() => { resetDbContextStats(); loggerMock.warn.mockClear(); loggerMock.error.mockClear() })
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

describe('42501 -> 403 forbidden', () => {
  it('a handler that throws the pg policy refusal is answered 403 forbidden with the fixed hint and nothing else', async () => {
    const r = await serve(() => { throw pgRefusal() })
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'forbidden', hint: RLS_REFUSAL_HINT })
    expect(Object.keys(r.body).sort()).toEqual(['error', 'hint'])
  })

  it('no SQL text, table, column or policy name, and no id of the path, reaches the response', async () => {
    const r = await serve(() => { throw pgRefusal('skill_revisions') })
    for (const needle of ['skill_revisions', 'row-level', 'policy', 'violates', 'INSERT', 'SELECT', '42501', 'global', 'some-skill']) {
      expect(r.text, `response leaks "${needle}"`).not.toContain(needle)
    }
  })

  it('the refusal is logged at warn with the route and the SQLSTATE (the detail stays in the log), and it is not logged as an error', async () => {
    await serve(() => { throw pgRefusal('skill_revisions') })
    expect(loggerMock.warn).toHaveBeenCalledTimes(1)
    const [fields] = loggerMock.warn.mock.calls[0] as [Record<string, unknown>]
    expect(fields).toMatchObject({ event: 'rls-refusal', route: 'DELETE /api/skills/sql', sqlstate: '42501', table: 'skill_revisions' })
    expect(loggerMock.error).not.toHaveBeenCalled()
  })

  it('it is counted per route, so the answer does not hide the defect; the path id never becomes a key', async () => {
    await serve(() => { throw pgRefusal() })
    await serve(() => { throw pgRefusal() }, 'DELETE', '/api/skills/sql/agent%2Fagent-a%2Fother')
    await serve(() => { throw pgRefusal() }, 'PUT', '/api/skills/sql/global%2Fx/files/a.md')
    expect(getDbContextStats().rlsRefusals).toEqual({ 'DELETE /api/skills/sql': 2, 'PUT /api/skills/sql': 1 })
  })

  it('a 42501 inside a cause chain (a wrapper around the driver error) is still a refusal', async () => {
    const wrapped = Object.assign(new Error('write failed'), { cause: Object.assign(new Error('wrapper'), { cause: pgRefusal() }) })
    const r = await serve(() => { throw wrapped })
    expect(r.status).toBe(403)
  })

  it('every other error stays the generic 500, and is neither counted nor logged by this helper', async () => {
    for (const err of [new Error('boom'), Object.assign(new Error('unique'), { code: '23505' }), Object.assign(new Error('rls-ish text'), { code: 'XX000', message: 'new row violates row-level security policy' }), 'a string', null]) {
      const r = await serve(() => { throw err })
      expect(r.status).toBe(500)
      expect(r.body.error).toBe('internal_error')
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    expect(getDbContextStats().rlsRefusals).toEqual({})
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  it('a cause chain that loops back on itself ends (bounded depth), as a 500', async () => {
    const a: { code?: string; cause?: unknown } = new Error('loop') as never
    a.cause = a
    const r = await serve(() => { throw a })
    expect(r.status).toBe(500)
  })

  it('the route key keeps the method and at most three segments, query dropped', () => {
    expect(refusalRouteKey('POST', '/api/skills/sql/global%2Fx/revoke')).toBe('POST /api/skills/sql')
    expect(refusalRouteKey('GET', '/api/v1/skills/sql/q?x=1')).toBe('GET /api/v1/skills')
    expect(refusalRouteKey('GET', '/api')).toBe('GET /api')
    expect(refusalRouteKey('GET', '/')).toBe('GET /')
  })
})

describe('web.ts wiring', () => {
  it('the catch of the request handler answers a 42501 after the vault answer and before the generic 500', () => {
    const src = readFileSync(fileURLToPath(new URL('../web.ts', import.meta.url)), 'utf8')
    const m = /if \(answerVaultKeyError\(err, res\)\) return\n[\s\S]{0,300}if \(answerRlsRefusal\(err, res, method, path\)\) return\n\s*logger\.error\(\{ err \}, 'Web szerver hiba'\)\n\s*json\(res, \{ error: 'internal_error'/.exec(src)
    expect(m, 'the catch of handleRequest must call answerRlsRefusal between the vault answer and the 500').not.toBeNull()
  })
})

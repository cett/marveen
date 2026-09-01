import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { initDatabase, createDashboardUser } from '../db.js'
import { resolveAuth, requiresAuth, parseCookies, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'

// CRITICAL FLEET-REGRESSION SUITE.
//
// The whole fleet's curl calls depend on the bearer lane staying byte-identical
// after the inline web.ts gate was extracted into resolveAuth. These tests lock
// that contract: bearer accepted with users present AND absent, the SSE ?token=
// path, federation endpoint-scoping, and the /api/auth/status shape.

const TOKEN = 'a'.repeat(64)

// Minimal IncomingMessage stand-in: the gate only reads .headers.
function mkReq(headers: Record<string, string | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

function mkUrl(path: string, query = ''): URL {
  return new URL(`http://127.0.0.1:3420${path}${query}`)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearSessionCacheForTest()
})

describe('requiresAuth (gated-path predicate)', () => {
  it('leaves the public probes ungated', () => {
    expect(requiresAuth('/api/auth/status', 'GET')).toBe(false)
    expect(requiresAuth('/api/auth/login', 'POST')).toBe(false)
    expect(requiresAuth('/api/marveen/avatar', 'GET')).toBe(false)
    expect(requiresAuth('/api/agents/zara/avatar', 'GET')).toBe(false)
  })
  it('gates every other /api/* path and the fleet manifest', () => {
    expect(requiresAuth('/api/memories', 'GET')).toBe(true)
    expect(requiresAuth('/api/memories', 'POST')).toBe(true)
    expect(requiresAuth('/api/auth/users', 'POST')).toBe(true)
    expect(requiresAuth('/.well-known/fleetq', 'GET')).toBe(true)
  })
  it('does not gate non-api static paths', () => {
    expect(requiresAuth('/', 'GET')).toBe(false)
    expect(requiresAuth('/app.js', 'GET')).toBe(false)
  })
})

describe('bearer lane (byte-identical, users absent AND present)', () => {
  it('accepts a valid bearer with ZERO users configured', () => {
    // fresh in-memory DB: no dashboard_users rows
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })

  it('accepts the SAME valid bearer once a user EXISTS (no behavior drift)', () => {
    createDashboardUser('operator', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })

  it('rejects a wrong bearer with no cookie -> none (401 upstream)', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer wrong' }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })

  it('rejects a missing Authorization header -> none', () => {
    const r = resolveAuth(mkReq(), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('SSE pane-stream ?token= lane', () => {
  const path = '/api/agents/zara/pane/stream'
  it('accepts the token via query on the SSE path', () => {
    const r = resolveAuth(mkReq(), mkUrl(path, `?token=${TOKEN}`), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
  it('rejects a wrong token via query', () => {
    const r = resolveAuth(mkReq(), mkUrl(path, '?token=nope'), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('does NOT honor ?token= on a non-SSE path', () => {
    const r = resolveAuth(mkReq(), mkUrl('/api/memories', `?token=${TOKEN}`), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('accepts a session cookie on the SSE path (cookie-only EventSource)', () => {
    const u = createDashboardUser('sse-user', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(mkReq({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` }), mkUrl(path), path, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'session', user: 'sse-user' })
  })
})

describe('session cookie lane', () => {
  it('resolves a valid session cookie to its user', () => {
    const u = createDashboardUser('alice', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(mkReq({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'session', user: 'alice' })
  })

  // Session cookie now takes precedence over the legacy file-token when both are
  // present (e.g., browser with localStorage token + active session login).
  // Fleet API callers (curl, notify.sh, channels probe) never carry a session
  // cookie so their bearer-only flows are unaffected -- see regression tests below.
  it('session cookie wins over legacy file-token when both are present', () => {
    const u = createDashboardUser('bob', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${TOKEN}`, cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      mkUrl('/api/memories'),
      '/api/memories',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'session', user: 'bob' })
  })

  it('rejects an unknown/garbage cookie value -> none', () => {
    const r = resolveAuth(mkReq({ cookie: `${SESSION_COOKIE_NAME}=deadbeef` }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('session-priority regression: bearer-only fleet calls unchanged', () => {
  // Fleet agents (curl, notify.sh, channels probe) use Bearer only -- no cookie.
  // The session-priority reorder must not affect them.
  it('bearer alone (no cookie) still resolves to token', () => {
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${TOKEN}` }),
      mkUrl('/api/memories'),
      '/api/memories',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'token' })
  })

  it('bearer alone, no session, no db -- token unchanged (zero-user install)', () => {
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${TOKEN}` }),
      mkUrl('/api/kanban'),
      '/api/kanban',
      'GET',
      TOKEN,
      undefined, // no DB
    )
    expect(r).toEqual({ kind: 'token' })
  })

  it('invalid session cookie + valid bearer -> falls through to token (stale cookie ignored)', () => {
    const r = resolveAuth(
      mkReq({ authorization: `Bearer ${TOKEN}`, cookie: `${SESSION_COOKIE_NAME}=stale-garbage` }),
      mkUrl('/api/memories'),
      '/api/memories',
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'token' })
  })
})

describe('SSE pane-stream ?token= and device-key unaffected by session-priority', () => {
  const ssePath = '/api/agents/zara/pane/stream'

  it('SSE ?token= without session cookie still resolves to token', () => {
    const r = resolveAuth(mkReq(), mkUrl(ssePath, `?token=${TOKEN}`), ssePath, 'GET', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })

  it('SSE path: valid session cookie wins over ?token= (browser EventSource with session)', () => {
    const u = createDashboardUser('sse-session-user', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
    const cookie = createSession({ userId: u.id, username: u.username })
    const r = resolveAuth(
      mkReq({ cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      mkUrl(ssePath, `?token=${TOKEN}`),
      ssePath,
      'GET',
      TOKEN,
    )
    expect(r).toEqual({ kind: 'session', user: 'sse-session-user' })
  })
})

describe('federation endpoint scoping is preserved', () => {
  // Federation is disabled by default (no store/federation.json), so
  // identifyFederationCaller returns null: a fed token can never authenticate.
  it('does not authenticate an arbitrary token on the manifest endpoint', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer some-peer-token' }), mkUrl('/api/federation/manifest'), '/api/federation/manifest', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
  it('still accepts the dashboard bearer on a federation endpoint', () => {
    const r = resolveAuth(mkReq({ authorization: `Bearer ${TOKEN}` }), mkUrl('/api/federation/inbox'), '/api/federation/inbox', 'POST', TOKEN)
    expect(r).toEqual({ kind: 'token' })
  })
  it('federation scoping does not leak onto a non-federation path', () => {
    const r = resolveAuth(mkReq({ authorization: 'Bearer some-peer-token' }), mkUrl('/api/memories'), '/api/memories', 'GET', TOKEN)
    expect(r).toEqual({ kind: 'none' })
  })
})

describe('parseCookies', () => {
  it('parses multiple pairs and trims whitespace', () => {
    expect(parseCookies('a=1; b=2;  c=3')).toEqual({ a: '1', b: '2', c: '3' })
  })
  it('returns empty for no header', () => {
    expect(parseCookies(undefined)).toEqual({})
  })
  it('keeps the first occurrence of a duplicated name', () => {
    expect(parseCookies('mv_session=first; mv_session=second')).toEqual({ mv_session: 'first' })
  })
})

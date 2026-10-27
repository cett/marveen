// The browser-session lane of the auth gate on the async facade, pinned so that each named wrong change fails
// here and not only in tsc or the linter: an `await` dropped in front of the session lookup (every cookie would
// count as a session), a swallowed table error, a revoke that lets a concurrent lookup put the session back,
// and the human-session checks that sit behind the same lookup.
//
// The HTTP tests run the gate the way web.ts runs it (resolveAuth with the database lookups on, then the 401 for
// a gated path without a principal), minus the rest of the server; the other tests call the modules directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDashboardUser, createTenant, dbx, getDashboardUserAuthRow } from '../db.js'
import { resolveAuth, requiresAuth, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { humanSessionOf } from '../web/approval-human-only.js'
import {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllForUser,
  revokeAllSessions,
  _clearSessionCacheForTest,
  _cacheForTest,
} from '../web/auth-sessions.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const FILE_TOKEN = 'f'.repeat(64)
const HASH = '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5'
const SSE_PATH = '/api/agents/agent-a/pane/stream'

beforeEach(() => {
  _clearSessionCacheForTest()
  createTenant('tenant-b', 'Tenant B')
})
afterEach(() => { vi.restoreAllMocks() })

async function makeUser(name: string, role: string, tenant: string | null = null) {
  const u = await createDashboardUser(name, HASH)
  await dbx.run('UPDATE dashboard_users SET role = ?, tenant_id = ? WHERE id = ?', role, tenant, u.id)
  return u
}

const mkReq = (headers: Record<string, string>): http.IncomingMessage => ({ headers }) as unknown as http.IncomingMessage
const cookieOf = (token: string) => `${SESSION_COOKIE_NAME}=${token}`
const askGate = (headers: Record<string, string>, path = '/api/memories', query = '') =>
  resolveAuth(mkReq(headers), new URL(`http://127.0.0.1:3420${path}${query}`), path, 'GET', FILE_TOKEN, true)

// Fail one statement (matched by its SQL text) and record every statement seen, in order. The failing one must
// be the LAST one seen: that proves the request reached the query under test, instead of failing earlier.
function failStatement(method: 'get' | 'run', match: RegExp): string[] {
  const original = dbx[method].bind(dbx)
  const seen: string[] = []
  vi.spyOn(dbx, method).mockImplementation(async (sql: string, ...params: unknown[]) => {
    seen.push(sql)
    if (match.test(sql)) throw new Error('database unavailable')
    return original(sql, ...params)
  })
  return seen
}

describe('the session lane over HTTP', () => {
  let server: http.Server
  let port: number

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const method = req.method ?? 'GET'
        try {
          const auth = await resolveAuth(req, url, url.pathname, method, FILE_TOKEN, true)
          if (requiresAuth(url.pathname, method) && auth.kind === 'none') {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end('{"error":"unauthorized"}')
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(auth))
        } catch {
          res.writeHead(500)
          res.end()
        }
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end()
    })

  // Without the `await` in front of resolveSession the gate holds a Promise: truthy, so every cookie value, a
  // forged one included, would be taken for a session.
  it('a cookie that is not a session gets 401', async () => {
    await makeUser('alice', 'viewer', 'tenant-b')
    expect((await get('/api/memories', { cookie: cookieOf('garbage') })).status).toBe(401)
    expect((await get('/api/memories', { cookie: cookieOf('x'.repeat(43)) })).status).toBe(401)
    expect((await get('/api/memories')).status).toBe(401)
  })

  // The positive case, with the role and tenant scope of the user row: a dropped `await` in front of the user
  // lookup would hand over a session with neither.
  it('a live session gets in, carrying the role and the tenant of its user', async () => {
    const u = await makeUser('alice', 'viewer', 'tenant-b')
    const token = await createSession({ userId: u.id, username: u.username })
    const res = await get('/api/memories', { cookie: cookieOf(token) })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ kind: 'session', user: 'alice', role: 'viewer', tenantId: 'tenant-b' })
  })

  it('the same session over a cold cache (a restart) still gets in', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    expect((await get('/api/memories', { cookie: cookieOf(token) })).status).toBe(200)
  })

  it.each([
    ['revokeSession', async (token: string) => revokeSession(token)],
    ['revokeAllForUser', async (_token: string, userId: number) => revokeAllForUser(userId)],
    ['revokeAllSessions', async () => { await revokeAllSessions() }],
  ])('the request after %s is refused at once', async (_name, revoke) => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    expect((await get('/api/memories', { cookie: cookieOf(token) })).status).toBe(200)
    await revoke(token, u.id)
    expect((await get('/api/memories', { cookie: cookieOf(token) })).status).toBe(401)
  })

  it('a session idle past 7 days gets 401 and its row is removed', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    await dbx.run('UPDATE auth_sessions SET last_seen_at = ?', Math.floor(Date.now() / 1000) - 8 * 24 * 3600)
    expect((await get('/api/memories', { cookie: cookieOf(token) })).status).toBe(401)
    expect(await dbx.get('SELECT 1 AS one FROM auth_sessions')).toBeUndefined()
  })

  it('a session older than 30 days gets 401 even when it was used a second ago', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    await dbx.run('UPDATE auth_sessions SET created_at = ?', Math.floor(Date.now() / 1000) - 31 * 24 * 3600)
    expect((await get('/api/memories', { cookie: cookieOf(token) })).status).toBe(401)
    expect(await dbx.get('SELECT 1 AS one FROM auth_sessions')).toBeUndefined()
  })
})

// A table error in the session lookup is a refusal. Each test sends the file token along as well: a swallowed
// error would fall through to that lane and let the request in, which a rejection cannot.
describe('the session lane fails closed, one test per statement', () => {
  it('cookie lane: the session row lookup fails', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    const seen = failStatement('get', /FROM auth_sessions WHERE id_hash/)
    await expect(askGate({ cookie: cookieOf(token), authorization: `Bearer ${FILE_TOKEN}` })).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/FROM auth_sessions WHERE id_hash/)
  })

  it('cookie lane: the user lookup behind a live session fails', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    const seen = failStatement('get', /FROM dashboard_users WHERE username/)
    await expect(askGate({ cookie: cookieOf(token), authorization: `Bearer ${FILE_TOKEN}` })).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/FROM dashboard_users WHERE username/)
  })

  it('cookie lane: the last_seen write fails', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    for (const entry of _cacheForTest.values()) entry.lastSeenAt -= 120
    const seen = failStatement('run', /UPDATE auth_sessions SET last_seen_at/)
    await expect(askGate({ cookie: cookieOf(token), authorization: `Bearer ${FILE_TOKEN}` })).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/UPDATE auth_sessions SET last_seen_at/)
  })

  it('SSE lane: a browser session on the pane stream with the file token in the query rejects too', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    const seen = failStatement('get', /FROM auth_sessions WHERE id_hash/)
    await expect(askGate({ cookie: cookieOf(token) }, SSE_PATH, `?token=${FILE_TOKEN}`)).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/FROM auth_sessions WHERE id_hash/)
  })

  it('a failed session insert leaves no cache entry and no row', async () => {
    const u = await makeUser('alice', 'admin')
    const seen = failStatement('run', /INSERT INTO auth_sessions/)
    await expect(createSession({ userId: u.id, username: u.username })).rejects.toThrow('database unavailable')
    expect(seen.at(-1)).toMatch(/INSERT INTO auth_sessions/)
    expect(_cacheForTest.size).toBe(0)
    vi.restoreAllMocks()
    expect(await dbx.get('SELECT 1 AS one FROM auth_sessions')).toBeUndefined()
  })
})

// A revoke finishing while a lookup is reading the same row must not leave the session in the cache. The lookup
// is held right after its table read; the revoke is held right after its table delete in the second case.
describe('a revoke and a concurrent lookup of the same session', () => {
  const revokers: Array<[string, (token: string, userId: number) => Promise<unknown>]> = [
    ['revokeSession', (token) => revokeSession(token)],
    ['revokeAllForUser', (_token, userId) => revokeAllForUser(userId)],
    ['revokeAllSessions', () => revokeAllSessions()],
  ]

  function holdAfter(method: 'get' | 'run', match: RegExp) {
    const original = dbx[method].bind(dbx)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    let held = false
    vi.spyOn(dbx, method).mockImplementation(async (sql: string, ...params: unknown[]) => {
      const result = await original(sql, ...params)
      if (!held && match.test(sql)) { held = true; reached(); await gate }
      return result
    })
    return { release, reached: reachedPromise }
  }

  it.each(revokers)('%s that finishes between the read and the cache write: the lookup answers null and caches nothing', async (_name, revoke) => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    const read = holdAfter('get', /FROM auth_sessions WHERE id_hash/)
    const pending = resolveSession(token)
    await read.reached
    await revoke(token, u.id)
    read.release()
    expect(await pending).toBeNull()
    expect(_cacheForTest.size).toBe(0)
    expect(await resolveSession(token)).toBeNull()
  })

  it.each(revokers)('%s still deleting the row while the lookup puts the entry in: the entry is gone when the revoke ends', async (_name, revoke) => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    _clearSessionCacheForTest()
    const read = holdAfter('get', /FROM auth_sessions WHERE id_hash/)
    const del = holdAfter('run', /^DELETE FROM auth_sessions/)
    const pendingLookup = resolveSession(token)
    await read.reached
    const pendingRevoke = revoke(token, u.id)
    await del.reached // the row is deleted, the revoke has not touched the cache yet
    read.release()
    await pendingLookup // the lookup ran alongside the revoke: either answer is fine, the cache is what counts
    del.release()
    await pendingRevoke
    expect(_cacheForTest.size).toBe(0)
    expect(await resolveSession(token)).toBeNull()
  })
})

describe('a session row deleted outside this process', () => {
  // dashboard-user sessions:clear and security:reset run in their own process and cannot reach this cache. The
  // revocation shows within the 60 s debounce window of the touch: the changed-row count of that write is what
  // notices it, so it must be awaited (a Promise is never `=== 0`).
  it('is refused once the next last_seen write finds no row', async () => {
    const u = await makeUser('alice', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    await dbx.run('DELETE FROM auth_sessions')
    expect(await resolveSession(token)).not.toBeNull() // inside the debounce window the cache still answers
    for (const entry of _cacheForTest.values()) entry.lastSeenAt -= 120
    expect(await resolveSession(token)).toBeNull()
    expect(_cacheForTest.size).toBe(0)
  })
})

describe('getDashboardUserAuthRow', () => {
  it('returns role and tenant of an enabled user, whatever the case of the name', async () => {
    await makeUser('Alice', 'viewer', 'tenant-b')
    expect(await getDashboardUserAuthRow('alice')).toEqual({ role: 'viewer', tenant_id: 'tenant-b' })
    expect(await getDashboardUserAuthRow('ALICE')).toEqual({ role: 'viewer', tenant_id: 'tenant-b' })
  })

  it('returns nothing for a disabled user and for an unknown name', async () => {
    await makeUser('alice', 'admin')
    await dbx.run("UPDATE dashboard_users SET disabled = 1 WHERE username = 'alice'")
    expect(await getDashboardUserAuthRow('alice')).toBeUndefined()
    expect(await getDashboardUserAuthRow('nobody')).toBeUndefined()
  })
})

describe('humanSessionOf', () => {
  it('is the global admin with a live session cookie', async () => {
    const u = await makeUser('owner', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    expect(await humanSessionOf(mkReq({ cookie: cookieOf(token) }))).toEqual({ user: 'owner' })
  })

  it('is nobody on a lookup error: a failing session lookup and a failing user lookup both answer null', async () => {
    const u = await makeUser('owner', 'admin')
    const token = await createSession({ userId: u.id, username: u.username })
    const request = mkReq({ cookie: cookieOf(token) })

    _clearSessionCacheForTest()
    const first = failStatement('get', /FROM auth_sessions WHERE id_hash/)
    expect(await humanSessionOf(request)).toBeNull()
    expect(first.at(-1)).toMatch(/FROM auth_sessions WHERE id_hash/)
    vi.restoreAllMocks()

    const second = failStatement('get', /FROM dashboard_users WHERE username/)
    expect(await humanSessionOf(request)).toBeNull()
    expect(second.at(-1)).toMatch(/FROM dashboard_users WHERE username/)
  })
})

// The call sites that act on a Promise as if it were the answer. A Promise is truthy: a missing `await` makes
// every request a session, every caller a person, every revoke "done". tsc and the linter catch it; this keeps a
// build that skips them from being the only guard. Line based: a block-comment regex would swallow path globs.
describe('the call sites await', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').split('\n')
  const callLines = (rel: string, fn: string) =>
    read(rel).filter((l) => l.includes(`${fn}(`) && !/^\s*(\/\/|\*|import)/.test(l) && !/\bfunction\s/.test(l))

  const sites: Array<[string, string[]]> = [
    ['../web/auth-gate.ts', ['resolveSession', 'getDashboardUserAuthRow']],
    ['../web/approval-human-only.ts', ['resolveSession', 'getDashboardUserAuthRow']],
    ['../web/auth-sessions.ts', ['insertAuthSession', 'deleteAuthSessionByHash', 'getAuthSessionByHash', 'touchAuthSessionLastSeen', 'deleteAuthSessionsForUser', 'deleteAllAuthSessions', 'listAuthSessionRowsForUser', 'deleteExpiredAuthSessions', 'removeByHash', 'rehydrate']],
    ['../web/routes/approvals.ts', ['humanSessionOf']],
    ['../web/routes/autonomy.ts', ['humanSessionOf']],
    ['../web/session-only-guard.ts', ['humanSessionOf']],
    ['../web/routes/auth.ts', ['createSession', 'revokeSession', 'revokeAllForUser', 'listUserSessions', 'denyAgentCredentialIssue']],
    ['../web/routes/browser-enroll.ts', ['denyAgentCredentialIssue']],
    ['../web/routes/security.ts', ['denyAgentCredentialIssue']],
    ['../web/routes/tokens.ts', ['denyAgentCredentialIssue']],
    ['../web/routes/me.ts', ['listUserSessions']],
    ['../web/security-reset.ts', ['revokeAllSessions']],
    ['../web.ts', ['sweepExpiredSessions']],
    ['../../scripts/dashboard-user.ts', ['revokeAllForUser']],
  ]

  it.each(sites.flatMap(([file, fns]) => fns.map((fn) => [file, fn] as const)))('%s: every call of %s is awaited', (file, fn) => {
    const lines = callLines(file, fn)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(new RegExp(`await\\s+${fn}\\(`))
  })
})

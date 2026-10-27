// The routes that would let an agent obtain a person's session or a credential of its own, against a real
// in-memory database and real dashboard sessions. With the enforce switch on and a dashboard user present,
// user management and the bearer password reset take a human session only; the credential-issuing routes
// refuse an agent's token. With no user (first run) the bearer still creates the first one, and with the
// switch off nothing is refused. The switch is flipped per test through a live getter on the config mock.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
}))

// Pairing a Bridge writes SSH access lines and sends a notification: stub both, the guard in front of
// them is what these tests are about.
vi.mock('../web/bridge-enroll.js', () => ({
  bridgeEnroll: async () => ({
    bundle: 'bundle', action: 'added', deviceKeyId: 1, replacedDeviceKey: null, installId: 'install-1',
    host: '127.0.0.1', hostKeySource: 'none', warnings: [],
  }),
  sshDirOverride: () => null,
  RemoteEnrollError: class RemoteEnrollError extends Error {},
}))
vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  notifySecurityEvent: async () => undefined,
}))

import { initDatabase, createDashboardUser, createTenant, insertApiToken } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { hashPassword } from '../web/password-hash.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleAdminB2b } from '../web/routes/admin-b2b.js'
import { tryHandleAdminTokens } from '../web/routes/tokens.js'
import { tryHandleBrowserEnroll } from '../web/routes/browser-enroll.js'
import { tryHandleSecurity } from '../web/routes/security.js'
import { _resetEnrollCodesForTest } from '../web/browser-enroll-codes.js'

const PASSWORD = 'correct-horse-battery-1'
const NEW_PASSWORD = 'another-long-password-2'
const HANDLERS = [tryHandleAuth, tryHandleAdminB2b, tryHandleAdminTokens, tryHandleBrowserEnroll, tryHandleSecurity]

let realHash: string
let cookies: Record<string, string>
let ids: Record<string, number>
let seededTokenId: number

beforeAll(async () => { realHash = await hashPassword(PASSWORD) })

async function makeUser(name: string, role: string, tenant: string | null): Promise<void> {
  const u = await createDashboardUser(name, realHash)
  db.prepare('UPDATE dashboard_users SET role = ?, tenant_id = ? WHERE id = ?').run(role, tenant, u.id)
  cookies[name] = await createSession({ userId: u.id, username: u.username })
  ids[name] = u.id
}

beforeEach(async () => {
  flags.enforce = true
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  _resetEnrollCodesForTest()
  createTenant('tenant-b', 'Tenant B')
  cookies = {}
  ids = {}
  await makeUser('owner', 'admin', null) // the first user: global admin
  await makeUser('tadmin', 'admin', 'tenant-b') // an admin, but of one tenant
  await makeUser('tagent', 'agent', 'tenant-b') // the target of the user-management calls
  seededTokenId = (await insertApiToken({ tokenHash: 'a'.repeat(64), name: 'seeded', role: 'viewer', tenantId: 'default', createdAt: 1, expiresAt: null })).id
})

interface Caller {
  auth?: RouteContext['auth']
  role?: RouteContext['role']
  tokenAgentId?: string
  tenantId?: string | null
  cookie?: string
}
const MAIN: Caller = { auth: { kind: 'token', tokenName: 'main-token' }, role: 'admin', tokenAgentId: 'main-agent', tenantId: 'default' }
const FLEET: Caller = { auth: { kind: 'token', tokenName: 'agent-d-token' }, role: 'fleet_agent', tokenAgentId: 'agent-d', tenantId: 'default' }
const SHARED: Caller = { auth: { kind: 'token' }, role: 'admin', tenantId: 'default' } // the file token: no name, no agent
const OPERATOR: Caller = { auth: { kind: 'token', tokenName: 'operator' }, role: 'admin', tenantId: 'default' }
const DEVICE: Caller = { auth: { kind: 'device', device: 'phone' } as RouteContext['auth'], role: 'agent', tenantId: 'default' }
const sessionOf = (name: string, role: RouteContext['role'], tenant: string | null = null): Caller =>
  ({ auth: { kind: 'session', user: name }, role, tenantId: tenant, cookie: cookies[name] })
const OWNER = (): Caller => sessionOf('owner', 'admin')

async function call(method: string, path: string, caller: Caller, body?: object) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = caller.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${caller.cookie}` } : {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    setHeader() {},
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req, res, path: url.pathname, method, url, auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId, tenantId: caller.tenantId,
  } as unknown as RouteContext
  let handled = false
  for (const h of HANDLERS) { if (await h(ctx)) { handled = true; break } }
  expect(handled).toBe(true)
  return out
}

/** Everything the routes under test can change. */
function snapshot(): string {
  return JSON.stringify({
    users: db.prepare('SELECT id, username, password_hash, role, tenant_id, disabled FROM dashboard_users ORDER BY id').all(),
    tokens: db.prepare('SELECT id, name, role, revoked_at FROM api_tokens ORDER BY id').all(),
    keys: db.prepare('SELECT id, name FROM device_keys ORDER BY id').all(),
  })
}

interface RouteCase { name: string; method: string; path: () => string; body?: () => object }

// Session-only once a dashboard user exists.
const USER_ROUTES: RouteCase[] = [
  { name: 'POST /api/auth/users', method: 'POST', path: () => '/api/auth/users', body: () => ({ username: 'newuser', password: NEW_PASSWORD }) },
  { name: 'DELETE /api/auth/users/:name', method: 'DELETE', path: () => '/api/auth/users/tagent' },
  { name: 'POST /api/auth/password (bearer)', method: 'POST', path: () => '/api/auth/password', body: () => ({ username: 'owner', new_password: NEW_PASSWORD }) },
  { name: 'POST /api/admin/users', method: 'POST', path: () => '/api/admin/users', body: () => ({ username: 'newadmin', password: NEW_PASSWORD, role: 'admin' }) },
  { name: 'PATCH /api/admin/users/:id', method: 'PATCH', path: () => `/api/admin/users/${ids.tagent}`, body: () => ({ password: NEW_PASSWORD }) },
  { name: 'DELETE /api/admin/users/:id', method: 'DELETE', path: () => `/api/admin/users/${ids.tagent}` },
]

// Refused to an agent's credential, open to the operator and to a session.
const ISSUE_ROUTES: RouteCase[] = [
  { name: 'POST /api/admin/tokens', method: 'POST', path: () => '/api/admin/tokens', body: () => ({ name: 'minted', role: 'admin' }) },
  { name: 'POST /api/admin/tokens/:id/rotate', method: 'POST', path: () => `/api/admin/tokens/${seededTokenId}/rotate`, body: () => ({}) },
  { name: 'POST /api/admin/browser-enroll-codes', method: 'POST', path: () => '/api/admin/browser-enroll-codes', body: () => ({}) },
  { name: 'POST /api/auth/device-keys', method: 'POST', path: () => '/api/auth/device-keys', body: () => ({ name: 'laptop' }) },
  { name: 'POST /api/security/bridge-enroll', method: 'POST', path: () => '/api/security/bridge-enroll', body: () => ({ key_line: 'ssh-ed25519 AAAA marveen-remote:00000000-0000-4000-8000-000000000000', name: 'laptop' }) },
]

const run = (r: RouteCase, caller: Caller) => call(r.method, r.path(), caller, r.body?.())
const isRefusal = (out: { status: number; body: any }) => out.status === 403 && out.body?.code === 'human_session_required'

describe('user management and the bearer password reset (enforce, a user exists)', () => {
  const NOT_PERSONS: Array<[string, Caller]> = [['the main agent token', MAIN], ['a fleet agent token', FLEET], ['the shared token', SHARED], ['the operator token', OPERATOR], ['a device key', DEVICE]]

  for (const route of USER_ROUTES) {
    for (const [who, caller] of NOT_PERSONS) {
      it(`refuses ${who} on ${route.name} and changes nothing`, async () => {
        const before = snapshot()
        const out = await run(route, caller)
        expect(out.status).toBe(403)
        expect(out.body.error).toBe('forbidden')
        if (!(caller === DEVICE && route.name.includes('password'))) expect(out.body.code).toBe('human_session_required')
        expect(snapshot()).toBe(before)
      })
    }
  }

  for (const route of USER_ROUTES.filter((r) => !r.name.includes('password'))) {
    it(`refuses a tenant admin session and a tenant agent session on ${route.name}`, async () => {
      const before = snapshot()
      expect(isRefusal(await run(route, sessionOf('tadmin', 'admin', 'tenant-b')))).toBe(true)
      expect(isRefusal(await run(route, sessionOf('tagent', 'agent', 'tenant-b')))).toBe(true)
      expect(snapshot()).toBe(before)
    })
  }

  for (const route of USER_ROUTES.filter((r) => !r.name.includes('password'))) {
    it(`lets the global admin session through on ${route.name}`, async () => {
      const before = snapshot()
      const out = await run(route, OWNER())
      expect(out.status).toBeLessThan(300)
      expect(snapshot()).not.toBe(before)
    })
  }

  it('lets any session change its own password, a tenant agent included', async () => {
    const before = db.prepare('SELECT username, password_hash FROM dashboard_users ORDER BY id').all() as Array<{ username: string; password_hash: string }>
    const out = await call('POST', '/api/auth/password', sessionOf('tagent', 'agent', 'tenant-b'), { current_password: PASSWORD, new_password: NEW_PASSWORD })
    expect(out.status).toBe(200)
    const after = db.prepare('SELECT username, password_hash FROM dashboard_users ORDER BY id').all() as Array<{ username: string; password_hash: string }>
    expect(after.filter((u, i) => u.password_hash !== before[i]!.password_hash).map((u) => u.username)).toEqual(['tagent'])
  })

  it('does not let a session reset another user by naming one: it changes its own password only', async () => {
    const out = await call('POST', '/api/auth/password', sessionOf('tagent', 'agent', 'tenant-b'), { username: 'owner', current_password: 'wrong-current-pass', new_password: NEW_PASSWORD })
    expect(out.status).toBe(401)
  })

  it('journals a refusal, and still answers 403 when the journal cannot be written', async () => {
    const out = await call('POST', '/api/auth/users', MAIN, { username: 'x-user', password: NEW_PASSWORD })
    expect(out.status).toBe(403)
    expect(db.prepare("SELECT agent_id, entity, entity_id FROM agent_audit_log WHERE action = 'security.human_session_required'").all()).toEqual([
      { agent_id: 'main-token', entity: 'admin', entity_id: 'auth.user.create' },
    ])
    db.exec('DROP TABLE agent_audit_log')
    const again = await call('POST', '/api/auth/users', MAIN, { username: 'x-user', password: NEW_PASSWORD })
    expect(again.status).toBe(403)
    expect(again.body.code).toBe('human_session_required')
  })

  it('counts a browser that sends a token and the global admin cookie as the person, and nothing else', async () => {
    const body = { username: 'viaboth', password: NEW_PASSWORD }
    expect((await call('POST', '/api/auth/users', { ...MAIN, cookie: cookies.owner }, body)).status).toBe(201)
    expect(isRefusal(await call('POST', '/api/auth/users', { ...MAIN, cookie: cookies.tadmin }, { ...body, username: 'viatenant' }))).toBe(true)
    expect(isRefusal(await call('POST', '/api/auth/users', { ...MAIN, cookie: 'forged-cookie' }, { ...body, username: 'viaforged' }))).toBe(true)
  })

  it('stops counting a disabled global admin as a person', async () => {
    db.prepare("UPDATE dashboard_users SET disabled = 1 WHERE username = 'owner'").run()
    expect(isRefusal(await call('POST', '/api/auth/users', OWNER(), { username: 'x-user', password: NEW_PASSWORD }))).toBe(true)
  })
})

describe('the credential-issuing routes (enforce)', () => {
  for (const route of ISSUE_ROUTES) {
    for (const [who, caller] of [['the main agent token', MAIN], ['a fleet agent token', FLEET]] as Array<[string, Caller]>) {
      it(`refuses ${who} on ${route.name} and changes nothing`, async () => {
        const before = snapshot()
        const out = await run(route, caller)
        expect(isRefusal(out)).toBe(true)
        expect(snapshot()).toBe(before)
      })
    }

    it(`refuses the fleet_agent role on ${route.name} even when the token names no agent`, async () => {
      const before = snapshot()
      const out = await run(route, { ...FLEET, tokenAgentId: undefined })
      expect(isRefusal(out)).toBe(true)
      expect(snapshot()).toBe(before)
    })

    it(`refuses a device key on ${route.name}`, async () => {
      const before = snapshot()
      const out = await run(route, DEVICE)
      expect(out.status).toBe(403)
      expect(snapshot()).toBe(before)
    })

    for (const [who, make] of [['the operator token', () => OPERATOR], ['the shared token', () => SHARED], ['the global admin session', OWNER]] as Array<[string, () => Caller]>) {
      it(`still lets ${who} use ${route.name}`, async () => {
        expect((await run(route, make())).status).toBeLessThan(300)
      })
    }

    it(`lets a browser with the global admin cookie use ${route.name} even though it also sends the main agent token`, async () => {
      const out = await run(route, { ...MAIN, cookie: cookies.owner })
      expect(out.status).toBeLessThan(300)
    })
  }
})

describe('first run: no enabled dashboard user', () => {
  beforeEach(() => { db.prepare('DELETE FROM dashboard_users').run() })

  it('lets the bearer create the first user, and refuses the next bearer call', async () => {
    const first = await call('POST', '/api/auth/users', MAIN, { username: 'firstuser', password: NEW_PASSWORD })
    expect(first.status).toBe(201)
    const second = await call('POST', '/api/auth/users', MAIN, { username: 'seconduser', password: NEW_PASSWORD })
    expect(isRefusal(second)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM dashboard_users').get()).toEqual({ n: 1 })
  })

  it('lets the bearer create the first user through the admin route too', async () => {
    const out = await call('POST', '/api/admin/users', MAIN, { username: 'firstadmin', password: NEW_PASSWORD, role: 'admin' })
    expect(out.status).toBe(201)
  })

  it('treats a table of disabled users as first run', async () => {
    await createDashboardUser('dormant', realHash)
    db.prepare('UPDATE dashboard_users SET disabled = 1').run()
    const out = await call('POST', '/api/auth/users', MAIN, { username: 'woken', password: NEW_PASSWORD })
    expect(out.status).toBe(201)
  })

  it('still refuses an agent token a credential on the issuing routes', async () => {
    const out = await call('POST', '/api/admin/tokens', FLEET, { name: 'minted', role: 'admin' })
    expect(isRefusal(out)).toBe(true)
  })
})

describe('without enforcement (the default)', () => {
  beforeEach(() => { flags.enforce = false })

  for (const route of [...USER_ROUTES, ...ISSUE_ROUTES]) {
    it(`refuses nobody on ${route.name}`, async () => {
      for (const caller of [MAIN, FLEET, SHARED, OPERATOR, DEVICE]) {
        const out = await run(route, caller)
        expect(out.body?.code).not.toBe('human_session_required')
      }
    })
  }

  it('lets the main agent token do what it did before: create and reset users, mint a token', async () => {
    expect((await call('POST', '/api/auth/users', MAIN, { username: 'newuser', password: NEW_PASSWORD })).status).toBe(201)
    expect((await call('POST', '/api/auth/password', MAIN, { username: 'owner', new_password: NEW_PASSWORD })).status).toBe(200)
    expect((await call('POST', '/api/admin/users', MAIN, { username: 'newadmin', password: NEW_PASSWORD, role: 'admin' })).status).toBe(201)
    expect((await call('PATCH', `/api/admin/users/${ids.tagent}`, MAIN, { password: NEW_PASSWORD })).status).toBe(200)
    expect((await call('DELETE', `/api/admin/users/${ids.tagent}`, MAIN)).status).toBe(200)
    expect((await call('POST', '/api/admin/tokens', MAIN, { name: 'minted', role: 'admin' })).status).toBe(201)
    expect((await call('POST', '/api/admin/browser-enroll-codes', MAIN, {})).status).toBe(201)
    expect((await call('POST', '/api/auth/device-keys', MAIN, { name: 'laptop' })).status).toBe(201)
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'security.human_session_required'").get()).toEqual({ n: 0 })
  })
})

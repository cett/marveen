// Two requests that create the same user name at the same time: both pass the "name is free" check
// while they hash the password, the second INSERT loses on the UNIQUE index. The route answers 409 for
// the loser (one 201, one 409, one row), on both create routes. The hash is held back until two callers
// are inside it, so every run has the race instead of hoping the scheduler produces it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const gate = vi.hoisted(() => ({ expected: 1, entered: 0, waiters: [] as Array<() => void> }))

vi.mock('../web/password-hash.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/password-hash.js')>()),
  hashPassword: async () => {
    gate.entered++
    if (gate.entered >= gate.expected) {
      for (const release of gate.waiters.splice(0)) release()
    } else {
      await new Promise<void>((resolve) => gate.waiters.push(resolve))
    }
    return '$hash$'
  },
}))

import { initDatabase, createDashboardUser } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleAdminB2b } from '../web/routes/admin-b2b.js'
import { isUniqueViolationOn } from '../web/unique-violation.js'

const PASSWORD = 'another-long-password-2'
let cookie: string

beforeEach(async () => {
  gate.expected = 1
  gate.entered = 0
  gate.waiters = []
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  const owner = await createDashboardUser('owner', '$hash$') // the first user: global admin
  cookie = await createSession({ userId: owner.id, username: owner.username })
})

async function call(method: string, path: string, body: object) {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = method
  req.headers = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    setHeader() {},
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req, res, path: url.pathname, method, url, auth: { kind: 'session', user: 'owner' }, role: 'admin', tenantId: null,
  } as unknown as RouteContext
  const handled = (await tryHandleAuth(ctx)) || (await tryHandleAdminB2b(ctx))
  expect(handled).toBe(true)
  return out
}

const rowsNamed = (name: string) =>
  (db.prepare('SELECT COUNT(*) AS c FROM dashboard_users WHERE username = ? COLLATE NOCASE').get(name) as { c: number }).c

describe('POST /api/auth/users, two requests with one name', () => {
  it('creates one user, answers the other with 409 and leaves one row', async () => {
    gate.expected = 2
    const outs = await Promise.all([
      call('POST', '/api/auth/users', { username: 'newuser', password: PASSWORD }),
      call('POST', '/api/auth/users', { username: 'newuser', password: PASSWORD }),
    ])
    expect(gate.entered).toBe(2) // both were past the free-name check when they hashed
    expect(outs.map((o) => o.status).sort()).toEqual([201, 409])
    expect(outs.find((o) => o.status === 409)!.body).toEqual({ error: 'conflict' })
    expect(rowsNamed('newuser')).toBe(1)
  })

  it('treats names that differ only in case as the same name', async () => {
    gate.expected = 2
    const outs = await Promise.all([
      call('POST', '/api/auth/users', { username: 'Newuser', password: PASSWORD }),
      call('POST', '/api/auth/users', { username: 'newuser', password: PASSWORD }),
    ])
    expect(outs.map((o) => o.status).sort()).toEqual([201, 409])
    expect(rowsNamed('newuser')).toBe(1)
  })

  it('still answers 409 for the plain repeat (the check before the hash)', async () => {
    expect((await call('POST', '/api/auth/users', { username: 'newuser', password: PASSWORD })).status).toBe(201)
    expect((await call('POST', '/api/auth/users', { username: 'newuser', password: PASSWORD })).status).toBe(409)
    expect(rowsNamed('newuser')).toBe(1)
  })

  it('does not turn another insert failure into a 409 (negative control)', async () => {
    db.exec(`CREATE TRIGGER block_user_insert BEFORE INSERT ON dashboard_users BEGIN SELECT RAISE(ABORT, 'insert blocked'); END`)
    await expect(call('POST', '/api/auth/users', { username: 'newuser', password: PASSWORD })).rejects.toThrow(/insert blocked/)
    expect(rowsNamed('newuser')).toBe(0)
  })
})

describe('POST /api/admin/users, two requests with one name', () => {
  const body = { username: 'newadmin', password: PASSWORD, role: 'admin' }

  it('creates one user, answers the other with 409 and leaves one row', async () => {
    gate.expected = 2
    const outs = await Promise.all([call('POST', '/api/admin/users', body), call('POST', '/api/admin/users', body)])
    expect(gate.entered).toBe(2)
    expect(outs.map((o) => o.status).sort()).toEqual([201, 409])
    expect(outs.find((o) => o.status === 409)!.body).toMatchObject({ error: 'conflict', field: 'username' })
    expect(rowsNamed('newadmin')).toBe(1)
  })

  it('does not turn another insert failure into a 409 (negative control)', async () => {
    db.exec(`CREATE TRIGGER block_user_insert BEFORE INSERT ON dashboard_users BEGIN SELECT RAISE(ABORT, 'insert blocked'); END`)
    await expect(call('POST', '/api/admin/users', body)).rejects.toThrow(/insert blocked/)
    expect(rowsNamed('newadmin')).toBe(0)
  })
})

describe('isUniqueViolationOn', () => {
  const unique = (message: string, code = 'SQLITE_CONSTRAINT_UNIQUE') => Object.assign(new Error(message), { code })

  it('matches the named column only', () => {
    expect(isUniqueViolationOn(unique('UNIQUE constraint failed: dashboard_users.username'), 'dashboard_users.username')).toBe(true)
    expect(isUniqueViolationOn(unique('UNIQUE constraint failed: dashboard_users.email'), 'dashboard_users.username')).toBe(false)
  })

  it('does not match another constraint kind, a plain error or a non-error', () => {
    expect(isUniqueViolationOn(unique('UNIQUE constraint failed: dashboard_users.username', 'SQLITE_CONSTRAINT_TRIGGER'), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(new Error('UNIQUE constraint failed: dashboard_users.username'), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn('UNIQUE constraint failed: dashboard_users.username', 'dashboard_users.username')).toBe(false)
  })
})

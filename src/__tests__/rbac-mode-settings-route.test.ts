// Who may change RBAC_MODE through POST /api/settings, against a real in-memory database and real
// dashboard sessions. Tightening (shadow -> enforce) is open to any admin caller, whatever the human-only
// switch says. LOOSENING (-> shadow) is a global-admin human session only, with no dashboard user at all
// and for every kind of token, AND only while APPROVAL_HUMAN_ONLY_ENFORCE is on: with it off a token can
// create the dashboard admin that would loosen the gate, so a human session proves nothing (the chain is
// tested in both switch positions). A refusal leaves system_config untouched and is journalled. The switch
// is flipped per test through a live getter on the config mock.
//
// ISOLATION: initDatabase(':memory:') only. A shadow row in the shared store would loosen the live gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true, unreadable: false }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() {
    if (flags.unreadable) throw new Error('switch unreadable')
    return flags.enforce
  },
}))

import { initDatabase, createDashboardUser, getSystemConfig, setSystemConfig, logConfigChange } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { AuthResult } from '../web/auth-gate.js'
import { tryHandleSettings } from '../web/routes/settings.js'
import { tryHandleAdminB2b } from '../web/routes/admin-b2b.js'
import { getRbacMode, refreshRbacMode, stopRbacModeRefresh } from '../web/rbac-mode.js'
import { runRbacGate } from '../web/rbac-shadow-log.js'

const HASH = '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5'
let cookies: Record<string, string>

async function makeUser(name: string, role: string, tenant: string | null): Promise<string> {
  const u = await createDashboardUser(name, HASH)
  db.prepare('UPDATE dashboard_users SET role = ?, tenant_id = ? WHERE id = ?').run(role, tenant, u.id)
  return createSession({ userId: u.id, username: u.username })
}

interface Caller {
  auth: AuthResult
  role: string
  tokenAgentId?: string
  cookie?: string
}

const CALLERS: Record<string, Caller> = {
  adminToken: { auth: { kind: 'token', tokenName: 'ops' } as AuthResult, role: 'admin' },
  operatorToken: { auth: { kind: 'token' } as AuthResult, role: 'admin' },
  mainAgentToken: { auth: { kind: 'token', tokenName: 'main' } as AuthResult, role: 'admin', tokenAgentId: 'main-agent' },
  fleetAgentToken: { auth: { kind: 'token', tokenName: 'zack' } as AuthResult, role: 'fleet_agent', tokenAgentId: 'zack' },
  deviceKey: { auth: { kind: 'device', device: 'laptop' } as unknown as AuthResult, role: 'admin' },
  federationPeer: { auth: { kind: 'federation', peer: 'peer-1' } as unknown as AuthResult, role: 'admin' },
}

async function getRows(caller: Caller): Promise<Record<string, any>[]> {
  const em = new EventEmitter() as any
  em.headers = {}
  let out = ''
  const res = { writeHead: () => {}, setHeader: () => {}, end: (d?: string) => { out = d ?? '' } }
  const url = new URL('http://localhost/api/settings')
  const ctx = {
    req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: 'GET', url,
    auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId,
  } as unknown as RouteContext
  await tryHandleSettings(ctx)
  return JSON.parse(out).settings
}

async function post(caller: Caller, body: object): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body)
  const em = new EventEmitter() as any
  em.headers = caller.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${caller.cookie}` } : {}
  setImmediate(() => { em.emit('data', Buffer.from(raw)); em.emit('end') })
  let status = 200
  let out = ''
  const res = {
    writeHead: (c: number) => { status = c },
    setHeader: () => {},
    end: (d?: string) => { out = d ?? '' },
  }
  const url = new URL('http://localhost/api/settings')
  const ctx = {
    req: em as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method: 'POST',
    url,
    auth: caller.auth,
    role: caller.role,
    tokenAgentId: caller.tokenAgentId,
  } as unknown as RouteContext
  await tryHandleSettings(ctx)
  return { status, body: out ? JSON.parse(out) : undefined }
}

const loosen = { key: 'RBAC_MODE', value: 'shadow' }
const tighten = { key: 'RBAC_MODE', value: 'enforce' }

function storedValue(): string | undefined {
  return getSystemConfig('RBAC_MODE')?.value
}

function refusals(): Array<{ entity_id: string }> {
  return db
    .prepare("SELECT entity_id FROM agent_audit_log WHERE action = 'security.human_session_required' AND entity_id = 'settings.rbac_mode.loosen'")
    .all() as Array<{ entity_id: string }>
}

function lastJournal(): { old_value: string | null; new_value: string | null; actor: string } | undefined {
  return db
    .prepare("SELECT old_value, new_value, actor FROM config_change_log WHERE key = 'RBAC_MODE' ORDER BY id DESC LIMIT 1")
    .get() as any
}

function noticesToMainAgent(): string[] {
  return (db.prepare("SELECT content FROM agent_messages WHERE to_agent = 'main-agent'").all() as Array<{ content: string }>).map((r) => r.content)
}

beforeEach(async () => {
  flags.enforce = true
  flags.unreadable = false
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  stopRbacModeRefresh()
  cookies = {
    owner: await makeUser('owner', 'admin', null),
    tenantAdmin: await makeUser('tadmin', 'admin', 'tenant-a'),
    viewer: await makeUser('viewer', 'viewer', null),
  }
  await setSystemConfig('RBAC_MODE', 'enforce', 'db')
  await refreshRbacMode(undefined)
})

afterEach(() => {
  stopRbacModeRefresh()
})

describe('loosening RBAC_MODE', () => {
  it.each(Object.keys(CALLERS))('is refused for %j: 403, the row is unchanged, the attempt is journalled', async (name) => {
    const r = await post(CALLERS[name]!, loosen)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('human_session_required')
    expect(storedValue()).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
    expect(refusals()).toHaveLength(1)
    expect(noticesToMainAgent()).toHaveLength(0)
    expect(lastJournal()).toBeUndefined()
  })

  it('is refused for a session that is not a global admin (tenant admin, viewer)', async () => {
    for (const who of ['tenantAdmin', 'viewer']) {
      const r = await post({ auth: { kind: 'session', user: who } as AuthResult, role: 'admin', cookie: cookies[who] }, loosen)
      expect(r.status, who).toBe(403)
    }
    expect(storedValue()).toBe('enforce')
    expect(refusals()).toHaveLength(2)
  })

  it('is refused for a forged or missing session cookie', async () => {
    expect((await post({ ...CALLERS['adminToken']!, cookie: 'forged' }, loosen)).status).toBe(403)
    expect((await post({ auth: { kind: 'session' } as AuthResult, role: 'admin' }, loosen)).status).toBe(403)
    expect(storedValue()).toBe('enforce')
  })

  it('does not let a padded or upper-case spelling slip past the guard: the registry rejects it', async () => {
    for (const value of [' SHADOW ', 'Shadow', 'SHADOW']) {
      const r = await post(CALLERS['mainAgentToken']!, { key: 'RBAC_MODE', value })
      expect(r.status, value).toBe(400)
    }
    expect(storedValue()).toBe('enforce')
  })

  it('is refused with no dashboard user at all: the first-run bearer exemption does not apply', async () => {
    db.prepare('DELETE FROM dashboard_users').run()
    const r = await post(CALLERS['operatorToken']!, loosen)
    expect(r.status).toBe(403)
    expect(storedValue()).toBe('enforce')
  })

  it('passes for a global admin human session, takes effect at once, is journalled and announced', async () => {
    const r = await post({ auth: { kind: 'session', user: 'owner' } as AuthResult, role: 'admin', cookie: cookies['owner'] }, { ...loosen, actor: 'owner' })
    expect(r.status).toBe(200)
    expect(storedValue()).toBe('shadow')
    expect(getRbacMode()).toBe('shadow')
    expect(lastJournal()).toEqual({ old_value: 'enforce', new_value: 'shadow', actor: 'owner' })
    expect(refusals()).toHaveLength(0)
    const notices = noticesToMainAgent()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('shadow')
  })

  it('does not guard other settings: a token still writes an ordinary key', async () => {
    const r = await post(CALLERS['adminToken']!, { key: 'DASHBOARD_LANG', value: 'en' })
    expect(r.status).toBe(200)
  })

  it('does not let an invalid value reach the guard path or the table', async () => {
    const r = await post(CALLERS['mainAgentToken']!, { key: 'RBAC_MODE', value: 'off' })
    expect(r.status).toBe(400)
    expect(storedValue()).toBe('enforce')
    expect(refusals()).toHaveLength(0)
  })
})

// The user-creation route a token reaches while the human-only switch is off.
async function createUserAs(caller: Caller, body: object): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body)
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { em.emit('data', Buffer.from(raw)); em.emit('end') })
  let status = 200
  let out = ''
  const res = { writeHead: (c: number) => { status = c }, setHeader: () => {}, end: (d?: string) => { out = d ?? '' } }
  const url = new URL('http://localhost/api/admin/users')
  const ctx = {
    req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: 'POST', url,
    auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId,
  } as unknown as RouteContext
  await tryHandleAdminB2b(ctx)
  return { status, body: out ? JSON.parse(out) : undefined }
}

function switchRefusals(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'security.human_only_enforce_required' AND entity_id = 'settings.rbac_mode.loosen'")
      .get() as { n: number }
  ).n
}

describe('loosening needs the human-only switch on', () => {
  const ownerSession = (): Caller => ({ auth: { kind: 'session', user: 'owner' } as AuthResult, role: 'admin', cookie: cookies['owner'] })

  it('is refused for a global admin human session while the switch is off', async () => {
    flags.enforce = false
    const r = await post(ownerSession(), loosen)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('human_only_enforce_required')
    expect(storedValue()).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
    expect(switchRefusals()).toBe(1)
    expect(noticesToMainAgent()).toHaveLength(0)
    expect(lastJournal()).toBeUndefined()
  })

  it.each(Object.keys(CALLERS))('is refused for %j while the switch is off, with the switch code', async (name) => {
    flags.enforce = false
    const r = await post(CALLERS[name]!, loosen)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('human_only_enforce_required')
    expect(storedValue()).toBe('enforce')
  })

  it('fails closed when the switch cannot be read', async () => {
    flags.unreadable = true
    const r = await post(ownerSession(), loosen)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('human_only_enforce_required')
    expect(storedValue()).toBe('enforce')
  })

  it('passes for the same session once the switch is on', async () => {
    flags.enforce = false
    expect((await post(ownerSession(), loosen)).status).toBe(403)
    flags.enforce = true
    expect((await post(ownerSession(), loosen)).status).toBe(200)
    expect(getRbacMode()).toBe('shadow')
  })

  it('does not hold tightening back: an admin token tightens with the switch off', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'owner')
    await refreshRbacMode(undefined)
    flags.enforce = false
    expect((await post(CALLERS['adminToken']!, tighten)).status).toBe(200)
    expect(storedValue()).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
  })

  describe('the chain: token creates a user, the user logs in, the user loosens', () => {
    const NEW_USER = { username: 'minted-admin', password: 'correct-horse-battery-1', role: 'admin' }

    async function loginAs(username: string): Promise<Caller> {
      // The login route only verifies the password and then issues exactly this session.
      const u = db.prepare('SELECT id, username FROM dashboard_users WHERE username = ?').get(username) as { id: number; username: string }
      return { auth: { kind: 'session', user: username } as AuthResult, role: 'admin', cookie: await createSession({ userId: u.id, username: u.username }) }
    }

    it('switch OFF: the token does mint a global admin, and that admin still cannot loosen', async () => {
      flags.enforce = false
      for (const who of ['mainAgentToken', 'adminToken']) {
        const minted = await createUserAs(CALLERS[who]!, { ...NEW_USER, username: `minted-${who}` })
        expect(minted.status, who).toBe(201)
        const row = db.prepare('SELECT role, tenant_id FROM dashboard_users WHERE username = ?').get(`minted-${who}`) as { role: string; tenant_id: string | null }
        expect(row).toEqual({ role: 'admin', tenant_id: null })
        const r = await post(await loginAs(`minted-${who}`), loosen)
        expect(r.status, who).toBe(403)
        expect(r.body.code).toBe('human_only_enforce_required')
      }
      expect(storedValue()).toBe('enforce')
      expect(getRbacMode()).toBe('enforce')
    })

    it('switch ON: the token cannot mint the user at all, so there is no session to loosen with', async () => {
      const before = (db.prepare('SELECT COUNT(*) AS n FROM dashboard_users').get() as { n: number }).n
      for (const who of ['mainAgentToken', 'adminToken', 'operatorToken']) {
        const minted = await createUserAs(CALLERS[who]!, { ...NEW_USER, username: `minted-${who}` })
        expect(minted.status, who).toBe(403)
        expect(minted.body.code).toBe('human_session_required')
      }
      expect((db.prepare('SELECT COUNT(*) AS n FROM dashboard_users').get() as { n: number }).n).toBe(before)
      expect((await post({ ...CALLERS['mainAgentToken']!, cookie: 'forged' }, loosen)).status).toBe(403)
      expect(storedValue()).toBe('enforce')
    })
  })
})

describe('tightening RBAC_MODE', () => {
  beforeEach(async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'owner')
    await refreshRbacMode(undefined)
    expect(getRbacMode()).toBe('shadow')
  })

  it.each(['adminToken', 'mainAgentToken', 'operatorToken'])('is open to %j and takes effect at once', async (name) => {
    const noticesBefore = noticesToMainAgent().length
    const r = await post(CALLERS[name]!, tighten)
    expect(r.status).toBe(200)
    expect(storedValue()).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
    expect(lastJournal()?.new_value).toBe('enforce')
    expect(noticesToMainAgent()).toHaveLength(noticesBefore)
  })

  it('is open to a global admin session too', async () => {
    const r = await post({ auth: { kind: 'session', user: 'owner' } as AuthResult, role: 'admin', cookie: cookies['owner'] }, tighten)
    expect(r.status).toBe(200)
    expect(getRbacMode()).toBe('enforce')
  })
})

describe('the gate follows the mode without a restart', () => {
  // A viewer session writing a setting is a denial in enforce mode and a would-deny in shadow mode.
  const viewer = { kind: 'session', user: 'viewer', role: 'viewer', tenantId: 'tenant-a' } as unknown as AuthResult

  async function gate(): Promise<{ passed: boolean; status: number }> {
    let status = 200
    const res = {
      writeHead: (c: number) => { status = c },
      setHeader: () => {},
      end: () => {},
    }
    const passed = await runRbacGate(viewer, 'POST', '/api/settings', res as unknown as http.ServerResponse, getRbacMode())
    return { passed, status }
  }

  it('blocks in enforce, passes in shadow, blocks again after the switch back', async () => {
    expect((await gate()).passed).toBe(false)
    expect((await gate()).status).toBe(403)

    expect((await post({ auth: { kind: 'session', user: 'owner' } as AuthResult, role: 'admin', cookie: cookies['owner'] }, loosen)).status).toBe(200)
    expect((await gate()).passed).toBe(true)

    expect((await post(CALLERS['adminToken']!, tighten)).status).toBe(200)
    expect((await gate()).passed).toBe(false)
  })

  it('web.ts hands the gate the live getter and no longer imports a boot-time constant', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web.ts'), 'utf-8')
    expect(src).toContain('runRbacGate(auth, method, path, res, getRbacMode())')
    expect(src).not.toMatch(/\bRBAC_MODE\b\s*[,}]/)
  })
})

describe('GET /api/settings reports what the gate applies for RBAC_MODE', () => {
  const rbacRow = async (caller: Caller = CALLERS['adminToken']!) => (await getRows(caller)).find((r) => r.key === 'RBAC_MODE')!

  it('a plain enforce: value enforce, stored enforce, no reason', async () => {
    const row = await rbacRow()
    expect(row).toMatchObject({ value: 'enforce', stored: 'enforce', reason: null })
  })

  it('a journalled shadow: value shadow, no reason', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'owner')
    await refreshRbacMode(undefined)
    expect(await rbacRow()).toMatchObject({ value: 'shadow', stored: 'shadow', reason: null })
  })

  it('an unlogged hand-written shadow: value enforce (what the gate uses), stored shadow, reason says why', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await refreshRbacMode(undefined)
    expect(getRbacMode()).toBe('enforce')
    expect(await rbacRow()).toMatchObject({ value: 'enforce', stored: 'shadow', reason: 'unlogged_shadow' })
  })

  it('the env brake over a stored shadow: value enforce, stored shadow, reason env_enforce', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'owner')
    await refreshRbacMode('enforce')
    expect(await rbacRow()).toMatchObject({ value: 'enforce', stored: 'shadow', reason: 'env_enforce' })
  })

  it('other rows carry no stored/reason fields', async () => {
    const row = (await getRows(CALLERS['adminToken']!)).find((r) => r.key === 'DASHBOARD_LANG')!
    expect(row).not.toHaveProperty('stored')
    expect(row).not.toHaveProperty('reason')
  })

  it('a non-admin caller does not get the RBAC_MODE row at all', async () => {
    const rows = await getRows({ auth: { kind: 'session', user: 'viewer' } as AuthResult, role: 'viewer' })
    expect(rows.find((r) => r.key === 'RBAC_MODE')).toBeUndefined()
  })
})

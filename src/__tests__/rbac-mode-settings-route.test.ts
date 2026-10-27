// Who may change RBAC_MODE through POST /api/settings, against a real in-memory database and real
// dashboard sessions. Tightening (shadow -> enforce) is open to any admin caller; LOOSENING (-> shadow) is
// a global-admin human session only, with the switch APPROVAL_HUMAN_ONLY_ENFORCE off, with no dashboard
// user at all, and for every kind of token. A refusal leaves system_config untouched and is journalled.
//
// ISOLATION: initDatabase(':memory:') only. A shadow row in the shared store would loosen the live gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// The human-only switch is deliberately OFF: the loosening guard must not depend on it.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  APPROVAL_HUMAN_ONLY_ENFORCE: false,
}))

import { initDatabase, createDashboardUser, getSystemConfig, setSystemConfig, logConfigChange } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { AuthResult } from '../web/auth-gate.js'
import { tryHandleSettings } from '../web/routes/settings.js'
import { getRbacMode, refreshRbacMode, stopRbacModeRefresh } from '../web/rbac-mode.js'
import { runRbacGate } from '../web/rbac-shadow-log.js'

const HASH = '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5'
let cookies: Record<string, string>

function makeUser(name: string, role: string, tenant: string | null): string {
  const u = createDashboardUser(name, HASH)
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

beforeEach(() => {
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  stopRbacModeRefresh()
  cookies = {
    owner: makeUser('owner', 'admin', null),
    tenantAdmin: makeUser('tadmin', 'admin', 'tenant-a'),
    viewer: makeUser('viewer', 'viewer', null),
  }
  setSystemConfig('RBAC_MODE', 'enforce', 'db')
  refreshRbacMode(undefined)
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

describe('tightening RBAC_MODE', () => {
  beforeEach(() => {
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'owner')
    refreshRbacMode(undefined)
    expect(getRbacMode()).toBe('shadow')
  })

  it.each(['adminToken', 'mainAgentToken', 'operatorToken'])('is open to %j and takes effect at once', async (name) => {
    const r = await post(CALLERS[name]!, tighten)
    expect(r.status).toBe(200)
    expect(storedValue()).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
    expect(lastJournal()?.new_value).toBe('enforce')
    expect(noticesToMainAgent()).toHaveLength(0)
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

  function gate(): { passed: boolean; status: number } {
    let status = 200
    const res = {
      writeHead: (c: number) => { status = c },
      setHeader: () => {},
      end: () => {},
    }
    const passed = runRbacGate(viewer, 'POST', '/api/settings', res as unknown as http.ServerResponse, getRbacMode())
    return { passed, status }
  }

  it('blocks in enforce, passes in shadow, blocks again after the switch back', async () => {
    expect(gate().passed).toBe(false)
    expect(gate().status).toBe(403)

    expect((await post({ auth: { kind: 'session', user: 'owner' } as AuthResult, role: 'admin', cookie: cookies['owner'] }, loosen)).status).toBe(200)
    expect(gate().passed).toBe(true)

    expect((await post(CALLERS['adminToken']!, tighten)).status).toBe(200)
    expect(gate().passed).toBe(false)
  })

  it('web.ts hands the gate the live getter and no longer imports a boot-time constant', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web.ts'), 'utf-8')
    expect(src).toContain('runRbacGate(auth, method, path, res, getRbacMode())')
    expect(src).not.toMatch(/\bRBAC_MODE\b\s*[,}]/)
  })
})

// CLAUDE_ROTATION_MODE: who may write it through POST /api/settings, and what the monitor reads back.
//
// Writes: every value (act, observe, off) needs a person logged in as a global admin; every kind of token
// (the main agent's and the operator's included), a device key and a federation peer is refused. Moving to
// act needs the human-only switch on as well. A refusal leaves system_config, the journal and the breaker
// flag untouched and is journalled. A person's write takes the session user as the journal actor and clears a
// tripped breaker.
//
// Reads: the monitor trusts a stored off/act only when the row came through the route (source 'db') AND the
// change journal says the same. Everything else is observe.
//
// ISOLATION: initDatabase(':memory:') and a throwaway STORE_DIR only. Nothing here touches the live store.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true, unreadable: false, storeDir: '', isolated: false }))

// one throwaway store for both mocks: the vault (paths.ts) and the config read the same directory
const shared = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('node:fs')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const store = join(mkdtempSync(join(tmpdir(), 'plan-rotation-mode-test-')), 'store') as string
  mkdirSync(store, { recursive: true })
  return { store }
})
vi.mock('../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../paths.js')>()), STORE_DIR: shared.store }))
vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  const store = shared.store
  flags.storeDir = store
  return {
    ...orig,
    STORE_DIR: store,
    MAIN_AGENT_ID: 'main-agent',
    get IS_ISOLATED_MODE() {
      return flags.isolated
    },
    get APPROVAL_HUMAN_ONLY_ENFORCE() {
      if (flags.unreadable) throw new Error('switch unreadable')
      return flags.enforce
    },
  }
})

import { initDatabase, createDashboardUser, getSystemConfig, setSystemConfig, logConfigChange } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { AuthResult } from '../web/auth-gate.js'
import { tryHandleSettings } from '../web/routes/settings.js'
import {
  readRotationMode,
  parseRotationModeStrict,
  _resetRotationModeWarningForTest,
  ROTATION_MODE_KEY,
} from '../web/plan-rotation-mode.js'
import { CLAUDE_PLANS_STATE_PATH, readClaudePlansState } from '../web/claude-plans-state.js'
import { createPlanRotationMonitor } from '../web/plan-rotation-monitor.js'

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
  fleetAgentToken: { auth: { kind: 'token', tokenName: 'agent-a' } as AuthResult, role: 'fleet_agent', tokenAgentId: 'agent-a' },
  deviceKey: { auth: { kind: 'device', device: 'laptop' } as unknown as AuthResult, role: 'admin' },
  federationPeer: { auth: { kind: 'federation', peer: 'peer-1' } as unknown as AuthResult, role: 'admin' },
}

function sessionCaller(cookie: string): Caller {
  return { auth: { kind: 'session', user: 'x' } as unknown as AuthResult, role: 'admin', cookie }
}

async function call(
  caller: Caller,
  method: 'GET' | 'POST',
  body?: object,
): Promise<{ status: number; body: any }> {
  const em = new EventEmitter() as any
  em.headers = caller.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${caller.cookie}` } : {}
  if (body) {
    const raw = JSON.stringify(body)
    setImmediate(() => { em.emit('data', Buffer.from(raw)); em.emit('end') })
  }
  let status = 200
  let out = ''
  const res = { writeHead: (c: number) => { status = c }, setHeader: () => {}, end: (d?: string) => { out = d ?? '' } }
  const url = new URL('http://localhost/api/settings')
  const ctx = {
    req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method, url,
    auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId,
  } as unknown as RouteContext
  await tryHandleSettings(ctx)
  return { status, body: out ? JSON.parse(out) : undefined }
}

const post = (caller: Caller, value: string) => call(caller, 'POST', { key: ROTATION_MODE_KEY, value })
const rotationRow = async (caller: Caller = CALLERS['adminToken']!) =>
  ((await call(caller, 'GET')).body.settings as Array<Record<string, any>>).find((r) => r.key === ROTATION_MODE_KEY)

const stored = () => getSystemConfig(ROTATION_MODE_KEY)?.value
const journalRows = () =>
  db.prepare("SELECT old_value, new_value, actor FROM config_change_log WHERE key = ? ORDER BY id").all(ROTATION_MODE_KEY) as Array<{ old_value: string | null; new_value: string | null; actor: string }>
const refusals = () =>
  (db.prepare("SELECT action, entity_id FROM agent_audit_log WHERE entity_id = 'settings.rotation_mode.write'").all() as Array<{ action: string }>)

function trippedBreakerOnDisk(): void {
  writeFileSync(
    CLAUDE_PLANS_STATE_PATH,
    JSON.stringify({ activePlanByAgent: { 'agent-a': 'plan-a' }, plans: {}, monitor: { lastTickAt: 5, breaker: { tripped: true, since: 4 } } }),
  )
}

beforeEach(async () => {
  flags.enforce = true
  flags.unreadable = false
  flags.isolated = false
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  _resetRotationModeWarningForTest()
  cookies = {
    owner: await makeUser('owner', 'admin', null),
    tenantAdmin: await makeUser('tadmin', 'admin', 'tenant-a'),
    viewer: await makeUser('viewer', 'viewer', null),
  }
  trippedBreakerOnDisk()
})

afterEach(() => {
  _clearSessionCacheForTest()
})

const VALUES = ['act', 'observe', 'off'] as const

describe('writing CLAUDE_ROTATION_MODE: who is refused', () => {
  for (const [name, caller] of Object.entries(CALLERS)) {
    for (const value of VALUES) {
      it(`${name} -> ${value}: 403, nothing written, breaker kept, refusal journalled`, async () => {
        const r = await post(caller, value)
        expect(r.status).toBe(403)
        expect(r.body.error).toBe('forbidden')
        expect(stored()).toBeUndefined()
        expect(journalRows()).toEqual([])
        expect(readClaudePlansState().monitor?.breaker).toEqual({ tripped: true, since: 4 })
        expect(refusals().length).toBeGreaterThan(0)
      })
    }
  }

  it('a token that also carries the owner cookie is judged by the cookie: the person passes', async () => {
    const r = await post({ ...CALLERS['mainAgentToken']!, cookie: cookies['owner'] }, 'observe')
    expect(r.status).toBe(200)
  })

  for (const who of ['tenantAdmin', 'viewer'] as const) {
    for (const value of VALUES) {
      it(`a ${who} session is not the owner: ${value} refused`, async () => {
        const r = await post(sessionCaller(cookies[who]!), value)
        expect(r.status).toBe(403)
        expect(stored()).toBeUndefined()
      })
    }
  }

  it('a session cookie that is not valid is refused', async () => {
    const r = await post(sessionCaller('not-a-session'), 'off')
    expect(r.status).toBe(403)
    expect(stored()).toBeUndefined()
  })

  it('a refused write does not change an existing value', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db')
    await logConfigChange(ROTATION_MODE_KEY, null, 'act', 'owner')
    const r = await post(CALLERS['mainAgentToken']!, 'off')
    expect(r.status).toBe(403)
    expect(stored()).toBe('act')
    expect(journalRows()).toHaveLength(1)
  })
})

describe('writing CLAUDE_ROTATION_MODE: the owner', () => {
  for (const value of VALUES) {
    it(`owner session -> ${value}: 200, row + journal written, actor is the session user`, async () => {
      const r = await call(sessionCaller(cookies['owner']!), 'POST', { key: ROTATION_MODE_KEY, value, actor: 'someone-else' })
      expect(r.status).toBe(200)
      expect(stored()).toBe(value)
      const rows = journalRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ new_value: value, actor: 'owner' })
      expect((await readRotationMode()).mode).toBe(value)
    })
  }

  it('a person writing the mode clears a tripped breaker and stamps resetAt', async () => {
    const before = Date.now()
    const r = await post(sessionCaller(cookies['owner']!), 'act')
    expect(r.status).toBe(200)
    const state = readClaudePlansState()
    expect(state.monitor?.breaker).toBeUndefined()
    expect(state.monitor?.resetAt).toBeGreaterThanOrEqual(before)
    expect(state.monitor?.resetAt).toBeLessThanOrEqual(Date.now())
    // the rest of the state survives the reset
    expect(state.monitor?.lastTickAt).toBe(5)
    expect(state.activePlanByAgent).toEqual({ 'agent-a': 'plan-a' })
  })

  it('the reset keeps the log (the cooldown needs it) and stamps resetAt even with no tripped flag', async () => {
    const entry = { ts: 1_700_000_000_000, agentId: 'agent-a', from: 'plan-a', to: 'plan-b', trigger: 'soft', mode: 'act', result: 'rotated' }
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: {}, plans: {}, monitor: { rotationLog: [entry] } }))
    const r = await post(sessionCaller(cookies['owner']!), 'act')
    expect(r.status).toBe(200)
    const m = readClaudePlansState().monitor
    expect(m?.rotationLog).toHaveLength(1)
    expect(m?.resetAt).toBeGreaterThan(entry.ts)
  })

  it('with no breaker and no state file the write still succeeds and creates no file', async () => {
    const { rmSync } = await import('node:fs')
    rmSync(CLAUDE_PLANS_STATE_PATH)
    const r = await post(sessionCaller(cookies['owner']!), 'observe')
    expect(r.status).toBe(200)
    expect(existsSync(CLAUDE_PLANS_STATE_PATH)).toBe(false)
  })

  it('an invalid value is refused before anything is written', async () => {
    const r = await post(sessionCaller(cookies['owner']!), 'sometimes')
    expect(r.status).toBe(400)
    expect(stored()).toBeUndefined()
    expect(readClaudePlansState().monitor?.breaker).toBeDefined()
  })
})

describe('writing CLAUDE_ROTATION_MODE: the human-only switch', () => {
  it('switch off: act is refused even for the owner (a token could mint that user)', async () => {
    flags.enforce = false
    const r = await post(sessionCaller(cookies['owner']!), 'act')
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('human_only_enforce_required')
    expect(stored()).toBeUndefined()
  })

  it('switch off: moving DOWN to observe or off is still open to the owner session', async () => {
    flags.enforce = false
    for (const value of ['observe', 'off'] as const) {
      const r = await post(sessionCaller(cookies['owner']!), value)
      expect(r.status).toBe(200)
      expect(stored()).toBe(value)
    }
  })

  it('switch off: a token is still refused for observe/off (session is required for every value)', async () => {
    flags.enforce = false
    const r = await post(CALLERS['mainAgentToken']!, 'off')
    expect(r.status).toBe(403)
    expect(stored()).toBeUndefined()
  })

  it('switch unreadable counts as off: act refused, fail closed', async () => {
    flags.unreadable = true
    const r = await post(sessionCaller(cookies['owner']!), 'act')
    expect(r.status).toBe(403)
    expect(stored()).toBeUndefined()
  })
})

describe('reading: what the monitor applies', () => {
  it('no row: observe, nothing to explain', async () => {
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: null, reason: null })
  })

  it('act written through the route is act', async () => {
    await post(sessionCaller(cookies['owner']!), 'act')
    expect(await readRotationMode()).toEqual({ mode: 'act', stored: 'act', reason: null })
  })

  it('an act row with NO journal row is observe (a hand-written row)', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db')
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'act', reason: 'unlogged_value' })
  })

  it('an act row whose newest journal row says something else is observe', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db')
    await logConfigChange(ROTATION_MODE_KEY, null, 'act', 'owner')
    await logConfigChange(ROTATION_MODE_KEY, 'act', 'observe', 'owner')
    expect((await readRotationMode()).reason).toBe('unlogged_value')
    expect((await readRotationMode()).mode).toBe('observe')
  })

  it('an act row migrated in from a side-car file is observe even with a matching journal', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'migrated_from_json')
    await logConfigChange(ROTATION_MODE_KEY, null, 'act', 'owner')
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'act', reason: 'not_db_source' })
  })

  it('an unconfirmed OFF is observe too: nobody quietly switches the monitor off', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'off', 'db')
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'off', reason: 'unlogged_value' })
  })

  it('a confirmed off is off', async () => {
    await post(sessionCaller(cookies['owner']!), 'off')
    expect((await readRotationMode()).mode).toBe('off')
  })

  it('a stored observe needs no journal', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'observe', 'migrated_from_json')
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'observe', reason: null })
  })

  it('misspellings and junk are observe, never act', async () => {
    for (const junk of ['acting', 'ACT!', 'on', '1', 'true', '', ' ', 'act act', 'a ct']) {
      await setSystemConfig(ROTATION_MODE_KEY, junk, 'db')
      await logConfigChange(ROTATION_MODE_KEY, null, junk, 'owner')
      const r = await readRotationMode()
      expect(r.mode, `value ${JSON.stringify(junk)}`).toBe('observe')
      expect(r.reason).toBe('invalid_value')
    }
  })

  it('the exact word is accepted in any case and with padding, when journalled the same', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, ' ACT ', 'db')
    await logConfigChange(ROTATION_MODE_KEY, null, 'act', 'owner')
    expect((await readRotationMode()).mode).toBe('act')
  })

  it('an unreadable table is observe', async () => {
    db.prepare('DROP TABLE system_config').run()
    const r = await readRotationMode()
    expect(r.mode).toBe('observe')
    expect(r.reason).toBe('read_error')
  })

  it('parseRotationModeStrict is exact', () => {
    expect(parseRotationModeStrict('act')).toBe('act')
    expect(parseRotationModeStrict(' Observe ')).toBe('observe')
    expect(parseRotationModeStrict('OFF')).toBe('off')
    for (const bad of ['', 'acts', 'enforce', null, undefined, 1, {}]) expect(parseRotationModeStrict(bad)).toBeNull()
  })

  it('the reader takes nothing from the env file, the process env or any other file', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'web', 'plan-rotation-mode.ts'), 'utf-8')
    const code = src.replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/settings-store|readEnvFile|process\.env|getEffectiveSettingValue|readFileSync|from '\.\.\/env/)
  })
})

describe('GET /api/settings reports what the monitor applies', () => {
  it('shows observe + the stored value + the reason for an unjournalled act row', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db')
    const row = await rotationRow()
    expect(row).toMatchObject({ value: 'observe', stored: 'act', reason: 'unlogged_value', default: 'observe' })
  })

  it('shows act once the route wrote it', async () => {
    await post(sessionCaller(cookies['owner']!), 'act')
    expect(await rotationRow()).toMatchObject({ value: 'act', stored: 'act', reason: null })
  })

  it('is not visible to a non-admin caller', async () => {
    const rows = (await call({ ...CALLERS['adminToken']!, role: 'viewer' }, 'GET')).body.settings as Array<{ key: string }>
    expect(rows.some((r) => r.key === ROTATION_MODE_KEY)).toBe(false)
  })

  it('the registry carries the safe default and the full value set', async () => {
    const { getSettingDefinition } = await import('../config-registry.js')
    const def = getSettingDefinition(ROTATION_MODE_KEY)!
    expect(def.default).toBe('observe')
    expect(def.valueSet).toEqual(['off', 'observe', 'act'])
    expect(def.secret).toBe(false)
    expect(def.envOnly).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Every known way to put a value in system_config. The reader trusts a row that came through the settings
// route, so any OTHER writer that could reach this key is a hole: from there an agent could tip the monitor
// into act. The writers are inventoried here; a new one fails the inventory until someone has looked at it.
// ---------------------------------------------------------------------------

describe('the other writers of system_config cannot reach CLAUDE_ROTATION_MODE', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const srcRoot = join(here, '..')

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
    return out
  }

  const WRITER_RE = /\b(setSystemConfig(?:Many|Sync)?|updateSystemConfig|insertSystemConfigIfAbsent|deleteSystemConfig)\s*\(|INTO system_config|UPDATE system_config|DELETE FROM system_config/
  const files = walk(srcRoot).map((p) => ({ rel: p.slice(srcRoot.length + 1), text: readFileSync(p, 'utf-8').replace(/\/\/.*$/gm, '') }))

  // file -> why it cannot write this key
  const REVIEWED: Record<string, string> = {
    'db/system-config.ts': 'the primitives and the boot migrators (source migrated_from_json, rejected by the reader)',
    'settings-store.ts': 'setOverride, called only from the gated settings route',
    // web/routes/settings.ts writes through setOverride (next test), not the primitives
    'web/schedule-inflight-store.ts': 'fixed key',
    'web/model-fallback-store.ts': 'fixed keys',
    'web/boot-marker.ts': 'fixed keys',
    'web/schedule-runner.ts': 'fixed key',
    'web/agent-desired-state.ts': 'fixed key',
    'web/rbac-mode.ts': 'fixed key',
    'web/terminal-input-store.ts': 'fixed key',
    'db/federation.ts': 'fixed key',
    'db/index.ts': 'boot restore of the schedule tick stamp, fixed key',
  }

  it('the set of files that write system_config is exactly the reviewed one', () => {
    const writers = files.filter((f) => WRITER_RE.test(f.text)).map((f) => f.rel).sort()
    expect(writers).toEqual(Object.keys(REVIEWED).sort())
  })

  it('setOverride (the one writer that takes a caller-chosen key) is called only from the settings route', () => {
    const callers = files.filter((f) => /\bsetOverride\s*\(/.test(f.text) && f.rel !== 'settings-store.ts').map((f) => f.rel)
    expect(callers).toEqual(['web/routes/settings.ts'])
  })

  it('no reviewed fixed-key writer names the rotation mode key, and none takes its key from a variable', () => {
    for (const f of files) {
      if (!(f.rel in REVIEWED)) continue
      if (['db/system-config.ts', 'settings-store.ts', 'web/routes/settings.ts'].includes(f.rel)) continue
      expect(f.text, f.rel).not.toMatch(/CLAUDE_ROTATION_MODE|ROTATION_MODE_KEY/)
      // first argument of every writer call is a named constant or a string literal, never an expression of input
      for (const m of f.text.matchAll(/\b(?:setSystemConfig(?:Many|Sync)?|updateSystemConfig|insertSystemConfigIfAbsent|deleteSystemConfig)\s*\(\s*([^,)\n]+)/g)) {
        const first = m[1]!.trim()
        if (first.startsWith('[') || first.startsWith('entries')) continue // Many: pairs built from constants, checked above
        expect(first, `${f.rel}: ${first}`).toMatch(/^(?:'[a-z_]+'|[A-Z][A-Z0-9_]*)$/)
      }
    }
  })

  it('a hostile config-overrides.json carrying act is migrated as migrated_from_json and reads as observe, journal or not', async () => {
    const overrides = join(flags.storeDir, 'config-overrides.json')
    writeFileSync(overrides, JSON.stringify({ [ROTATION_MODE_KEY]: 'act' }))
    try {
      initDatabase(':memory:') // runs the boot migration against the throwaway store
      expect(getSystemConfig(ROTATION_MODE_KEY)).toMatchObject({ value: 'act', source: 'migrated_from_json' })
      expect(await readRotationMode()).toMatchObject({ mode: 'observe', reason: 'not_db_source' })
      await logConfigChange(ROTATION_MODE_KEY, null, 'act', 'owner') // even a matching journal row
      expect(await readRotationMode()).toMatchObject({ mode: 'observe', reason: 'not_db_source' })
    } finally {
      unlinkSync(overrides)
    }
  })

  it('key spellings that are not exactly the registry key reach no row (404)', async () => {
    for (const key of ['claude_rotation_mode', ' CLAUDE_ROTATION_MODE', 'CLAUDE_ROTATION_MODE ', 'CLAUDE_ROTATION_MODE​', 'CLAUDE_ROTATION_MODE/../x']) {
      const r = await call(sessionCaller(cookies['owner']!), 'POST', { key, value: 'act' })
      expect(r.status, JSON.stringify(key)).toBe(404)
    }
    expect(getSystemConfig(ROTATION_MODE_KEY)).toBeUndefined()
  })
})

describe('an isolated instance (MARVEEN_STORE_DIR) applies observe whatever is stored', () => {
  // A verify copy of the live data can carry a confirmed act (source db + matching journal row), while the tmux
  // session name of the main agent is the same on the whole machine: act there would restart the REAL session.
  it('a confirmed act reads as observe, and the reason names the instance', async () => {
    await post(sessionCaller(cookies['owner']!), 'act')
    flags.isolated = true
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'act', reason: 'isolated_instance' })
  })

  it('a confirmed off stays off, with no reason: the clamp only lowers, nothing was clamped', async () => {
    await post(sessionCaller(cookies['owner']!), 'off')
    flags.isolated = true
    expect(await readRotationMode()).toEqual({ mode: 'off', stored: 'off', reason: null })
  })

  it('observe and no row need no explanation', async () => {
    flags.isolated = true
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: null, reason: null })
    await setSystemConfig(ROTATION_MODE_KEY, 'observe', 'db')
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'observe', reason: null })
  })

  it('an untrusted act keeps its own, more specific reason', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db') // no journal row
    flags.isolated = true
    expect(await readRotationMode()).toEqual({ mode: 'observe', stored: 'act', reason: 'unlogged_value' })
  })

  it('the same confirmed act on a non-isolated process is act (the control)', async () => {
    await post(sessionCaller(cookies['owner']!), 'act')
    flags.isolated = false
    expect(await readRotationMode()).toEqual({ mode: 'act', stored: 'act', reason: null })
  })

  it('GET /api/settings shows applied observe, stored act and the reason', async () => {
    await post(sessionCaller(cookies['owner']!), 'act')
    flags.isolated = true
    expect(await rotationRow()).toMatchObject({ value: 'observe', stored: 'act', reason: 'isolated_instance' })
  })

  it('the monitor, fed by the real reader, never calls apply or restarts anything: stored act + isolated', async () => {
    await post(sessionCaller(cookies['owner']!), 'act')
    flags.isolated = true
    const now = Date.now()
    const resets = Math.floor(now / 1000) + 2 * 3600
    const spent = { snapshot: { kind: 'snapshot' as const, ageSec: 5, windows: { five_hour: { usedPercent: 100, resetsAt: resets }, seven_day: { usedPercent: 40, resetsAt: resets + 86400 } } }, detail: 'ok' as const, writtenAt: Math.floor(now / 1000) }
    const fresh = { snapshot: { kind: 'snapshot' as const, ageSec: 5, windows: { five_hour: { usedPercent: 5, resetsAt: resets }, seven_day: { usedPercent: 5, resetsAt: resets + 86400 } } }, detail: 'ok' as const, writtenAt: Math.floor(now / 1000) }
    let state = { activePlanByAgent: { 'agent-a': 'plan-a' }, plans: {} } as import('../web/claude-plans-state.js').ClaudePlansState
    const apply = vi.fn()
    const notify = vi.fn(() => Promise.resolve(true))
    const plan = (id: string) => ({ id, label: id, configDir: `/cfg/${id}`, planType: 'personal' as const, channelsAllowed: true })
    const monitor = createPlanRotationMonitor({
      now: () => now,
      mainAgentId: 'agent-a',
      readMode: readRotationMode,
      isEnabled: () => true,
      readPlans: () => [plan('plan-a'), plan('plan-b')],
      readSnapshot: (p) => (p.id === 'plan-a' ? spent : fresh),
      readState: () => state,
      writeState: (s) => { state = s },
      apply,
      notify,
    })
    expect((await monitor.tick()).outcome).toBe('would-rotate')
    expect(apply).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    // the control: the same set-up on a non-isolated process rotates
    flags.isolated = false
    apply.mockResolvedValue({ ok: true, agentId: 'agent-a', activePlanId: 'plan-b' })
    expect((await monitor.tick()).outcome).toBe('rotated')
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

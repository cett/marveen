// GET /api/claude-plans/state -> monitor.live: the dashboard view of the plan-rotation monitor.
//
// Two contracts:
//   1. WHITELIST: the response carries plan ids and labels, percentages, reset times, the classification,
//      counters, the applied mode and the S4 class and position, and NOTHING else. A config dir, its hash, a
//      token, a key path or pane text must not appear, neither as a key nor as a value. The monitor is run
//      for real here, on fixtures that carry canary values, and the WHOLE response is searched.
//   2. WHO MAY READ: admin only (fleet infrastructure, not tenant data). Every other role, a device key, a
//      federation peer and an anonymous caller are refused, for both path spellings, and the permission is an
//      explicit table entry, not the unmapped-path fallback.
//
// Neutral fixture names only (plan-a, plan-b, agent-a).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const flags = vi.hoisted(() => ({ isolated: false, storeDir: '' }))

// one throwaway store for both mocks: the vault (paths.ts) and the config read the same directory
const shared = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('node:fs')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  const store = join(mkdtempSync(join(tmpdir(), 'plan-rotation-live-test-')), 'store') as string
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
    MAIN_AGENT_ID: 'agent-a',
    get IS_ISOLATED_MODE() {
      return flags.isolated
    },
  }
})
vi.mock('../web/agent-process-session.js', () => ({ capturePane: () => null }))

import { initDatabase, setSystemConfig } from '../db.js'
import { tryHandleClaudePlans } from '../web/routes/claude-plans.js'
import { CLAUDE_PLANS_PATH } from '../web/claude-plans.js'
import { configDirHash } from '../web/plan-config-hash.js'
import { ROTATION_MODE_KEY } from '../web/plan-rotation-mode.js'
import {
  getPlanRotationLive,
  startPlanRotationMonitor,
  stopPlanRotationMonitor,
  createPlanRotationMonitor,
  type MonitorDeps,
} from '../web/plan-rotation-monitor.js'
import { checkPermission } from '../web/authz.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import type { AuthResult } from '../web/auth-gate.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'
import { logger } from '../logger.js'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────
const DIR_A = '/home/user-x/DIRCANARY-plan-a/.claude'
const DIR_B = '/home/user-x/DIRCANARY-plan-b/.claude'
const PANE_CANARY = 'PANECANARY-user-wrote-this-and-429-appears'
const TOKEN_CANARY = 'TOKENCANARY-0123456789abcdef'
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const RESETS = Math.floor(NOW / 1000) + 2 * 3600

const plan = (id: string, configDir: string) => ({ id, label: `Label ${id}`, configDir, planType: 'personal' as const, channelsAllowed: true })
const snapRead = (five: number, seven: number) => ({
  snapshot: {
    kind: 'snapshot' as const,
    ageSec: 5,
    windows: { five_hour: { usedPercent: five, resetsAt: RESETS }, seven_day: { usedPercent: seven, resetsAt: RESETS + 3 * 86400 } },
  },
  detail: 'ok' as const,
  writtenAt: Math.floor(NOW / 1000),
})

function runningMonitorDeps(over: Partial<MonitorDeps> = {}): MonitorDeps {
  let state = { activePlanByAgent: { 'agent-a': 'plan-a' }, plans: {} } as ClaudePlansState
  return {
    now: () => NOW,
    mainAgentId: 'agent-a',
    readMode: () => Promise.resolve({ mode: 'observe' as const, stored: 'observe', reason: null }),
    isEnabled: () => true,
    readPlans: () => [plan('plan-a', DIR_A), plan('plan-b', DIR_B)],
    readSnapshot: (p) => (p.id === 'plan-a' ? snapRead(100, 40) : snapRead(10, 10)),
    readState: () => state,
    writeState: (s) => { state = s },
    apply: vi.fn(),
    notify: vi.fn(() => Promise.resolve(true)),
    capturePane: () => `${TOKEN_CANARY} ${PANE_CANARY}\n>`,
    ...over,
  }
}

function getState(): Promise<{ status: number; body: any; raw: string }> {
  const out = { status: 0, body: null as any, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const req: any = { method: 'GET', url: '/api/claude-plans/state', headers: {}, on() { return req } }
  const ctx: any = { req, res, path: '/api/claude-plans/state', method: 'GET', url: new URL('http://localhost:3420/api/claude-plans/state'), url_: undefined }
  return tryHandleClaudePlans(ctx).then(() => out)
}

beforeEach(() => {
  flags.isolated = false
  initDatabase(':memory:')
  mkdirSync(join(flags.storeDir), { recursive: true })
  writeFileSync(CLAUDE_PLANS_PATH, JSON.stringify([plan('plan-a', DIR_A), plan('plan-b', DIR_B)]))
})

afterEach(() => {
  stopPlanRotationMonitor()
  vi.restoreAllMocks()
})

/** Every key, at any depth. */
function allKeys(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc))
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { acc.push(k); allKeys(x, acc) }
  }
  return acc
}

// ── 1. the whitelist ──────────────────────────────────────────────────────────────────────────────────────────
describe('monitor.live is a whitelist', () => {
  it('exact shape of a running monitor after one tick (every field is listed on purpose)', async () => {
    const monitor = createPlanRotationMonitor(runningMonitorDeps())
    expect((await monitor.tick()).outcome).toBe('would-rotate')
    expect(monitor.live()).toEqual({
      lastTick: { at: NOW, outcome: 'would-rotate' },
      activePlan: { id: 'plan-a', label: 'Label plan-a', measuredAt: NOW },
      health: {
        status: 'exhausted',
        reason: 'exhausted:five_hour:100%',
        sticky: false,
        windows: { five_hour: { usedPercent: 100, resetsAt: RESETS }, seven_day: { usedPercent: 40, resetsAt: RESETS + 3 * 86400 } },
      },
      candidates: [{ id: 'plan-b', label: 'Label plan-b', freeFivePct: 90, freeSevenDayPct: 90, exhausted: false }],
      unknownTicks: 0,
      pendingFresh: null,
      s4: { at: NOW, pattern: 'quota_exceeded', line: -2, corroborated: true },
    })
  })

  it('the whole HTTP response holds no config dir, no hash, no token, no pane text, no such key', async () => {
    vi.useFakeTimers()
    startPlanRotationMonitor(runningMonitorDeps())
    await vi.advanceTimersByTimeAsync(60_000) // one tick
    vi.useRealTimers()

    const { status, body, raw } = await getState()
    expect(status).toBe(200)
    expect(body.monitor.live.running).toBe(true)
    expect(body.monitor.live.activePlan).toMatchObject({ id: 'plan-a' })
    expect(body.monitor.live.s4).toMatchObject({ pattern: 'quota_exceeded', corroborated: true })

    // no VALUE: the dirs, their canonical forms, the 8-hex snapshot ids, the token and the pane line
    const forbiddenValues = ['DIRCANARY', DIR_A, DIR_B, TOKEN_CANARY, 'TOKENCANARY', PANE_CANARY, 'PANECANARY', 'user-wrote']
    for (const dir of [DIR_A, DIR_B]) {
      const h = configDirHash(dir)
      expect(h).not.toBeNull()
      forbiddenValues.push(h!)
    }
    for (const v of forbiddenValues) expect(raw).not.toContain(v)

    // no KEY of that kind at any depth
    const bad = allKeys(body).filter((k) => /config|dir|hash|token|secret|credential|passw|api_?key|keychain|path|pane|raw/i.test(k))
    expect(bad).toEqual([])
  })

  it('unknownTicks counts the consecutive ticks the active plan could not be measured', async () => {
    const deps = runningMonitorDeps({ readSnapshot: () => ({ snapshot: { kind: 'missing' as const }, detail: 'no-file' as const, writtenAt: null }) })
    const monitor = createPlanRotationMonitor(deps)
    await monitor.tick()
    expect(monitor.live().unknownTicks).toBe(1)
    await monitor.tick()
    await monitor.tick()
    expect(monitor.live().unknownTicks).toBe(3)
    expect(monitor.live().health).toMatchObject({ status: 'unknown', reason: 'snapshot-missing' })
  })

  it('pendingFresh shows the plan that must produce a new measurement, and flips to blocked after 10 minutes', async () => {
    let t = NOW
    let state = { activePlanByAgent: { 'agent-a': 'plan-a' }, plans: {} } as ClaudePlansState
    const deps = runningMonitorDeps({
      now: () => t,
      readMode: () => Promise.resolve({ mode: 'act' as const, stored: 'act', reason: null }),
      readState: () => state,
      writeState: (s) => { state = s },
      // plan-b's file is older than the switch and never refreshes
      readSnapshot: (p) => (p.id === 'plan-a' ? snapRead(100, 40) : { ...snapRead(10, 10), writtenAt: Math.floor(NOW / 1000) - 3600 }),
      apply: vi.fn((input: { agentId: string; targetPlanId: string }) => {
        state = { ...state, activePlanByAgent: { ...state.activePlanByAgent, [input.agentId]: input.targetPlanId } }
        return Promise.resolve({ ok: true as const, agentId: input.agentId, activePlanId: input.targetPlanId })
      }),
    })
    const monitor = createPlanRotationMonitor(deps)
    expect((await monitor.tick()).outcome).toBe('rotated')
    expect(monitor.live().pendingFresh).toEqual({ planId: 'plan-b', since: NOW, blocked: false })
    t += 11 * 60_000
    await monitor.tick()
    expect(monitor.live().pendingFresh).toEqual({ planId: 'plan-b', since: NOW, blocked: true })
  })

  it('the key set of the live block is exactly the listed one', async () => {
    const monitor = createPlanRotationMonitor(runningMonitorDeps())
    await monitor.tick()
    expect(Object.keys(monitor.live()).sort()).toEqual(['activePlan', 'candidates', 'health', 'lastTick', 'pendingFresh', 's4', 'unknownTicks'])
    const live = monitor.live()
    expect(Object.keys(live.activePlan!).sort()).toEqual(['id', 'label', 'measuredAt'])
    expect(Object.keys(live.health!).sort()).toEqual(['reason', 'status', 'sticky', 'windows'])
    expect(Object.keys(live.candidates[0]!).sort()).toEqual(['exhausted', 'freeFivePct', 'freeSevenDayPct', 'id', 'label'])
    expect(Object.keys(live.s4!).sort()).toEqual(['at', 'corroborated', 'line', 'pattern'])
  })
})

// ── mode block ────────────────────────────────────────────────────────────────────────────────────────────────
describe('monitor.live.mode: applied, stored, reason', () => {
  it('no monitor running (WEB_ONLY, isolated, stopped): running=false, empty measurements, the mode still shown', async () => {
    const live = await getPlanRotationLive()
    expect(live).toEqual({
      running: false,
      mode: { applied: 'observe', stored: null, reason: null },
      lastTick: null,
      activePlan: null,
      health: null,
      candidates: [],
      unknownTicks: 0,
      pendingFresh: null,
      s4: null,
    })
  })

  it('an act row nobody confirmed: applied observe, stored act, the reason says why', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db') // no journal row
    expect((await getPlanRotationLive()).mode).toEqual({ applied: 'observe', stored: 'act', reason: 'unlogged_value' })
  })

  it('a stored value that is not one of the three is shown as "invalid", never as itself', async () => {
    await setSystemConfig(ROTATION_MODE_KEY, TOKEN_CANARY, 'db')
    const { body, raw } = await getState()
    expect(body.monitor.live.mode).toEqual({ applied: 'observe', stored: 'invalid', reason: 'invalid_value' })
    expect(raw).not.toContain('TOKENCANARY')
  })

  it('an isolated instance with a stored act: applied observe, reason isolated_instance', async () => {
    // the confirmation (source db + journal row) is what the settings route writes; here it is written the same way
    const { logConfigChange } = await import('../db.js')
    await setSystemConfig(ROTATION_MODE_KEY, 'act', 'db')
    await logConfigChange(ROTATION_MODE_KEY, null, 'act', 'user:owner')
    flags.isolated = true
    expect((await getPlanRotationLive()).mode).toEqual({ applied: 'observe', stored: 'act', reason: 'isolated_instance' })
    flags.isolated = false
    expect((await getPlanRotationLive()).mode).toEqual({ applied: 'act', stored: 'act', reason: null })
  })

  it('a broken live view never takes the endpoint down', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    let reads = 0
    // readPlans works for the tick, then throws when the view asks for the labels
    startPlanRotationMonitor(runningMonitorDeps({
      readPlans: () => { if (++reads > 4) throw new Error('registry unreadable'); return [plan('plan-a', DIR_A), plan('plan-b', DIR_B)] },
    }))
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    reads = 100
    const live = await getPlanRotationLive()
    expect(live.running).toBe(true)
    expect(live.mode.applied).toBe('observe')
    expect(live.activePlan).toBeNull()
    expect(warn.mock.calls.some((c) => String(c[1]).includes('live view failed'))).toBe(true)
  })
})

// ── 2. who may read ───────────────────────────────────────────────────────────────────────────────────────────
describe('who may read GET /api/claude-plans/state', () => {
  const PATHS = ['/api/claude-plans/state', '/api/v1/claude-plans/state']
  const callers: Array<[string, AuthResult, boolean]> = [
    ['dashboard token (admin)', { kind: 'token' }, true],
    ['token with role admin', { kind: 'token', role: 'admin' }, true],
    ['session admin', { kind: 'session', user: 'user-a', role: 'admin' }, true],
    ['token with role agent (tenant user)', { kind: 'token', role: 'agent' }, false],
    ['session agent (tenant user)', { kind: 'session', user: 'user-a', role: 'agent', tenantId: 'tenant-a' }, false],
    ['session read_only', { kind: 'session', user: 'user-a', role: 'read_only' }, false],
    ['session viewer', { kind: 'session', user: 'user-a', role: 'viewer' }, false],
    ['session without a role (unenrolled)', { kind: 'session', user: 'user-a' }, false],
    ['fleet agent token', { kind: 'token', role: 'fleet_agent', agentId: 'agent-a' }, false],
    ['device key', { kind: 'device', device: 'agent-a', deviceId: 1 }, false],
    ['federation peer', { kind: 'federation', peer: 'peer-x' }, false],
  ]

  for (const path of PATHS) {
    for (const [name, auth, allowed] of callers) {
      it(`${path}: ${name} -> ${allowed ? 'allowed' : '403'}`, () => {
        const d = checkPermission(auth, 'GET', path)
        expect(d.allowed).toBe(allowed)
        if (!d.allowed) expect(d.status).toBe(403)
      })
    }
    it(`${path}: an anonymous caller is 401`, () => {
      const d = checkPermission({ kind: 'none' }, 'GET', path)
      expect(d).toMatchObject({ allowed: false, status: 401 })
    })
  }

  it('the permission is an EXPLICIT table entry (admin:all), not the unmapped-path fallback', () => {
    // The role cells above cannot tell the two apart (the fallback is admin:all too); this one can: a later
    // broad /api/* entry would take over an unlisted path, and not a listed one.
    expect(resolveRequiredPermission('GET', '/api/claude-plans/state')).toBe('admin:all')
    expect(resolveRequiredPermission('GET', '/api/v1/claude-plans/state')).toBe('admin:all')
  })

  it('the write side next to it stays admin only: rotate and the registry', () => {
    const tenantUser: AuthResult = { kind: 'session', user: 'user-a', role: 'agent', tenantId: 'tenant-a' }
    for (const [m, p] of [['POST', '/api/claude-plans/rotate'], ['GET', '/api/claude-plans'], ['POST', '/api/claude-plans'], ['DELETE', '/api/claude-plans/plan-a']] as const) {
      expect(checkPermission(tenantUser, m, p)).toMatchObject({ allowed: false, status: 403 })
      expect(checkPermission({ kind: 'token' }, m, p).allowed).toBe(true)
    }
  })
})

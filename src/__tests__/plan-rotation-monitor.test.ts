// The backend plan-rotation monitor, driven through its injected dependencies: a fake clock, fake snapshot
// files, a fake apply and a fake notice channel. No agent session exists anywhere in this file: that is the
// point of the independence cells (a frozen main session, a snapshot that stopped changing, and the rotation
// still runs).
//
// Neutral fixture names only (plan-a, plan-b, agent-a).

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-a',
}))

import {
  createPlanRotationMonitor,
  FRESH_AFTER_SWITCH_MS,
  NOTIFY_TIMEOUT_MS,
  UNKNOWN_ALERT_TICKS,
  type MonitorDeps,
} from '../web/plan-rotation-monitor.js'
import type { ClaudePlansState, RotationLogEntry } from '../web/claude-plans-state.js'
import type { PlanSnapshotRead } from '../web/plan-usage-source.js'
import type { RotationApplyResult } from '../web/plan-rotation-apply.js'
import type { RotationMode } from '../web/plan-rotation-mode.js'

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0)
const MIN = 60_000
const AGENT = 'agent-a'

const plan = (id: string) => ({ id, label: id, configDir: `/cfg/${id}`, planType: 'personal' as const, channelsAllowed: true })

function snap(
  pct: { five?: number; seven?: number },
  opts: { ageSec?: number; writtenAtMs?: number; nowMs: number },
): PlanSnapshotRead {
  const resets = Math.floor(opts.nowMs / 1000) + 2 * 3600
  const windows: Record<string, { usedPercent: number; resetsAt: number }> = {}
  if (pct.five !== undefined) windows['five_hour'] = { usedPercent: pct.five, resetsAt: resets }
  if (pct.seven !== undefined) windows['seven_day'] = { usedPercent: pct.seven, resetsAt: resets + 3 * 86400 }
  return {
    snapshot: { kind: 'snapshot', ageSec: opts.ageSec ?? 5, windows },
    detail: 'ok',
    writtenAt: Math.floor((opts.writtenAtMs ?? opts.nowMs) / 1000),
  }
}

function rotated(ageMin: number, over: Partial<RotationLogEntry> = {}): RotationLogEntry {
  return { ts: T0 - ageMin * MIN, agentId: AGENT, from: 'plan-a', to: 'plan-b', trigger: 'soft', mode: 'act', result: 'rotated', source: 'monitor', ...over }
}

function harness(init: { mode?: RotationMode; log?: RotationLogEntry[]; monitor?: ClaudePlansState['monitor']; active?: string } = {}) {
  const h = {
    t: T0,
    mode: (init.mode ?? 'act') as RotationMode,
    enabled: true,
    plans: [plan('plan-a'), plan('plan-b')],
    // per plan: a function of the clock, so a test can age a snapshot
    snaps: {
      'plan-a': (now: number) => snap({ five: 92, seven: 40 }, { nowMs: now }),
      'plan-b': (now: number) => snap({ five: 10, seven: 10 }, { nowMs: now }),
    } as Record<string, (now: number) => PlanSnapshotRead>,
    state: {
      activePlanByAgent: { [AGENT]: init.active ?? 'plan-a' },
      plans: {},
      monitor: { ...(init.log ? { rotationLog: init.log } : {}), ...init.monitor },
    } as ClaudePlansState,
    writes: 0,
    snapReads: 0,
    events: [] as string[],
    notices: [] as string[],
    applyResult: { ok: true, agentId: AGENT, activePlanId: 'plan-b' } as RotationApplyResult,
    onNotify: undefined as undefined | ((msg: string) => void | Promise<boolean>),
  }
  const apply = vi.fn((input: { agentId: string; targetPlanId: string }): Promise<RotationApplyResult> => {
    h.events.push('apply')
    // performRotation writes the new pointer BEFORE the restart; a failed restart leaves it written. A refusal
    // (400/404/409) happens before anything is written.
    if (h.applyResult.ok || h.applyResult.status === 500) {
      h.state = { ...h.state, activePlanByAgent: { ...h.state.activePlanByAgent, [input.agentId]: input.targetPlanId } }
    }
    return Promise.resolve(
      h.applyResult.ok ? { ok: true as const, agentId: input.agentId, activePlanId: input.targetPlanId } : h.applyResult,
    )
  })
  const deps: MonitorDeps = {
    now: () => h.t,
    mainAgentId: AGENT,
    readMode: () => Promise.resolve({ mode: h.mode, stored: h.mode, reason: null }),
    isEnabled: () => h.enabled,
    readPlans: () => h.plans,
    readSnapshot: (p, _s) => {
      h.snapReads++
      return h.snaps[p.id]!(h.t)
    },
    readState: () => h.state,
    writeState: (s) => { h.writes++; h.state = s },
    apply,
    notify: async (msg) => {
      h.events.push(`notify:${msg.startsWith('🔄') ? 'before' : msg.startsWith('✅') ? 'after' : 'other'}`)
      h.notices.push(msg)
      const r = h.onNotify?.(msg)
      return r instanceof Promise ? r : true
    },
  }
  const monitor = createPlanRotationMonitor(deps)
  return { h, apply, monitor, tick: () => monitor.tick() }
}

const log = (h: { state: ClaudePlansState }) => h.state.monitor?.rotationLog ?? []
const exhaustedA = (now: number) => snap({ five: 100, seven: 40 }, { nowMs: now })

afterEach(() => { vi.useRealTimers() })

describe('mode', () => {
  it('off: the monitor does not even measure or write', async () => {
    const { h, tick, apply } = harness({ mode: 'off' })
    expect((await tick()).outcome).toBe('off')
    expect(h.snapReads).toBe(0)
    expect(h.writes).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('the mode is read on EVERY tick: a switch takes effect on the next one', async () => {
    const { h, tick, apply } = harness({ mode: 'observe' })
    h.snaps['plan-a'] = exhaustedA
    expect((await tick()).outcome).toBe('would-rotate')
    expect(apply).not.toHaveBeenCalled()
    h.mode = 'act'
    expect((await tick()).outcome).toBe('rotated')
    h.mode = 'off'
    expect((await tick()).outcome).toBe('off')
  })

  it('observe never calls apply, never notifies, and logs the would-rotate once, not every tick', async () => {
    const { h, tick, apply } = harness({ mode: 'observe' })
    h.snaps['plan-a'] = exhaustedA
    for (let i = 0; i < 5; i++) { h.t += MIN; await tick() }
    expect(apply).not.toHaveBeenCalled()
    expect(h.notices).toEqual([])
    expect(log(h)).toHaveLength(1)
    expect(log(h)[0]).toMatchObject({ mode: 'observe', result: 'would-rotate', from: 'plan-a', to: 'plan-b', source: 'monitor' })
    expect(h.state.activePlanByAgent[AGENT]).toBe('plan-a')
  })

  it('observe keeps the telemetry fresh: lastTickAt and the health record', async () => {
    const { h, tick } = harness({ mode: 'observe' })
    await tick()
    expect(h.state.monitor?.lastTickAt).toBe(T0)
    expect(h.state.monitor?.health?.['plan-a']).toMatchObject({ status: 'pressure', window: 'five_hour', usedPercent: 92 })
  })

  it('act with CLAUDE_ROTATION_ENABLED off: refused, no notice, no apply, logged once', async () => {
    const { h, tick, apply } = harness({ mode: 'act' })
    h.enabled = false
    h.snaps['plan-a'] = exhaustedA
    for (let i = 0; i < 3; i++) { h.t += MIN; expect((await tick()).outcome).toBe('refused') }
    expect(apply).not.toHaveBeenCalled()
    expect(h.notices).toEqual([])
    expect(log(h)).toHaveLength(1)
  })
})

describe('inactive', () => {
  it('no active plan for the main agent: a tick stamp only', async () => {
    const { h, tick } = harness()
    h.state = { activePlanByAgent: {}, plans: {} }
    expect((await tick()).outcome).toBe('inactive')
    expect(h.state.monitor?.lastTickAt).toBe(T0)
    expect(h.snapReads).toBe(0)
  })
  it('fewer than two plans: inactive', async () => {
    const { h, tick } = harness()
    h.plans = [plan('plan-a')]
    expect((await tick()).outcome).toBe('inactive')
  })
})

describe('act: the rotation', () => {
  it('hard (exhausted): notice BEFORE, then apply, then notice AFTER, in that order', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    expect((await tick()).outcome).toBe('rotated')
    expect(h.events).toEqual(['notify:before', 'apply', 'notify:after'])
    expect(apply).toHaveBeenCalledWith({ agentId: AGENT, targetPlanId: 'plan-b' })
    expect(log(h)[0]).toMatchObject({ mode: 'act', result: 'rotated', trigger: 'hard', source: 'monitor', window: 'five_hour' })
  })

  it('soft (pressure) needs two consecutive ticks', async () => {
    const { h, tick, apply } = harness()
    expect((await tick()).outcome).toBe('wait-debounce')
    expect(apply).not.toHaveBeenCalled()
    h.t += MIN
    expect((await tick()).outcome).toBe('rotated')
    expect(log(h)[0]).toMatchObject({ trigger: 'soft' })
  })

  it('pressure, healthy, pressure is not two consecutive ticks', async () => {
    const { h, tick, apply } = harness()
    expect((await tick()).outcome).toBe('wait-debounce')
    h.snaps['plan-a'] = (now) => snap({ five: 10, seven: 10 }, { nowMs: now })
    h.t += MIN
    expect((await tick()).outcome).toBe('no-pressure')
    h.snaps['plan-a'] = (now) => snap({ five: 92, seven: 40 }, { nowMs: now })
    h.t += MIN
    expect((await tick()).outcome).toBe('wait-debounce')
    expect(apply).not.toHaveBeenCalled()
  })

  it('a stale snapshot that was already high is sticky pressure and still rotates: the frozen-session case', async () => {
    // INDEPENDENCE: there is no agent session in this harness. The main session is frozen on the spent plan, the
    // snapshot stopped changing three hours ago at 100%, nothing refreshes it, and the rotation still happens.
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = (now) => snap({ five: 100, seven: 40 }, { nowMs: now, ageSec: 3 * 3600 })
    expect((await tick()).outcome).toBe('rotated')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('a stale snapshot that was LOW is unknown: no blind rotation', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = (now) => snap({ five: 20, seven: 10 }, { nowMs: now, ageSec: 3 * 3600 })
    expect((await tick()).outcome).toBe('unknown')
    expect(apply).not.toHaveBeenCalled()
  })

  it('cooldown: a rotation 5 minutes ago holds a soft decision', async () => {
    const { h, tick, apply } = harness({ log: [rotated(5)] })
    await tick(); h.t += MIN
    expect((await tick()).outcome).toBe('wait-cooldown')
    expect(apply).not.toHaveBeenCalled()
  })

  it('cooldown bypass: a hard decision inside the cooldown goes once, labelled hard-bypass', async () => {
    const { h, tick } = harness({ log: [rotated(5)] })
    h.snaps['plan-a'] = exhaustedA
    expect((await tick()).outcome).toBe('rotated')
    expect(log(h)[log(h).length - 1]).toMatchObject({ trigger: 'hard-bypass' })
  })

  it('an unreadable candidate (malformed window) is never a target', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.snaps['plan-b'] = (now) => ({ snapshot: { kind: 'snapshot', ageSec: 5, windows: { five_hour: { usedPercent: Number.NaN, resetsAt: null } } }, detail: 'ok', writtenAt: now / 1000 })
    expect((await tick()).outcome).toBe('no-alternative')
    expect(apply).not.toHaveBeenCalled()
  })

  describe('a candidate with no snapshot file of its own falls back to the frozen record in the state', () => {
    const legacy = (usedPercent: number) => ({
      'plan-b': { observedAt: T0 - 60 * MIN, source: 'legacy', windows: { five_hour: { usedPercent, resetsAt: Math.floor(T0 / 1000) + 3600 }, seven_day: { usedPercent: 10, resetsAt: Math.floor(T0 / 1000) + 86400 } } },
    })
    const missing = () => ({ snapshot: { kind: 'missing' as const }, detail: 'no-file' as const, writtenAt: null })

    it('a spent frozen record: no alternative', async () => {
      const { h, tick, apply } = harness()
      h.snaps['plan-a'] = exhaustedA
      h.snaps['plan-b'] = missing
      h.state = { ...h.state, plans: legacy(100) }
      expect((await tick()).outcome).toBe('no-alternative')
      expect(apply).not.toHaveBeenCalled()
    })
    it('a roomy frozen record: eligible', async () => {
      const { h, tick } = harness()
      h.snaps['plan-a'] = exhaustedA
      h.snaps['plan-b'] = missing
      h.state = { ...h.state, plans: legacy(10) }
      expect((await tick()).outcome).toBe('rotated')
    })
    it('the own snapshot wins over the frozen record', async () => {
      const { h, tick } = harness()
      h.snaps['plan-a'] = exhaustedA // plan-b own snapshot is roomy (10/10) by default
      h.state = { ...h.state, plans: legacy(100) }
      expect((await tick()).outcome).toBe('rotated')
    })
  })

  it('a plan that does not allow channels use is never a target, however roomy', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.plans = [plan('plan-a'), { ...plan('plan-b'), channelsAllowed: false }]
    expect((await tick()).outcome).toBe('no-alternative')
    expect(apply).not.toHaveBeenCalled()
  })

  it('no alternative: the owner is told once, not every tick', async () => {
    const { h, tick } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.snaps['plan-b'] = (now) => snap({ five: 100, seven: 100 }, { nowMs: now })
    for (let i = 0; i < 4; i++) { h.t += MIN; expect((await tick()).outcome).toBe('no-alternative') }
    expect(h.notices).toHaveLength(1)
  })
})

describe('act: failures and races', () => {
  it('a failed restart restores the pointer, logs failed, tells the owner, and the next tick waits (backoff)', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.applyResult = { ok: false, status: 500, error: 'internal_error', hint: 'launchctl boom' }
    expect((await tick()).outcome).toBe('failed')
    expect(h.state.activePlanByAgent[AGENT]).toBe('plan-a')
    expect(log(h)[0]).toMatchObject({ result: 'failed', mode: 'act' })
    expect(h.notices[h.notices.length - 1]).toContain('launchctl boom')
    h.t += MIN
    expect((await tick()).outcome).toBe('wait-backoff')
    expect(apply).toHaveBeenCalledTimes(1)
    h.t += 5 * MIN
    expect((await tick()).outcome).toBe('failed') // retried after the backoff
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('three failures in a row give up, and the owner is told once', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.applyResult = { ok: false, status: 500, error: 'internal_error', hint: 'boom' }
    for (let i = 0; i < 3; i++) { await tick(); h.t += 6 * MIN }
    const before = h.notices.length
    expect((await tick()).outcome).toBe('gave-up')
    expect((await tick()).outcome).toBe('gave-up')
    expect(apply).toHaveBeenCalledTimes(3)
    expect(h.notices.length - before).toBe(1)
  })

  it('a refusal from apply (not a restart failure) keeps the pointer and is logged once', async () => {
    const { h, tick } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.applyResult = { ok: false, status: 409, error: 'disabled', hint: 'off' }
    for (let i = 0; i < 3; i++) { h.t += MIN; expect((await tick()).outcome).toBe('refused') }
    expect(log(h)).toHaveLength(1)
    expect(log(h)[0]).toMatchObject({ result: 'refused' })
  })

  it('stale decision: the active plan changed while the notice was out, nothing is applied', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.onNotify = (msg) => {
      if (msg.startsWith('🔄')) h.state = { ...h.state, activePlanByAgent: { [AGENT]: 'plan-b' } }
    }
    expect((await tick()).outcome).toBe('stale-decision')
    expect(apply).not.toHaveBeenCalled()
    expect(h.notices[h.notices.length - 1]).toContain('lemondva')
  })

  it('stale decision: the target got spent while the notice was out', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.onNotify = (msg) => {
      if (msg.startsWith('🔄')) h.snaps['plan-b'] = (now) => snap({ five: 100, seven: 100 }, { nowMs: now })
    }
    expect((await tick()).outcome).toBe('stale-decision')
    expect(apply).not.toHaveBeenCalled()
  })

  it('a notice channel that throws does not stop the rotation', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.onNotify = () => { throw new Error('channel down') }
    expect((await tick()).outcome).toBe('rotated')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('a notice that never answers is given up on after the timeout and the rotation goes on', async () => {
    vi.useFakeTimers()
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    h.onNotify = () => new Promise<boolean>(() => {})
    const pending = tick()
    await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS - 1)
    expect(apply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(apply).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS)
    expect((await pending).outcome).toBe('rotated')
  })

  it('skip-if-running: a tick that starts while another is in flight is skipped', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    let release!: () => void
    apply.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, agentId: AGENT, activePlanId: 'plan-b' }) }))
    const first = tick()
    // let the first tick run up to its (held) apply
    for (let i = 0; i < 50 && release === undefined; i++) await Promise.resolve()
    expect(release).toBeDefined()
    expect((await tick()).outcome).toBe('skipped')
    release()
    expect((await first).outcome).toBe('rotated')
    expect((await tick()).outcome).not.toBe('skipped')
  })
})

describe('breaker', () => {
  const three = [rotated(100, { agentId: 'agent-x' }), rotated(200, { agentId: 'agent-y' }), rotated(300, { agentId: 'agent-z' })]

  it('the fourth decision trips it: persisted flag, ONE notice, then breaker-open without more notices', async () => {
    const { h, tick, apply } = harness({ log: three })
    h.snaps['plan-a'] = exhaustedA
    expect((await tick()).outcome).toBe('breaker-trip')
    expect(h.state.monitor?.breaker).toEqual({ tripped: true, since: T0 })
    expect(h.notices).toHaveLength(1)
    for (let i = 0; i < 3; i++) { h.t += MIN; expect((await tick()).outcome).toBe('breaker-open') }
    expect(h.notices).toHaveLength(1)
    expect(apply).not.toHaveBeenCalled()
  })

  it('a human reset (resetAt) lets the next decision through instead of tripping again', async () => {
    const { h, tick, apply } = harness({ log: three, monitor: { resetAt: T0 - MIN } })
    h.snaps['plan-a'] = exhaustedA
    expect((await tick()).outcome).toBe('rotated')
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('owner notices about measuring', () => {
  it('an active plan that cannot be measured for UNKNOWN_ALERT_TICKS ticks is reported once; recovery resets the count', async () => {
    const { h, tick } = harness({ monitor: { consecutiveUnknown: UNKNOWN_ALERT_TICKS - 2 } })
    h.snaps['plan-a'] = () => ({ snapshot: { kind: 'missing' }, detail: 'no-file', writtenAt: null })
    await tick()
    expect(h.notices).toEqual([])
    h.t += MIN; await tick()
    expect(h.notices).toHaveLength(1)
    h.t += MIN; await tick()
    expect(h.notices).toHaveLength(1)
    expect(h.state.monitor?.consecutiveUnknown).toBe(UNKNOWN_ALERT_TICKS + 1)
    h.snaps['plan-a'] = (now) => snap({ five: 10, seven: 10 }, { nowMs: now })
    h.t += MIN; await tick()
    expect(h.state.monitor?.consecutiveUnknown).toBe(0)
  })

  it('inside the ten minute window a missing fresh snapshot does not block yet', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    expect((await tick()).outcome).toBe('rotated') // active is now plan-b
    const switchedAt = h.t
    // the new plan is spent too, and its snapshot file has NOT been rewritten since the switch
    h.snaps['plan-b'] = (now) => snap({ five: 100, seven: 40 }, { nowMs: now, writtenAtMs: switchedAt - 30 * MIN })
    h.snaps['plan-a'] = (now) => snap({ five: 10, seven: 10 }, { nowMs: now })
    h.t = switchedAt + FRESH_AFTER_SWITCH_MS - MIN
    expect((await tick()).outcome).toBe('rotated') // inside the window: the hard-bypass is still allowed
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('blocked-no-fresh: ten minutes after a switch with no newer snapshot, one notice and act is blocked until one appears', async () => {
    const { h, tick, apply } = harness()
    h.snaps['plan-a'] = exhaustedA
    await tick() // rotated, active plan-b
    const switchedAt = h.t
    // plan-b: spent, stale file from before the switch; plan-a is a good candidate again
    h.snaps['plan-b'] = (now) => snap({ five: 100, seven: 40 }, { nowMs: now, writtenAtMs: switchedAt - 30 * MIN })
    h.snaps['plan-a'] = (now) => snap({ five: 10, seven: 10 }, { nowMs: now })
    // a hard-bypass was already used by the first rotation? No: the first was a plain hard, so one bypass remains.
    h.t = switchedAt + FRESH_AFTER_SWITCH_MS + MIN
    const noticesBefore = h.notices.length
    expect((await tick()).outcome).toBe('blocked-no-fresh')
    expect(h.notices.length - noticesBefore).toBe(1)
    expect(h.notices[h.notices.length - 1]).toContain('nincs friss mérés')
    h.t += MIN
    expect((await tick()).outcome).toBe('blocked-no-fresh')
    expect(h.notices.length - noticesBefore).toBe(1) // told once
    expect(apply).toHaveBeenCalledTimes(1)
    // a snapshot written after the switch appears: the block lifts and the pending decision goes through
    h.snaps['plan-b'] = (now) => snap({ five: 100, seven: 40 }, { nowMs: now, writtenAtMs: now, ageSec: 5 })
    h.t += MIN
    expect((await tick()).outcome).toBe('rotated')
  })
})

import { describe, it, expect } from 'vitest'
import { evaluateRotationGuard, nextSoftStreak, GUARD, type GuardInput } from '../claude-plan-rotation-guard.js'
import type { RotationLogEntry } from '../web/claude-plans-state.js'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const MIN = 60_000

// Neutral fixture names only.
const AGENT = 'agent-a'

function entry(over: Partial<RotationLogEntry> & { ageMs: number }): RotationLogEntry {
  const { ageMs, ...rest } = over
  return {
    ts: NOW - ageMs,
    agentId: AGENT,
    from: 'plan-a',
    to: 'plan-b',
    trigger: 'soft',
    mode: 'act',
    result: 'rotated',
    ...rest,
  }
}

function guard(over: Partial<GuardInput> = {}) {
  return evaluateRotationGuard({
    agentId: AGENT,
    urgency: 'soft',
    nowMs: NOW,
    softStreak: GUARD.SOFT_TICKS,
    log: [],
    breakerTripped: false,
    ...over,
  })
}

describe('debounce', () => {
  it('a soft decision on its first tick waits', () => {
    expect(guard({ softStreak: 1 })).toMatchObject({ verdict: 'wait-debounce' })
  })
  it('a soft decision on its second consecutive tick goes', () => {
    expect(guard({ softStreak: 2 })).toEqual({ verdict: 'go', trigger: 'soft' })
  })
  it('a hard decision goes on the first tick, whatever the streak', () => {
    expect(guard({ urgency: 'hard', softStreak: 0 })).toEqual({ verdict: 'go', trigger: 'hard' })
  })
  it('the streak resets on a tick that is not a soft decision', () => {
    expect(nextSoftStreak(1, true)).toBe(2)
    expect(nextSoftStreak(5, false)).toBe(0)
    // pressure, healthy, pressure is NOT two consecutive ticks
    expect(nextSoftStreak(nextSoftStreak(nextSoftStreak(0, true), false), true)).toBe(1)
  })
})

describe('cooldown', () => {
  it('waits inside the cooldown after a successful rotation', () => {
    const log = [entry({ ageMs: GUARD.COOLDOWN_MS - 1 })]
    expect(guard({ log })).toMatchObject({ verdict: 'wait-cooldown' })
  })
  it('goes exactly at the cooldown boundary', () => {
    const log = [entry({ ageMs: GUARD.COOLDOWN_MS })]
    expect(guard({ log })).toEqual({ verdict: 'go', trigger: 'soft' })
  })
  it('a hard decision inside the cooldown bypasses it ONCE (new plan already spent)', () => {
    const log = [entry({ ageMs: 5 * MIN, trigger: 'soft' })]
    expect(guard({ urgency: 'hard', log })).toEqual({ verdict: 'go', trigger: 'hard-bypass' })
  })
  it('after a bypass rotation a further hard decision waits out the cooldown', () => {
    const log = [entry({ ageMs: 5 * MIN, trigger: 'hard-bypass' })]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'wait-cooldown' })
  })
  it('a soft decision never bypasses the cooldown', () => {
    const log = [entry({ ageMs: 5 * MIN })]
    expect(guard({ urgency: 'soft', log })).toMatchObject({ verdict: 'wait-cooldown' })
  })
  it('the cooldown is per agent: another agent rotation does not hold this one', () => {
    const log = [entry({ ageMs: 5 * MIN, agentId: 'agent-b' })]
    expect(guard({ log })).toEqual({ verdict: 'go', trigger: 'soft' })
  })
  it('an observe-mode entry that claims rotated still starts no cooldown (damaged file)', () => {
    const log = [entry({ ageMs: 5 * MIN, mode: 'observe', result: 'rotated' })]
    expect(guard({ log })).toEqual({ verdict: 'go', trigger: 'soft' })
  })
  it('observe entries and failed entries do not start a cooldown', () => {
    const log = [
      entry({ ageMs: 5 * MIN, mode: 'observe', result: 'would-rotate' }),
      entry({ ageMs: 4 * MIN, result: 'refused' }),
    ]
    expect(guard({ log })).toEqual({ verdict: 'go', trigger: 'soft' })
  })
})

describe('breaker', () => {
  const rotations = (n: number, spacingMs = 100 * MIN) =>
    Array.from({ length: n }, (_, i) => entry({ ageMs: (n - i) * spacingMs, agentId: `agent-${i}` }))

  it('trips on the decision after BREAKER_MAX rotations inside the window', () => {
    // 3 rotations 100/200/300 minutes ago: outside every cooldown, inside 6 h
    expect(guard({ urgency: 'hard', log: rotations(3) })).toMatchObject({ verdict: 'breaker-trip' })
  })
  it('two rotations in the window do not trip it', () => {
    expect(guard({ urgency: 'hard', log: rotations(2) })).toMatchObject({ verdict: 'go' })
  })
  it('a rotation exactly at the window edge is outside the window', () => {
    const log = [
      entry({ ageMs: GUARD.BREAKER_WINDOW_MS, agentId: 'agent-x' }),
      entry({ ageMs: 200 * MIN, agentId: 'agent-y' }),
      entry({ ageMs: 100 * MIN, agentId: 'agent-z' }),
    ]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'go' })
  })
  it('counts the whole fleet, not one agent', () => {
    expect(guard({ agentId: 'agent-other', urgency: 'hard', log: rotations(3) })).toMatchObject({
      verdict: 'breaker-trip',
    })
  })
  it('observe-mode and failed entries do not count toward the breaker', () => {
    const log = [
      ...rotations(2),
      entry({ ageMs: 50 * MIN, mode: 'observe', result: 'would-rotate', agentId: 'agent-q' }),
      entry({ ageMs: 40 * MIN, result: 'failed', agentId: 'agent-r' }),
    ]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'go' })
  })
  it('an observe-mode entry never counts, even if its result says rotated (damaged file)', () => {
    const log = [
      ...rotations(2),
      entry({ ageMs: 50 * MIN, mode: 'observe', result: 'rotated', agentId: 'agent-q' }),
    ]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'go' })
  })
  it('a persisted tripped flag blocks everything and does not ask for a second alert', () => {
    expect(guard({ urgency: 'hard', breakerTripped: true })).toEqual({
      verdict: 'breaker-open',
      reason: 'breaker-tripped',
    })
  })
})

describe('restart backoff', () => {
  const failure = (ageMs: number) => entry({ ageMs, result: 'failed' })

  it('waits after a failed restart', () => {
    expect(guard({ urgency: 'hard', log: [failure(GUARD.RESTART_BACKOFF_MS - 1)] })).toMatchObject({
      verdict: 'wait-backoff',
    })
  })
  it('retries exactly at the backoff boundary', () => {
    expect(guard({ urgency: 'hard', log: [failure(GUARD.RESTART_BACKOFF_MS)] })).toMatchObject({ verdict: 'go' })
  })
  it('gives up after MAX_RESTART_FAILURES failures in a row', () => {
    const log = [failure(60 * MIN), failure(40 * MIN), failure(20 * MIN)]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'gave-up' })
  })
  it('two failures still retry once the backoff passed', () => {
    const log = [failure(60 * MIN), failure(40 * MIN)]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'go' })
  })
  it('a success resets the failure count', () => {
    const log = [
      failure(300 * MIN),
      failure(280 * MIN),
      failure(260 * MIN),
      entry({ ageMs: 240 * MIN }), // success after the three failures
    ]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'go' })
  })
  it('failures of another agent are not mine', () => {
    const log = [1, 2, 3].map((i) => entry({ ageMs: i * 20 * MIN, result: 'failed', agentId: 'agent-b' }))
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'go' })
  })
})

describe('human reset (resetAtMs)', () => {
  const rot = (ageMs: number, agentId: string) => entry({ ageMs, agentId })
  const three = [rot(300 * MIN, 'agent-x'), rot(200 * MIN, 'agent-y'), rot(100 * MIN, 'agent-z')]

  it('3 rotations trip the breaker; after a human reset the next decision does NOT trip', () => {
    expect(guard({ urgency: 'hard', log: three })).toMatchObject({ verdict: 'breaker-trip' })
    expect(guard({ urgency: 'hard', log: three, resetAtMs: NOW - 10 * MIN })).toEqual({ verdict: 'go', trigger: 'hard' })
  })
  it('rotations AFTER the reset count again: three new ones trip it once more', () => {
    const after = [rot(9 * MIN, 'agent-p'), rot(8 * MIN, 'agent-q'), rot(7 * MIN, 'agent-r')]
    expect(guard({ urgency: 'hard', log: [...three, ...after], resetAtMs: NOW - 10 * MIN })).toMatchObject({
      verdict: 'breaker-trip',
    })
  })
  it('an entry exactly at the reset instant is before it (not counted)', () => {
    // two rotations after the reset plus one AT it: only the two count, so no trip
    const log = [rot(10 * MIN, 'agent-x'), rot(9 * MIN, 'agent-y'), rot(8 * MIN, 'agent-z')]
    expect(guard({ urgency: 'hard', log, resetAtMs: NOW - 10 * MIN })).toMatchObject({ verdict: 'go' })
    // reset one millisecond earlier: the 10-minute entry is now after it, all three count
    expect(guard({ urgency: 'hard', log, resetAtMs: NOW - 10 * MIN - 1 })).toMatchObject({ verdict: 'breaker-trip' })
  })
  it('the gave-up after 3 failed restarts is lifted by a reset too', () => {
    const fails = [60, 40, 20].map((m) => entry({ ageMs: m * MIN, result: 'failed' }))
    expect(guard({ urgency: 'hard', log: fails })).toMatchObject({ verdict: 'gave-up' })
    expect(guard({ urgency: 'hard', log: fails, resetAtMs: NOW - 10 * MIN })).toEqual({ verdict: 'go', trigger: 'hard' })
  })
  it('the cooldown still sees entries from before the reset (a reset does not un-rotate)', () => {
    const log = [entry({ ageMs: 20 * MIN })]
    expect(guard({ urgency: 'soft', log, resetAtMs: NOW - 10 * MIN })).toMatchObject({ verdict: 'wait-cooldown' })
  })
  it('no reset recorded: nothing is forgotten', () => {
    expect(guard({ urgency: 'hard', log: three, resetAtMs: undefined })).toMatchObject({ verdict: 'breaker-trip' })
  })
})

describe('manual rotations (source manual)', () => {
  const manual = (ageMs: number, over: Partial<RotationLogEntry> = {}) =>
    entry({ ageMs, trigger: 'manual', source: 'manual', agentId: 'agent-m', ...over })

  it('manual rotations do not count toward the breaker (3 of them: no trip)', () => {
    const log = [manual(300 * MIN), manual(200 * MIN), manual(100 * MIN)]
    expect(guard({ urgency: 'hard', log })).toEqual({ verdict: 'go', trigger: 'hard' })
  })
  it('the monitor entries still count next to many manual ones: 2 monitor + 5 manual does not trip, 3 monitor does', () => {
    const mon = (ageMs: number, agentId: string) => entry({ ageMs, agentId })
    const manuals = [330, 320, 310, 150, 140].map((m) => manual(m * MIN))
    expect(guard({ urgency: 'hard', log: [...manuals, mon(300 * MIN, 'agent-x'), mon(200 * MIN, 'agent-y')] })).toMatchObject({ verdict: 'go' })
    expect(guard({ urgency: 'hard', log: [...manuals, mon(300 * MIN, 'agent-x'), mon(200 * MIN, 'agent-y'), mon(100 * MIN, 'agent-z')] })).toMatchObject({ verdict: 'breaker-trip' })
  })
  it('a manual rotation of this agent starts the cooldown', () => {
    expect(guard({ agentId: 'agent-m', urgency: 'soft', log: [manual(5 * MIN)] })).toMatchObject({ verdict: 'wait-cooldown' })
  })
  it('a hard decision may bypass the cooldown once after a manual rotation', () => {
    expect(guard({ agentId: 'agent-m', urgency: 'hard', log: [manual(5 * MIN)] })).toEqual({ verdict: 'go', trigger: 'hard-bypass' })
  })
  it('manual restart failures do not count toward the give-up or the backoff', () => {
    const fails = [60, 40, 20].map((m) => manual(m * MIN, { result: 'failed' }))
    expect(guard({ agentId: 'agent-m', urgency: 'hard', log: fails })).toEqual({ verdict: 'go', trigger: 'hard' })
    expect(guard({ agentId: 'agent-m', urgency: 'hard', log: [manual(1 * MIN, { result: 'failed' })] })).toMatchObject({ verdict: 'go' })
  })
  it('an entry with no source is the monitor (older files): it counts', () => {
    const log = [300, 200, 100].map((m) => entry({ ageMs: m * MIN, agentId: `agent-${m}` }))
    expect(log.every((e) => e.source === undefined)).toBe(true)
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'breaker-trip' })
  })
})

describe('restart failures expire', () => {
  const failure = (ageMs: number) => entry({ ageMs, result: 'failed' })

  it('the window is 6 hours (pinned as a literal, not read back from the constant)', () => {
    const H = 60 * MIN
    // three failures 7 hours old: expired; the same three 5 hours old: still a give-up
    expect(guard({ urgency: 'hard', log: [failure(7 * H + 3 * MIN), failure(7 * H + 2 * MIN), failure(7 * H + MIN)] })).toMatchObject({ verdict: 'go' })
    expect(guard({ urgency: 'hard', log: [failure(5 * H + 3 * MIN), failure(5 * H + 2 * MIN), failure(5 * H + MIN)] })).toMatchObject({ verdict: 'gave-up' })
  })
  it('three failures older than the window no longer give up', () => {
    const w = GUARD.RESTART_FAILURE_WINDOW_MS
    expect(guard({ urgency: 'hard', log: [failure(w + 3 * MIN), failure(w + 2 * MIN), failure(w + MIN)] })).toEqual({ verdict: 'go', trigger: 'hard' })
  })
  it('a failure exactly at the window edge is outside it', () => {
    const w = GUARD.RESTART_FAILURE_WINDOW_MS
    expect(guard({ urgency: 'hard', log: [failure(w), failure(w - 50 * MIN), failure(w - 60 * MIN)] })).toEqual({ verdict: 'go', trigger: 'hard' })
  })
  it('one millisecond inside the edge it still counts: three failures give up', () => {
    const w = GUARD.RESTART_FAILURE_WINDOW_MS
    expect(guard({ urgency: 'hard', log: [failure(w - 1), failure(w - 50 * MIN), failure(w - 60 * MIN)] })).toMatchObject({ verdict: 'gave-up' })
  })
  it('the window is the failures only: the old failure still does not block a retry', () => {
    const w = GUARD.RESTART_FAILURE_WINDOW_MS
    expect(guard({ urgency: 'hard', log: [failure(w + MIN)] })).toMatchObject({ verdict: 'go' })
  })
})

describe('precedence', () => {
  it('breaker beats cooldown bypass', () => {
    const log = [
      entry({ ageMs: 10 * MIN, agentId: 'agent-x' }),
      entry({ ageMs: 100 * MIN, agentId: 'agent-y' }),
      entry({ ageMs: 200 * MIN, agentId: 'agent-z' }),
    ]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'breaker-trip' })
  })
  it('backoff beats a hard decision', () => {
    const log = [entry({ ageMs: 1 * MIN, result: 'failed' })]
    expect(guard({ urgency: 'hard', log })).toMatchObject({ verdict: 'wait-backoff' })
  })
})

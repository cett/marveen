// Regression: the context-restart gate alerted "blocked for 6101 minutes" for an
// agent that was working normally.
//
// The block clock (firstBlockedAt) only ended on the gate's own /clear or a
// restart. When the context fell back under the threshold by any other road
// (auto-compact, a manual /clear or /compact), the clock stayed behind; days
// later the context climbed over the threshold again, the pane was mid-turn, and
// the first block of the new streak was measured from the old clock and became a
// persistent-block alert at once.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase } from '../db.js'
import {
  decideGate,
  resetStreakIfBelowThreshold,
  type GateConfig,
  type GateInputs,
} from '../context-restart-gate.js'
import { readGateRunState, writeGateRunState } from '../web/context-restart-gate-store.js'
import { reconcileStreakWithContext } from '../web/context-restart-gate-runner.js'

beforeAll(() => { initDatabase(':memory:') })

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const NOW = 1_800_000_000_000
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(performance.now() * 1000)}`

const CFG: GateConfig = {
  enabled: true,
  thresholdTokens: 400_000,
  retryIntervalMs: 60_000,
  staleCutoffMs: 2 * HOUR_MS,
  persistentBlockAlertMs: 4 * HOUR_MS,
  forceRestartAfterMs: 4 * HOUR_MS,
  childCheckFallbackAfterMs: 30 * 60_000,
}

const BUSY_OVER_THRESHOLD: GateInputs = {
  nowMs: NOW,
  contextTokens: 450_000,
  paneState: 'busy',
  paneUsageLimited: false,
  hardGuardPhase: 'idle',
  pendingOutboundCount: 0,
  hasStaleOutbound: false,
  hasChildProcesses: false,
  hasOpenQuestion: false,
  hasLiveTaskState: false,
}

const STALE = { firstBlockedAt: NOW - 4 * DAY_MS, lastAlertAt: NOW - 3 * DAY_MS, lastClearAt: 5 }

describe('resetStreakIfBelowThreshold (pure)', () => {
  it('a measured context under the threshold ends the streak: both clocks go, lastClearAt stays', () => {
    expect(resetStreakIfBelowThreshold(STALE, 120_000, 400_000)).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: 5 })
  })

  it('a measured 0 (fresh session) ends it too', () => {
    expect(resetStreakIfBelowThreshold(STALE, 0, 400_000).firstBlockedAt).toBeNull()
  })

  it('the boundary: exactly at the threshold keeps the streak, one under ends it', () => {
    expect(resetStreakIfBelowThreshold(STALE, 400_000, 400_000)).toBe(STALE)
    expect(resetStreakIfBelowThreshold(STALE, 399_999, 400_000).firstBlockedAt).toBeNull()
  })

  it('over the threshold the streak is left alone (a genuine long block still escalates)', () => {
    expect(resetStreakIfBelowThreshold(STALE, 450_000, 400_000)).toBe(STALE)
  })

  it('an unmeasurable context says nothing about the streak: kept (its own escalation path)', () => {
    expect(resetStreakIfBelowThreshold(STALE, null, 400_000)).toBe(STALE)
  })

  it('nothing to reset returns the same object (so callers can tell reset from kept)', () => {
    const empty = { firstBlockedAt: null, lastAlertAt: null, lastClearAt: null }
    expect(resetStreakIfBelowThreshold(empty, 10, 400_000)).toBe(empty)
  })

  it('a stray alert clock without a block clock is cleared as well', () => {
    const s = { firstBlockedAt: null, lastAlertAt: NOW - DAY_MS, lastClearAt: null }
    expect(resetStreakIfBelowThreshold(s, 10, 400_000).lastAlertAt).toBeNull()
  })
})

describe('reconcileStreakWithContext: the reset reaches agent_state', () => {
  it('returned state AND the persisted row are reset, so the next sweep does not see the old clock', () => {
    const agent = uniq('agent-a')
    writeGateRunState(agent, STALE)
    const r = reconcileStreakWithContext(agent, readGateRunState(agent), 90_000, CFG.thresholdTokens)
    expect(r).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: 5 })
    expect(readGateRunState(agent)).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: 5 })
  })

  it('over the threshold nothing is rewritten', () => {
    const agent = uniq('agent-b')
    writeGateRunState(agent, STALE)
    reconcileStreakWithContext(agent, readGateRunState(agent), 500_000, CFG.thresholdTokens)
    expect(readGateRunState(agent)).toEqual(STALE)
  })
})

describe('the false alarm end to end', () => {
  it('stale clock + context back over the threshold + mid-turn pane: alerted before, a plain block now', () => {
    const agent = uniq('agent-c')
    writeGateRunState(agent, STALE)

    // Before the fix: the first sweep over the threshold measures from the 4-day-old clock.
    const before = decideGate(BUSY_OVER_THRESHOLD, CFG, readGateRunState(agent).firstBlockedAt)
    expect(before.action).toBe('block-alert')
    expect(before.reason).toMatch(/pane-busy/)

    // The context was compacted in between: a sweep under the threshold ends the streak ...
    reconcileStreakWithContext(agent, readGateRunState(agent), 80_000, CFG.thresholdTokens)
    // ... so when it climbs back over, the clock starts from nothing.
    const after = decideGate(BUSY_OVER_THRESHOLD, CFG, readGateRunState(agent).firstBlockedAt)
    expect(after.action).toBe('block')
    expect(after.reason).toMatch(/pane-busy/)
  })

  it('a genuine streak (context stays over the threshold, blocked for hours) still alerts', () => {
    const agent = uniq('agent-d')
    writeGateRunState(agent, { firstBlockedAt: NOW - 5 * HOUR_MS, lastAlertAt: null, lastClearAt: null })
    const s = reconcileStreakWithContext(agent, readGateRunState(agent), 450_000, CFG.thresholdTokens)
    expect(decideGate(BUSY_OVER_THRESHOLD, CFG, s.firstBlockedAt).action).toBe('block-alert')
  })
})

describe('wiring', () => {
  it('checkAgent reconciles the streak with the measured context before deciding', () => {
    const src = readFileSync(new URL('../web/context-restart-gate-runner.ts', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('async function checkAgent'))
    const reconcile = body.indexOf('reconcileStreakWithContext(')
    const decide = body.indexOf('decideGate(')
    expect(reconcile).toBeGreaterThan(-1)
    expect(reconcile).toBeLessThan(decide)
    expect(body).toMatch(/reconcileStreakWithContext\(\s*name, reconcileRunState\(name, sessionStartMs\), inputs\.contextTokens, cfg\.thresholdTokens\)/)
  })
})

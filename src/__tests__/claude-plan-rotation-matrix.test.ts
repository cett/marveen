import { describe, it, expect } from 'vitest'
import {
  decidePlanRotation,
  estimateCandidateHealth,
  pickEligibleTarget,
  ROTATION_GATE,
  type PlanCandidateHealth,
} from '../claude-plan-rotation.js'
import type { PlanHealth, PlanWindowKey } from '../claude-plan-health.js'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const NOW_S = NOW / 1000
const IN_2H = NOW_S + 2 * 3600
const IN_3D = NOW_S + 3 * 24 * 3600

// Neutral fixture names only.
const ACTIVE = 'plan-a'

function health(
  status: PlanHealth['status'],
  window?: PlanWindowKey,
  resetsAt?: number | null,
): PlanHealth {
  return {
    status,
    window,
    usedPercent: status === 'ok' || status === 'unknown' ? undefined : status === 'exhausted' ? 100 : 92,
    resetsAt,
    sticky: false,
    windows: {},
    reason: `${status}${window ? ':' + window : ''}`,
  }
}

const cand = (
  planId: string,
  freeFivePct: number,
  freeSevenDayPct: number,
  exhausted = false,
): PlanCandidateHealth => ({ planId, freeFivePct, freeSevenDayPct, exhausted })

const GOOD = cand('plan-b', 80, 70)

describe('decidePlanRotation: active-plan x candidates matrix', () => {
  // [label, active health, candidates, expected action, expected target, expected urgency]
  type Cell = [string, PlanHealth, PlanCandidateHealth[], string, string | undefined, string | undefined]
  const cells: Cell[] = [
    ['unknown active -> do nothing even with a perfect candidate', health('unknown'), [GOOD], 'unknown', undefined, undefined],
    ['ok active -> no pressure', health('ok'), [GOOD], 'no-pressure', undefined, undefined],
    [
      'weekly exhaustion with five ok -> rotate hard (the actual incident class, G3)',
      health('exhausted', 'seven_day', IN_3D),
      [GOOD],
      'rotate',
      'plan-b',
      'hard',
    ],
    [
      'weekly pressure -> rotate soft',
      health('pressure', 'seven_day', IN_3D),
      [GOOD],
      'rotate',
      'plan-b',
      'soft',
    ],
    [
      'five_hour exhausted, reset far -> rotate hard',
      health('exhausted', 'five_hour', IN_2H),
      [GOOD],
      'rotate',
      'plan-b',
      'hard',
    ],
    [
      'five_hour pressure, reset far -> rotate soft',
      health('pressure', 'five_hour', IN_2H),
      [GOOD],
      'rotate',
      'plan-b',
      'soft',
    ],
    [
      'five_hour pressure, reset in 10 min -> wait (near-reset)',
      health('pressure', 'five_hour', NOW_S + 10 * 60),
      [GOOD],
      'near-reset',
      undefined,
      undefined,
    ],
    [
      'five_hour EXHAUSTED, reset in 10 min -> also wait',
      health('exhausted', 'five_hour', NOW_S + 10 * 60),
      [GOOD],
      'near-reset',
      undefined,
      undefined,
    ],
    [
      'WEEKLY pressure whose reset is 10 min away -> NO waiting (weekly never waits)',
      health('pressure', 'seven_day', NOW_S + 10 * 60),
      [GOOD],
      'rotate',
      'plan-b',
      'soft',
    ],
    [
      'active exhausted + the only candidate has 3% free -> no alternative (G4)',
      health('exhausted', 'seven_day', IN_3D),
      [cand('plan-b', 3, 3)],
      'no-alternative',
      undefined,
      undefined,
    ],
    [
      'no candidates at all -> no alternative',
      health('exhausted', 'seven_day', IN_3D),
      [],
      'no-alternative',
      undefined,
      undefined,
    ],
    [
      'candidate has plenty of five but a nearly empty week -> not eligible',
      health('exhausted', 'five_hour', IN_2H),
      [cand('plan-b', 90, 14)],
      'no-alternative',
      undefined,
      undefined,
    ],
    [
      'candidate has plenty of week but a nearly empty five -> not eligible',
      health('exhausted', 'five_hour', IN_2H),
      [cand('plan-b', 29, 90)],
      'no-alternative',
      undefined,
      undefined,
    ],
    [
      'candidate exactly at both minimums is eligible',
      health('exhausted', 'five_hour', IN_2H),
      [cand('plan-b', ROTATION_GATE.minCandidateFreeFivePct, ROTATION_GATE.minCandidateFreeWeeklyPct)],
      'rotate',
      'plan-b',
      'hard',
    ],
    [
      'candidate flagged exhausted is never a target even with big numbers',
      health('exhausted', 'seven_day', IN_3D),
      [cand('plan-b', 90, 90, true)],
      'no-alternative',
      undefined,
      undefined,
    ],
    [
      'two candidates: the one with more headroom in its TIGHTER window wins',
      health('exhausted', 'seven_day', IN_3D),
      [cand('plan-b', 95, 40), cand('plan-c', 60, 60)],
      'rotate',
      'plan-c',
      'hard',
    ],
    [
      'tie on score -> planId ascending, independent of order (forward)',
      health('exhausted', 'seven_day', IN_3D),
      [cand('plan-b', 50, 50), cand('plan-c', 50, 50)],
      'rotate',
      'plan-b',
      'hard',
    ],
    [
      'tie on score -> planId ascending, independent of order (reversed)',
      health('exhausted', 'seven_day', IN_3D),
      [cand('plan-c', 50, 50), cand('plan-b', 50, 50)],
      'rotate',
      'plan-b',
      'hard',
    ],
    [
      'the active plan is never its own target',
      health('exhausted', 'seven_day', IN_3D),
      [cand(ACTIVE, 100, 100)],
      'no-alternative',
      undefined,
      undefined,
    ],
    [
      'a non-finite candidate number is never eligible (unlike the legacy fail-open picker)',
      health('exhausted', 'seven_day', IN_3D),
      [cand('plan-b', Number.NaN, 90)],
      'no-alternative',
      undefined,
      undefined,
    ],
  ]
  for (const [label, active, candidates, action, target, urgency] of cells) {
    it(label, () => {
      const d = decidePlanRotation({ activePlanId: ACTIVE, active, candidates, nowMs: NOW })
      expect(d.action).toBe(action)
      if (d.action === 'rotate') {
        expect(d.targetPlanId).toBe(target)
        expect(d.urgency).toBe(urgency)
      } else {
        expect(target).toBeUndefined()
      }
    })
  }
})

describe('decidePlanRotation: near-reset boundary', () => {
  const at = (untilMs: number) =>
    decidePlanRotation({
      activePlanId: ACTIVE,
      active: health('pressure', 'five_hour', (NOW + untilMs) / 1000),
      candidates: [GOOD],
      nowMs: NOW,
    }).action

  it('exactly at the near-reset limit still waits (<=)', () => {
    expect(at(ROTATION_GATE.nearResetMs)).toBe('near-reset')
  })
  it('one second beyond the limit rotates', () => {
    expect(at(ROTATION_GATE.nearResetMs + 1000)).toBe('rotate')
  })
  it('a reset time already in the past counts as near-reset', () => {
    expect(at(-5 * 60_000)).toBe('near-reset')
  })
  it('a five_hour block with an unknown reset (null) does not wait: rotate', () => {
    const d = decidePlanRotation({
      activePlanId: ACTIVE,
      active: health('exhausted', 'five_hour', null),
      candidates: [GOOD],
      nowMs: NOW,
    })
    expect(d.action).toBe('rotate')
  })
})

describe('pickEligibleTarget', () => {
  it('ignores ineligible candidates even if they would score higher', () => {
    const t = pickEligibleTarget([cand('plan-b', 100, 10), cand('plan-c', 35, 20)], ACTIVE)
    expect(t).toBe('plan-c')
  })
  it('returns null for an empty pool', () => {
    expect(pickEligibleTarget([], ACTIVE)).toBeNull()
  })
})

describe('estimateCandidateHealth (frozen estimate of an inactive plan)', () => {
  it('never observed -> fully free (fail open, as before)', () => {
    const c = estimateCandidateHealth('plan-b', {}, NOW)
    expect(c).toEqual({ planId: 'plan-b', freeFivePct: 100, freeSevenDayPct: 100, exhausted: false })
  })

  it('frozen at the last observed percentage until the reset', () => {
    const c = estimateCandidateHealth(
      'plan-b',
      { five_hour: { usedPercent: 60, resetsAt: IN_2H }, seven_day: { usedPercent: 20, resetsAt: IN_3D } },
      NOW,
    )
    expect(c.freeFivePct).toBe(40)
    expect(c.freeSevenDayPct).toBe(80)
    expect(c.exhausted).toBe(false)
  })

  it('an expired window is fully free again', () => {
    const c = estimateCandidateHealth(
      'plan-b',
      { five_hour: { usedPercent: 100, resetsAt: NOW_S }, seven_day: { usedPercent: 20, resetsAt: IN_3D } },
      NOW,
    )
    expect(c.freeFivePct).toBe(100)
    expect(c.exhausted).toBe(false)
  })

  it('exhausted when either core window has nothing left', () => {
    const five = estimateCandidateHealth('plan-b', { five_hour: { usedPercent: 100, resetsAt: IN_2H } }, NOW)
    const seven = estimateCandidateHealth('plan-b', { seven_day: { usedPercent: 100, resetsAt: IN_3D } }, NOW)
    expect(five.exhausted).toBe(true)
    expect(seven.exhausted).toBe(true)
  })

  it('end to end: a candidate frozen at weekly 100 is never chosen', () => {
    const frozen = estimateCandidateHealth('plan-b', { seven_day: { usedPercent: 100, resetsAt: IN_3D } }, NOW)
    expect(
      decidePlanRotation({
        activePlanId: ACTIVE,
        active: health('exhausted', 'seven_day', IN_3D),
        candidates: [frozen],
        nowMs: NOW,
      }).action,
    ).toBe('no-alternative')
  })
})

describe('legacy API stays intact', () => {
  it('ROTATION_GATE keeps its original keys and values', () => {
    expect(ROTATION_GATE.switchAtPercent).toBe(90)
    expect(ROTATION_GATE.nearResetMs).toBe(30 * 60_000)
  })
})

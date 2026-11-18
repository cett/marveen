import { describe, it, expect } from 'vitest'
import {
  classifyPlanHealth,
  FRESH_SNAPSHOT_MAX_AGE_SEC,
  FUTURE_SKEW_TOLERANCE_SEC,
  type PlanSnapshot,
  type PlanWindowKey,
  type SnapshotWindow,
} from '../claude-plan-health.js'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const NOW_S = NOW / 1000
const IN_2H = NOW_S + 2 * 3600
const IN_3D = NOW_S + 3 * 24 * 3600

/** A snapshot with the given windows; fresh (age 5 s) unless overridden. */
function snap(
  windows: Partial<Record<PlanWindowKey, SnapshotWindow | null>>,
  ageSec = 5,
): PlanSnapshot {
  return { kind: 'snapshot', ageSec, windows }
}

const w = (usedPercent: number, resetsAt: number | null = IN_2H): SnapshotWindow => ({
  usedPercent,
  resetsAt,
})

describe('classifyPlanHealth: fresh snapshot threshold table', () => {
  // [label, five_hour %, seven_day %, expected status, expected binding window]
  const cells: Array<[string, number, number, string, string | undefined]> = [
    ['both low', 10, 10, 'ok', undefined],
    ['five just below 90', 89.99, 10, 'ok', undefined],
    ['five exactly 90', 90, 10, 'pressure', 'five_hour'],
    ['seven just below 95', 10, 94.99, 'ok', undefined],
    ['seven exactly 95', 10, 95, 'pressure', 'seven_day'],
    ['seven 90 is NOT pressure (weekly threshold is 95)', 10, 90, 'ok', undefined],
    ['five just below 100', 99.99, 10, 'pressure', 'five_hour'],
    ['five exactly 100', 100, 10, 'exhausted', 'five_hour'],
    ['seven exactly 100 with five ok (weekly exhaustion)', 10, 100, 'exhausted', 'seven_day'],
    ['seven 100 beats five pressure', 95, 100, 'exhausted', 'seven_day'],
    ['usage above 100 is still exhausted', 120, 10, 'exhausted', 'five_hour'],
  ]
  for (const [label, five, seven, status, window] of cells) {
    it(label, () => {
      const h = classifyPlanHealth(snap({ five_hour: w(five, IN_2H), seven_day: w(seven, IN_3D) }), NOW)
      expect(h.status).toBe(status)
      expect(h.window).toBe(window)
      expect(h.sticky).toBe(false)
    })
  }
})

describe('classifyPlanHealth: freshness boundary and sticky pressure (the incident)', () => {
  const FRESH = FRESH_SNAPSHOT_MAX_AGE_SEC

  it('a snapshot exactly at the freshness limit is still evaluated as live', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(10) }, FRESH), NOW)
    expect(h.status).toBe('ok')
    expect(h.sticky).toBe(false)
  })

  it('one second past the limit a LOW snapshot becomes unknown (we never rotate blind)', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(10) }, FRESH + 1), NOW)
    expect(h.status).toBe('unknown')
    expect(h.reason).toBe('stale-below-pressure')
  })

  it('one second past the limit a HIGH snapshot is STICKY pressure (frozen session on a spent plan)', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(93) }, FRESH + 1), NOW)
    expect(h.status).toBe('pressure')
    expect(h.sticky).toBe(true)
    expect(h.window).toBe('five_hour')
  })

  it('a stale exhausted snapshot stays exhausted until the window resets', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100) }, 3 * 3600), NOW)
    expect(h.status).toBe('exhausted')
    expect(h.sticky).toBe(true)
  })

  it('stale weekly pressure is sticky as well', () => {
    const h = classifyPlanHealth(snap({ seven_day: w(96, IN_3D) }, 2 * 24 * 3600), NOW)
    expect(h.status).toBe('pressure')
    expect(h.window).toBe('seven_day')
    expect(h.sticky).toBe(true)
  })

  it('stale: five low, seven high -> sticky pressure from the high one only', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(10), seven_day: w(97, IN_3D) }, FRESH + 1), NOW)
    expect(h.status).toBe('pressure')
    expect(h.window).toBe('seven_day')
  })

  it('stale: the weekly 90 (below its 95 threshold) is not sticky pressure', () => {
    const h = classifyPlanHealth(snap({ seven_day: w(90, IN_3D) }, FRESH + 1), NOW)
    expect(h.status).toBe('unknown')
  })
})

describe('classifyPlanHealth: expired windows', () => {
  it('a high window whose reset is exactly now has rolled over and is ignored', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, NOW_S), seven_day: w(10, IN_3D) }), NOW)
    expect(h.status).toBe('ok')
    expect(h.windows.five_hour).toBeUndefined()
  })

  it('a reset one second in the future still counts', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, NOW_S + 1) }), NOW)
    expect(h.status).toBe('exhausted')
  })

  it('a stale high window that has since expired is NOT sticky any more', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, NOW_S - 60), seven_day: w(10, IN_3D) }, 3 * 3600), NOW)
    // five expired, seven low and stale -> nothing to act on
    expect(h.status).toBe('unknown')
  })

  it('every window expired -> unknown, not ok', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, NOW_S - 10), seven_day: w(100, NOW_S - 5) }), NOW)
    expect(h.status).toBe('unknown')
    expect(h.reason).toBe('all-windows-expired')
  })

  it('a window without a reset time is never treated as expired', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, null) }, 3 * 3600), NOW)
    expect(h.status).toBe('exhausted')
    expect(h.resetsAt).toBeNull()
  })
})

describe('classifyPlanHealth: binding window selection', () => {
  it('when both windows are exhausted, the one that resets LATER binds', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, IN_2H), seven_day: w(100, IN_3D) }), NOW)
    expect(h.window).toBe('seven_day')
    expect(h.resetsAt).toBe(IN_3D)
  })

  it('when both are pressured, the later reset binds', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(92, IN_2H), seven_day: w(96, IN_3D) }), NOW)
    expect(h.status).toBe('pressure')
    expect(h.window).toBe('seven_day')
  })

  it('exhausted outranks pressure even if the pressured window resets later', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, IN_2H), seven_day: w(96, IN_3D) }), NOW)
    expect(h.status).toBe('exhausted')
    expect(h.window).toBe('five_hour')
  })

  it('same reset instant: the weekly window wins the tie, regardless of input key order', () => {
    const a = classifyPlanHealth(snap({ five_hour: w(100, IN_2H), seven_day: w(100, IN_2H) }), NOW)
    const b = classifyPlanHealth(snap({ seven_day: w(100, IN_2H), five_hour: w(100, IN_2H) }), NOW)
    expect(a.window).toBe('seven_day')
    expect(b.window).toBe('seven_day')
  })

  it('an exhausted window with an unknown reset is the most pessimistic and binds', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100, null), seven_day: w(100, IN_3D) }), NOW)
    expect(h.window).toBe('five_hour')
  })
})

describe('classifyPlanHealth: missing and malformed input -> unknown', () => {
  it('missing snapshot', () => {
    const h = classifyPlanHealth({ kind: 'missing' }, NOW)
    expect(h.status).toBe('unknown')
    expect(h.reason).toBe('snapshot-missing')
  })

  it('no windows at all', () => {
    const h = classifyPlanHealth(snap({}), NOW)
    expect(h.status).toBe('unknown')
    expect(h.reason).toBe('no-core-window')
  })

  it('null windows only', () => {
    expect(classifyPlanHealth(snap({ five_hour: null, seven_day: null }), NOW).status).toBe('unknown')
  })

  it('one core window is enough', () => {
    expect(classifyPlanHealth(snap({ seven_day: w(100, IN_3D) }), NOW).status).toBe('exhausted')
  })

  const bad: Array<[string, unknown]> = [
    ['NaN percent', { usedPercent: Number.NaN, resetsAt: IN_2H }],
    ['negative percent', { usedPercent: -1, resetsAt: IN_2H }],
    ['Infinity percent', { usedPercent: Number.POSITIVE_INFINITY, resetsAt: IN_2H }],
    ['NaN resetsAt', { usedPercent: 50, resetsAt: Number.NaN }],
    ['string percent', { usedPercent: '95', resetsAt: IN_2H }],
  ]
  for (const [label, bw] of bad) {
    it(`${label} -> unknown, even if the other window looks fine`, () => {
      const h = classifyPlanHealth(
        snap({ five_hour: bw as SnapshotWindow, seven_day: w(10, IN_3D) }),
        NOW,
      )
      expect(h.status).toBe('unknown')
      expect(h.reason).toBe('malformed-window:five_hour')
    })
  }

  it('a malformed window never degrades into ok by being skipped', () => {
    const h = classifyPlanHealth(
      snap({ five_hour: w(Number.NaN), seven_day: w(1, IN_3D) }),
      NOW,
    )
    expect(h.status).not.toBe('ok')
  })

  it('NaN / non-number age -> unknown', () => {
    expect(classifyPlanHealth(snap({ five_hour: w(100) }, Number.NaN), NOW).status).toBe('unknown')
    expect(
      classifyPlanHealth({ kind: 'snapshot', ageSec: undefined as unknown as number, windows: { five_hour: w(100) } }, NOW)
        .status,
    ).toBe('unknown')
  })

  it('a snapshot from the future beyond the skew tolerance is not trusted', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100) }, -FUTURE_SKEW_TOLERANCE_SEC - 1), NOW)
    expect(h.status).toBe('unknown')
    expect(h.reason).toBe('snapshot-from-future')
  })

  it('a snapshot within the skew tolerance counts as fresh', () => {
    const h = classifyPlanHealth(snap({ five_hour: w(100) }, -FUTURE_SKEW_TOLERANCE_SEC), NOW)
    expect(h.status).toBe('exhausted')
    expect(h.sticky).toBe(false)
  })
})

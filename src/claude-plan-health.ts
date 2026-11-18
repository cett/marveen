// Pure plan-health classifier for the backend plan-rotation monitor (c1).
//
// Input: a per-plan rate-limit SNAPSHOT (the statusLine writes the CLI's own
// rate_limits block, one file per plan; the reader in c2 turns that file into
// the PlanSnapshot below). This module never touches fs, network or clock.
// Output: PlanHealth {ok | pressure | exhausted | unknown}.
//
// Why snapshot-based and not an HTTP probe: no token, no keychain, no gate
// involvement (plan rev1, section 1).
//
// The root of the incident is encoded in the freshness rule (rev1, section
// 3): the snapshot only changes when an API response arrives. On an exhausted
// plan the session freezes and the snapshot freezes with it, so a snapshot
// that is OLD but whose window has not reset yet and was already high is
// still pressure (sticky). Only an old snapshot that was LOW is unknown: we
// cannot tell whether the plan got spent afterwards, and we never rotate
// blind.
//
// This module does not decide WHAT to do about a bad plan; that is
// decidePlanRotation in claude-plan-rotation.ts.

import { ROTATION_GATE } from './claude-plan-rotation.js'

export type PlanWindowKey = 'five_hour' | 'seven_day'

/** One quota window as the statusLine snapshot reports it. `resetsAt` is unix
 *  epoch SECONDS, null when the snapshot did not carry one. */
export interface SnapshotWindow {
  usedPercent: number
  resetsAt: number | null
}

export type PlanSnapshot =
  /** No file, or no rate_limits block in it. */
  | { kind: 'missing' }
  | {
      kind: 'snapshot'
      /** Seconds since the snapshot was written (the reader derives it from
       *  the record timestamp / file mtime and the injected clock). */
      ageSec: number
      /** A null/absent window is skipped. A window that is present but
       *  malformed makes the whole result unknown. */
      windows: Partial<Record<PlanWindowKey, SnapshotWindow | null>>
    }

export type PlanHealthStatus = 'ok' | 'pressure' | 'exhausted' | 'unknown'

export interface PlanHealth {
  status: PlanHealthStatus
  /** The binding window for pressure/exhausted: the one that stays blocked
   *  the longest (latest resetsAt), ties broken by WINDOW_ORDER. */
  window?: PlanWindowKey
  usedPercent?: number
  /** Unix epoch seconds, null when unknown. Undefined for ok/unknown. */
  resetsAt?: number | null
  /** True when the verdict rests on an old snapshot (sticky pressure). */
  sticky: boolean
  /** The non-expired windows that were evaluated (telemetry/state). */
  windows: Partial<Record<PlanWindowKey, SnapshotWindow>>
  /** Short machine-readable reason. */
  reason: string
}

/** A snapshot up to this old is evaluated as live. Older ones are "stale". */
export const FRESH_SNAPSHOT_MAX_AGE_SEC = 10 * 60

/** Tolerated clock skew for a snapshot that appears to be from the future
 *  (mtime vs. wall clock rounding). Beyond it the snapshot is not trusted. */
export const FUTURE_SKEW_TOLERANCE_SEC = 60

/** Tie-break order when two windows reset at the same instant: the longer
 *  window wins (a weekly block is the more severe one). */
const WINDOW_ORDER: readonly PlanWindowKey[] = ['seven_day', 'five_hour']

const unknown = (reason: string): PlanHealth => ({
  status: 'unknown',
  sticky: false,
  windows: {},
  reason,
})

function isUsable(w: SnapshotWindow): boolean {
  return (
    typeof w.usedPercent === 'number' &&
    Number.isFinite(w.usedPercent) &&
    w.usedPercent >= 0 &&
    (w.resetsAt === null || (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)))
  )
}

/** Severity of one window's value: 2 exhausted, 1 pressure, 0 fine. */
function severity(key: PlanWindowKey, usedPercent: number): 0 | 1 | 2 {
  if (usedPercent >= ROTATION_GATE.exhaustedAtPercent) return 2
  const threshold =
    key === 'five_hour' ? ROTATION_GATE.switchAtPercent : ROTATION_GATE.switchAtWeeklyPercent
  return usedPercent >= threshold ? 1 : 0
}

/**
 * Classify one plan snapshot. `nowMs` is injected so the freshness and
 * expiry rules are testable with a fake clock.
 */
export function classifyPlanHealth(snapshot: PlanSnapshot, nowMs: number): PlanHealth {
  if (snapshot.kind === 'missing') return unknown('snapshot-missing')

  const age = snapshot.ageSec
  if (typeof age !== 'number' || !Number.isFinite(age)) return unknown('bad-age')
  if (age < -FUTURE_SKEW_TOLERANCE_SEC) return unknown('snapshot-from-future')
  const stale = age > FRESH_SNAPSHOT_MAX_AGE_SEC

  const nowSec = nowMs / 1000
  const live: Partial<Record<PlanWindowKey, SnapshotWindow>> = {}
  for (const key of WINDOW_ORDER) {
    const w = snapshot.windows[key]
    if (w === null || w === undefined) continue
    if (!isUsable(w)) return unknown(`malformed-window:${key}`)
    // An expired window has rolled over: its stored percentage describes the
    // PREVIOUS window and says nothing about the current one (same rule as
    // src/web/quota.ts). `<=`: a reset landing exactly now has already cleared.
    if (w.resetsAt !== null && w.resetsAt <= nowSec) continue
    live[key] = w
  }
  if (!snapshot.windows.five_hour && !snapshot.windows.seven_day) return unknown('no-core-window')
  if (!live.five_hour && !live.seven_day) return unknown('all-windows-expired')

  let worst: 0 | 1 | 2 = 0
  const worstKeys: PlanWindowKey[] = []
  for (const key of WINDOW_ORDER) {
    const w = live[key]
    if (!w) continue
    const s = severity(key, w.usedPercent)
    if (s > worst) {
      worst = s
      worstKeys.length = 0
    }
    if (s === worst && s > 0) worstKeys.push(key)
  }

  if (worst === 0) {
    // An old snapshot that was LOW proves nothing about the present.
    if (stale) return { ...unknown('stale-below-pressure'), windows: live }
    return { status: 'ok', sticky: false, windows: live, reason: 'ok' }
  }

  // A window without a known reset counts as blocked "forever": the most
  // pessimistic reading, so it wins the binding slot. Ties keep the earlier
  // WINDOW_ORDER key (strict >).
  const binding = worstKeys.reduce((best, k) => {
    const bestReset = live[best]!.resetsAt ?? Number.POSITIVE_INFINITY
    const kReset = live[k]!.resetsAt ?? Number.POSITIVE_INFINITY
    return kReset > bestReset ? k : best
  })
  const w = live[binding]!
  const status: PlanHealthStatus = worst === 2 ? 'exhausted' : 'pressure'
  return {
    status,
    window: binding,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
    sticky: stale,
    windows: live,
    reason: `${status}:${binding}:${w.usedPercent}%${stale ? ':sticky' : ''}`,
  }
}

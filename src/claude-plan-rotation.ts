// Pure decision logic for Claude plan rotation (PR2a).
//
// See docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md for the
// full design. This module answers two narrow questions, kept pure (no fs/
// network) so the thresholds are unit-tested with fixtures, mirroring
// quota-gate.ts:
//
//   1. How much headroom does an INACTIVE plan probably have right now?
//      (estimateWindowFree) -- deterministic, not fuzzy: an inactive plan's
//      usage is FROZEN at its last observed percentage, because nothing
//      consumes its quota while it is not the active login. The only thing
//      that changes an inactive plan's estimate is a reset boundary passing,
//      which is a known, computable instant, not a guess.
//
//   2. Given the ACTIVE plan's pressure and the other plans' estimated
//      headroom, should the fleet rotate now, wait for the reset, or rotate
//      to a specific target? (decideRotationAction)
//
// FAIL OPEN, same rule as quota-gate.ts: a plan with no observation yet is
// assumed to have full headroom (100% free) rather than excluded, because
// "we don't know" must never be a reason to strand the fleet on a spent plan.
//
// This module does NOT decide whether MAIN_AGENT_ISOLATED_CONFIG is active,
// does not read store/claude-plans.json or store/usage-latest.json, and does
// not restart any session. Those are wiring (PR2c).

// Type-only import (erased at runtime): claude-plan-health.ts imports
// ROTATION_GATE from here, so a value import would be circular.
import type { PlanHealth } from './claude-plan-health.js'

/** Last observed state of one quota window (e.g. the 5-hour window) for a
 *  plan, as recorded in store/claude-plans-state.json while that plan was
 *  last active. */
export interface ObservedWindow {
  /** 0..100. */
  usedPercent: number
  /** Unix epoch SECONDS. */
  resetsAt: number
}

/** A plan's estimated headroom at a point in time, for logging/ranking. */
export interface PlanQuotaEstimate {
  planId: string
  /** 0..100, HIGHER = more free quota. */
  freeFivePct: number
  freeSevenDayPct: number
  /** nowMs at estimation time, for logging only. */
  estimatedAt: number
}

/**
 * Estimated % free (100 - used) for one window of a plan that is NOT
 * currently active. Deterministic: frozen at the last observed percentage
 * until a reset boundary passes, at which point it is fully free again.
 */
export function estimateWindowFree(
  lastObserved: ObservedWindow | undefined,
  nowMs: number,
): number {
  // No observation yet -- fail open, assume full headroom rather than
  // excluding the plan from rotation candidacy.
  if (!lastObserved) return 100

  const resetsAtMs = lastObserved.resetsAt * 1000
  // `>=`, not `>`: a reset landing on the exact current instant has already
  // cleared the window, matching the <= / expired boundary convention used
  // for window resets elsewhere (src/web/quota.ts).
  if (nowMs >= resetsAtMs) return 100

  return 100 - lastObserved.usedPercent
}

export interface RotationCandidate {
  planId: string
  /** From estimateWindowFree() for the 5-hour window. */
  freeFivePct: number
}

/**
 * The best rotation target among candidates, excluding the currently active
 * plan. Ties break on planId ascending (stable, not iteration-order
 * dependent) so the result never depends on how the caller assembled the
 * candidate array.
 */
export function pickRotationTarget(
  candidates: RotationCandidate[],
  excludePlanId: string,
): string | null {
  const pool = candidates.filter((c) => c.planId !== excludePlanId)
  if (pool.length === 0) return null
  return pool.reduce((best, c) => {
    if (c.freeFivePct > best.freeFivePct) return c
    if (c.freeFivePct === best.freeFivePct && c.planId < best.planId) return c
    return best
  }).planId
}

export const ROTATION_GATE = {
  /** Proactive switch threshold on the active plan's 5-hour window. */
  switchAtPercent: 90,
  /** Proactive switch threshold on the weekly window. Higher than the 5h one:
   *  the weekly window drains slowly, 90 would strand a lot of unused quota. */
  switchAtWeeklyPercent: 95,
  /** A window at or above this is spent: the plan is blocked until its reset. */
  exhaustedAtPercent: 100,
  /** A rotation target must have at least this much free quota in BOTH
   *  windows, otherwise the rotation just moves the fleet onto an almost
   *  empty plan (flapping between two nearly spent plans). */
  minCandidateFreeFivePct: 30,
  minCandidateFreeWeeklyPct: 15,
  /** "About to reset anyway" -- rotating for less than this is not worth the
   *  Telegram noise + session interruption. Same value and rationale as
   *  quota-gate.ts's nearResetMs. */
  nearResetMs: 30 * 60_000,
} as const

export type RotationDecision =
  | { action: 'no-pressure'; reason: string }
  | { action: 'near-reset'; reason: string }
  | { action: 'no-alternative'; reason: string }
  | { action: 'rotate'; targetPlanId: string; reason: string }

/**
 * The proactive, heartbeat-cycle decision (design 6.3). The caller is
 * responsible for the upstream fail-open checks (untrusted/stale snapshot,
 * missing window) before calling this -- by the time this runs, the active
 * plan's 5-hour window is known-good.
 *
 * The reactive path (design 6.3 "reaktív út", a live 429 during a session)
 * is a separate trigger that calls performRotation(target) directly and does
 * not go through this proactive gate at all.
 */
export function decideRotationAction(input: {
  activePlanId: string
  activeFiveHour: ObservedWindow
  candidates: RotationCandidate[]
  nowMs: number
}): RotationDecision {
  const { activePlanId, activeFiveHour, candidates, nowMs } = input

  const usedPct = activeFiveHour.usedPercent
  if (usedPct < ROTATION_GATE.switchAtPercent) {
    return { action: 'no-pressure', reason: `pressure:${usedPct}%` }
  }

  const untilResetMs = activeFiveHour.resetsAt * 1000 - nowMs
  if (untilResetMs <= ROTATION_GATE.nearResetMs) {
    return {
      action: 'near-reset',
      reason: `pressure:${usedPct}%,resets-in:${Math.round(untilResetMs / 60_000)}m`,
    }
  }

  const target = pickRotationTarget(candidates, activePlanId)
  if (!target) {
    return { action: 'no-alternative', reason: `pressure:${usedPct}%,no-candidates` }
  }

  return { action: 'rotate', targetPlanId: target, reason: `pressure:${usedPct}%->${target}` }
}

// ---------------------------------------------------------------------------
// Backend-tick decision (plan-rotation monitor, c1). Works on PlanHealth from
// claude-plan-health.ts instead of the single 5-hour snapshot above, so it
// covers weekly pressure and exhaustion (gap G3) and refuses to move the
// fleet onto a nearly empty plan (gap G4). The legacy decideRotationAction
// above is kept untouched until the old heartbeat is retired (c4).
// ---------------------------------------------------------------------------

/** One rotation candidate as the monitor describes it: a fresh probe where
 *  available, else the frozen estimate (see estimateCandidateHealth). */
export interface PlanCandidateHealth {
  planId: string
  /** 0..100, HIGHER = more free quota. */
  freeFivePct: number
  freeSevenDayPct: number
  exhausted: boolean
}

/**
 * Candidate headroom from the last observed windows of an INACTIVE plan,
 * frozen until a reset boundary passes (same rule as estimateWindowFree).
 * `exhausted` is true when either core window has nothing left right now.
 */
export function estimateCandidateHealth(
  planId: string,
  observed: { five_hour?: ObservedWindow; seven_day?: ObservedWindow },
  nowMs: number,
): PlanCandidateHealth {
  const freeFivePct = estimateWindowFree(observed.five_hour, nowMs)
  const freeSevenDayPct = estimateWindowFree(observed.seven_day, nowMs)
  return {
    planId,
    freeFivePct,
    freeSevenDayPct,
    exhausted: freeFivePct <= 0 || freeSevenDayPct <= 0,
  }
}

/** A candidate is eligible only when it has real headroom in BOTH windows.
 *  Non-finite numbers are never eligible: unlike the legacy picker, "we do
 *  not know" is not a reason to move the fleet onto a plan. */
function isEligibleTarget(c: PlanCandidateHealth): boolean {
  return (
    !c.exhausted &&
    Number.isFinite(c.freeFivePct) &&
    Number.isFinite(c.freeSevenDayPct) &&
    c.freeFivePct >= ROTATION_GATE.minCandidateFreeFivePct &&
    c.freeSevenDayPct >= ROTATION_GATE.minCandidateFreeWeeklyPct
  )
}

/** The eligible candidate with the most headroom in its TIGHTER window; ties
 *  break on planId ascending so the array order never matters. */
export function pickEligibleTarget(
  candidates: PlanCandidateHealth[],
  excludePlanId: string,
): string | null {
  const pool = candidates.filter((c) => c.planId !== excludePlanId && isEligibleTarget(c))
  if (pool.length === 0) return null
  const score = (c: PlanCandidateHealth) => Math.min(c.freeFivePct, c.freeSevenDayPct)
  return pool.reduce((best, c) => {
    if (score(c) > score(best)) return c
    if (score(c) === score(best) && c.planId < best.planId) return c
    return best
  }).planId
}

export type PlanRotationDecision =
  /** The active plan could not be measured reliably: do nothing. */
  | { action: 'unknown'; reason: string }
  | { action: 'no-pressure'; reason: string }
  | { action: 'near-reset'; reason: string }
  | { action: 'no-alternative'; reason: string }
  | {
      action: 'rotate'
      targetPlanId: string
      /** 'hard' = the plan is exhausted (act on one tick); 'soft' = pressure
       *  only (the monitor debounces over consecutive ticks). */
      urgency: 'hard' | 'soft'
      reason: string
    }

/**
 * Decide from the ACTIVE plan's health and the candidates' headroom.
 *
 * Near-reset waiting applies only when the binding window is the 5-hour
 * one: its reset is at most a few hours away. A weekly block resets in days,
 * waiting for it is pointless, so it never waits.
 */
export function decidePlanRotation(input: {
  activePlanId: string
  active: PlanHealth
  candidates: PlanCandidateHealth[]
  nowMs: number
}): PlanRotationDecision {
  const { activePlanId, active, candidates, nowMs } = input

  if (active.status === 'unknown') return { action: 'unknown', reason: active.reason }
  if (active.status === 'ok') return { action: 'no-pressure', reason: active.reason }

  if (active.window === 'five_hour' && active.resetsAt != null) {
    const untilResetMs = active.resetsAt * 1000 - nowMs
    // `<=` like the legacy gate: exactly at the boundary still waits.
    if (untilResetMs <= ROTATION_GATE.nearResetMs) {
      return {
        action: 'near-reset',
        reason: `${active.reason},resets-in:${Math.round(untilResetMs / 60_000)}m`,
      }
    }
  }

  const target = pickEligibleTarget(candidates, activePlanId)
  if (!target) return { action: 'no-alternative', reason: `${active.reason},no-eligible-candidate` }

  return {
    action: 'rotate',
    targetPlanId: target,
    urgency: active.status === 'exhausted' ? 'hard' : 'soft',
    reason: `${active.reason}->${target}`,
  }
}

// Reactive path (design 6.3 addendum, Kobza Attila 2026-09-11): a live 429 /
// "quota exceeded" response during a session should trigger rotation
// immediately, without waiting for the next proactive heartbeat tick. The
// design left the exact detection SITE open ("hol figyeljük a 429-et...
// implementációs kérdés") -- this PR ships only the pure classifier; wiring
// it into a live tmux-output watcher is a separate, riskier follow-up (it
// means parsing a running session's output, not just reading a JSON
// snapshot) and is intentionally NOT part of this PR. See the PR description.
//
// Deliberately conservative: false negatives (missing a real quota error) are
// safe -- the proactive path still catches it within one heartbeat cycle.
// False positives are not: this string match must not fire on a plain error
// message that happens to mention "limit" for an unrelated reason, so it
// requires one of a short list of high-specificity phrases rather than any
// single common word.
const QUOTA_EXCEEDED_PATTERNS = [
  /\b429\b/,
  /quota[\s_-]?exceeded/i,
  /usage[\s_-]?limit[\s_-]?reached/i,
  /rate[\s_-]?limit[\s_-]?exceeded/i,
] as const

export function isQuotaExceededError(text: string): boolean {
  return QUOTA_EXCEEDED_PATTERNS.some((re) => re.test(text))
}

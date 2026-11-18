// Pure anti-flapping guard for the backend plan-rotation monitor (c3b).
//
// decidePlanRotation (claude-plan-rotation.ts) says WHAT should happen on one
// tick. This module says whether the monitor may DO it now. It never touches
// fs, network, clock or the settings: every input is passed in, so each rule
// is a table cell in the tests.
//
// Everything the guard needs to survive a restart is derived from the
// persisted rotation log (cooldown, breaker window, restart backoff); only the
// soft-pressure streak is in-memory, and losing it on a restart is the
// conservative direction (one more tick of waiting before a soft rotation).
//
// A human reset (resetAtMs) makes the breaker and the backoff forget every
// entry at or before it; the cooldown keeps seeing them all.
//
// Rules, in the order they are checked:
//   1. breaker: BREAKER_MAX act-rotations inside BREAKER_WINDOW_MS (or a
//      persisted tripped flag) -> no automatic rotation at all.
//   2. restart backoff: after a failed restart wait RESTART_BACKOFF_MS; after
//      MAX_RESTART_FAILURES in a row stop trying.
//   3. cooldown: COOLDOWN_MS after a successful rotation, except ONE immediate
//      re-rotation when the plan we just moved to is spent (hard) and the last
//      rotation was not itself such a bypass.
//   4. debounce: a soft (pressure) rotation needs SOFT_TICKS consecutive ticks;
//      a hard (exhausted) one acts on the first.
//
// Observe-mode entries (mode 'observe') never count toward any of these: the
// guard judges what the monitor actually DID to the fleet.

import type { RotationLogEntry, RotationTrigger } from './web/claude-plans-state.js'

export const GUARD = {
  /** Consecutive ticks a soft (pressure) decision must repeat before it acts. */
  SOFT_TICKS: 2,
  COOLDOWN_MS: 45 * 60_000,
  BREAKER_MAX: 3,
  BREAKER_WINDOW_MS: 6 * 3600_000,
  RESTART_BACKOFF_MS: 5 * 60_000,
  MAX_RESTART_FAILURES: 3,
} as const

export type GuardVerdict =
  | { verdict: 'go'; trigger: RotationTrigger }
  | { verdict: 'wait-debounce'; reason: string }
  | { verdict: 'wait-cooldown'; reason: string }
  | { verdict: 'wait-backoff'; reason: string }
  /** Too many rotations lately: the caller trips the breaker (observe + one alert). */
  | { verdict: 'breaker-trip'; reason: string }
  /** The breaker is already tripped: stay quiet, nothing to alert again. */
  | { verdict: 'breaker-open'; reason: string }
  /** Restart kept failing: no more automatic attempts, alert once. */
  | { verdict: 'gave-up'; reason: string }

export interface GuardInput {
  agentId: string
  urgency: 'hard' | 'soft'
  nowMs: number
  /** Consecutive ticks (this one included) on which a soft rotate decision was
   *  reached. Ignored for a hard decision. */
  softStreak: number
  /** The persisted log, any agent, any mode, oldest first. */
  log: readonly RotationLogEntry[]
  /** A persisted tripped breaker flag. */
  breakerTripped: boolean
  /** Epoch ms of the last human reset (monitor.resetAt). The breaker and the
   *  restart-failure count ignore entries at or before it; the cooldown does
   *  not. */
  resetAtMs?: number
}

const isAct = (e: RotationLogEntry): boolean => e.mode === 'act'

export function evaluateRotationGuard(input: GuardInput): GuardVerdict {
  const { agentId, urgency, nowMs, softStreak, log, breakerTripped, resetAtMs } = input

  if (breakerTripped) return { verdict: 'breaker-open', reason: 'breaker-tripped' }

  // 1. Breaker: counted over the whole fleet's act-rotations, because the
  //    protection is against the monitor itself flapping, whichever agent it
  //    moved. `>=`: the third rotation inside the window is the last allowed,
  //    so the FOURTH decision (count already 3) trips it.
  // A human reset forgets what came before it, for the breaker and the backoff only.
  const counted = resetAtMs === undefined ? log : log.filter((e) => e.ts > resetAtMs)
  const windowStart = nowMs - GUARD.BREAKER_WINDOW_MS
  const recentRotations = counted.filter((e) => isAct(e) && e.result === 'rotated' && e.ts > windowStart)
  if (recentRotations.length >= GUARD.BREAKER_MAX) {
    return { verdict: 'breaker-trip', reason: `${recentRotations.length}-rotations-in-${GUARD.BREAKER_WINDOW_MS / 3600_000}h` }
  }

  const mine = log.filter((e) => e.agentId === agentId && isAct(e))
  const lastOk = lastOf(mine, (e) => e.result === 'rotated')
  const mineCounted = counted.filter((e) => e.agentId === agentId && isAct(e))

  // 2. Restart backoff: failures since this agent's last success.
  const failuresSinceOk = mineCounted.filter((e) => e.result === 'failed' && (!lastOk || e.ts > lastOk.ts))
  if (failuresSinceOk.length >= GUARD.MAX_RESTART_FAILURES) {
    return { verdict: 'gave-up', reason: `${failuresSinceOk.length}-restart-failures` }
  }
  const lastFail = failuresSinceOk[failuresSinceOk.length - 1]
  if (lastFail && nowMs - lastFail.ts < GUARD.RESTART_BACKOFF_MS) {
    return { verdict: 'wait-backoff', reason: `restart-failed:${Math.ceil((GUARD.RESTART_BACKOFF_MS - (nowMs - lastFail.ts)) / 1000)}s-left` }
  }

  // 3. Cooldown after a successful rotation.
  let trigger: RotationTrigger = urgency
  if (lastOk && nowMs - lastOk.ts < GUARD.COOLDOWN_MS) {
    const bypassAllowed = urgency === 'hard' && lastOk.trigger !== 'hard-bypass'
    if (!bypassAllowed) {
      return { verdict: 'wait-cooldown', reason: `${Math.ceil((GUARD.COOLDOWN_MS - (nowMs - lastOk.ts)) / 60_000)}m-left` }
    }
    trigger = 'hard-bypass'
  }

  // 4. Debounce for pressure-only decisions.
  if (urgency === 'soft' && softStreak < GUARD.SOFT_TICKS) {
    return { verdict: 'wait-debounce', reason: `soft-streak:${softStreak}/${GUARD.SOFT_TICKS}` }
  }

  return { verdict: 'go', trigger }
}

function lastOf<T>(items: readonly T[], pred: (t: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i]!)) return items[i]
  }
  return undefined
}

/**
 * The soft-pressure streak after one more tick. A tick that is not a soft
 * rotate decision for the SAME agent resets it: two pressure readings with a
 * healthy one between them are not "consecutive".
 */
export function nextSoftStreak(prev: number, softDecisionThisTick: boolean): number {
  return softDecisionThisTick ? prev + 1 : 0
}

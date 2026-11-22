// S4 (observe only): a quota error showing in the main session's tmux pane, read by the monitor as a
// SECOND opinion next to the rate-limit snapshot, never on its own.
//
// Why only a corroborating, logged signal: the pattern list (claude-plan-rotation.ts isQuotaExceededError)
// is deliberately broad enough to catch a real "429" / "usage limit reached" line, which also means it can
// hit an unrelated number on a busy pane. So a hit is worth acting on only together with the snapshot
// (pressure, a window already high, or a stale snapshot), and in this step it is not acted on at all: the
// monitor logs the hit in observe mode so the rule can be calibrated on real data before anyone lets it move
// the fleet.
//
// PRIVACY: the main agent's pane holds user messages and tool output, and a matching line can be an echoed
// message with any content. The log is kept and readable by others, so NOTHING from the pane text leaves this
// function: a hit is reported as the class of the pattern and the position of the line, never as text.
//
// Pure: the pane text and the already classified health come in, nothing is read here.

import { isQuotaExceededError } from './claude-plan-rotation.js'
import type { PlanHealth } from './claude-plan-health.js'

/** How many trailing pane lines are looked at: the live bottom of the screen, not the scrollback. */
export const S4_TAIL_LINES = 40
/** A live window at or above this counts as the snapshot agreeing with the pane. */
export const S4_SNAPSHOT_FLOOR_PERCENT = 80

export type S4Result =
  | { hit: false }
  | {
      hit: true
      /** The class of the pattern that matched, a fixed identifier. Never pane text. */
      pattern: 'quota_exceeded'
      /** Position of the matching line counted from the bottom of the pane: -1 is the last line. */
      line: number
      /** True when the snapshot does not contradict the pane. */
      corroborated: boolean
    }

export function evaluateS4(pane: string | null, health: PlanHealth): S4Result {
  if (!pane) return { hit: false }
  const tail = pane.split('\n').slice(-S4_TAIL_LINES)
  let position: number | undefined
  for (let i = tail.length - 1; i >= 0; i--) {
    if (isQuotaExceededError(tail[i]!)) {
      position = i - tail.length
      break
    }
  }
  if (position === undefined) return { hit: false }
  const windowHigh = Object.values(health.windows).some(
    (w) => w !== undefined && w.usedPercent >= S4_SNAPSHOT_FLOOR_PERCENT,
  )
  // The plan's rule: pane hit AND (snapshot >= 80% OR the snapshot is stale). Pressure, exhaustion and sticky
  // pressure are all >= 90% on a live window (ROTATION_GATE), so `windowHigh` already covers them; the one
  // stale case it does not cover is an old snapshot that was LOW. A missing or malformed snapshot cannot vouch
  // either way, so it does not corroborate: the hit is still logged, flagged false.
  const stale = health.reason === 'stale-below-pressure'
  const corroborated = windowHigh || stale
  return { hit: true, pattern: 'quota_exceeded', line: position, corroborated }
}

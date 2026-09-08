import { describe, it, expect } from 'vitest'
import {
  decideStuckInputAction,
  decideStuckInputRecovery,
  type StuckInputActionFacts,
  type StuckInputState,
  type StuckInputThresholds,
} from '../pane-state.js'

// Delivery-reliability deep-fix (BA56A500): the I/O submit-escalation
// decision (decideStuckInputAction). The pre-existing recovery-stack tests
// (decideStuckInputRecovery et al.) are untouched. Coverage for the submit
// predicates (parkedInputRowCount, submitLanded) themselves lives in
// pane-state.test.ts, which already exercises every case these fixtures
// covered (single-row, wrapped multi-row, idle/no-box, landed/not-landed/
// null-capture) via its own generic parked-input fixtures -- the row/signature
// logic under test is content-agnostic (structural box parsing), so the
// <channel>-tag-specific fixtures here added no distinct edge case (moved
// out as part of #786 dedup, not merged elsewhere).

function facts(over: Partial<StuckInputActionFacts>): StuckInputActionFacts {
  return {
    escalate: false,
    rowCount: 1,
    blockComplete: false,
    blockTruncated: false,
    truncatedPreamble: false,
    allowPlainReinject: false,
    hasPlainText: false,
    scheduledTaskBlock: false,
    machineOrigin: false,
    ...over,
  }
}

describe('decideStuckInputAction (recovery-decision unit)', () => {
  it('NEVER bare-Enters a multi-row box: complete block -> re-inject, not enter', () => {
    // The core of the fix: a plain Enter on a multi-row parked message inserts a
    // newline (corrupt). Multi-row escalates straight to the chat_id-safe
    // re-inject even before the Enter-first budget is spent.
    const a = decideStuckInputAction(facts({ rowCount: 3, blockComplete: true, escalate: false }))
    expect(a).toBe('reinject-block')
    expect(a).not.toBe('enter')
  })

  it('multi-row truncated <channel> block -> hold (no Enter, no wrong-chat_id re-inject)', () => {
    const a = decideStuckInputAction(facts({ rowCount: 2, blockTruncated: true, escalate: true }))
    expect(a).toBe('hold')
  })

  it('multi-row sub-agent MACHINE-marked plain text -> re-inject plain, never enter', () => {
    const a = decideStuckInputAction(
      facts({ rowCount: 2, allowPlainReinject: true, hasPlainText: true, machineOrigin: true }),
    )
    expect(a).toBe('reinject-plain')
  })

  // -------------------------------------------------------------------------
  // STUCKINPUT805: the lossy-rescue regression measured live on 2026-08-05.
  // The visible-box scrape drops the HEAD rows of an overfull box, so a
  // re-inject of it is deterministic corruption (10,509-char prompt delivered
  // as its last ~400 chars, byte-identically at 15:06 and 16:00).
  // -------------------------------------------------------------------------

  it('STUCKINPUT805: a parked scheduled tick on a SUB-AGENT is clear-only, never reinject-plain', () => {
    // The old branch order routed this into reinject-plain (the sub-agent
    // check sat above the scheduled check) -- the exact bug. The scheduler
    // re-fires the tick whole; the scrape never contains the whole prompt.
    const a = decideStuckInputAction(facts({
      rowCount: 5, allowPlainReinject: true, hasPlainText: true,
      scheduledTaskBlock: true, machineOrigin: true, escalate: true,
    }))
    expect(a).toBe('clear-scheduled')
  })

  it('STUCKINPUT805: uncertain-origin park on a sub-agent -> hold, never clear or re-inject', () => {
    // "Sub-agent means no human draft" is false: agent-terminal types into
    // sub-agent panes too. A human's text has no re-delivery; destroying it is
    // strictly worse than a wedged box. Simulates the human-typed overflow:
    // long multi-row text, no machine marker anywhere.
    const a = decideStuckInputAction(facts({
      rowCount: 8, allowPlainReinject: true, hasPlainText: true,
      machineOrigin: false, escalate: true,
    }))
    expect(a).toBe('hold')
  })

  it('STUCKINPUT805: box so short even the tail marker is cut -> no machine evidence -> default path', () => {
    // scheduledTaskBlock and machineOrigin both read false when every marker
    // is outside the visible box. Multi-row holds; single-row keeps the
    // harmless legacy Enter. Neither destroys anything.
    expect(decideStuckInputAction(facts({
      rowCount: 3, allowPlainReinject: true, hasPlainText: true, escalate: true,
    }))).toBe('hold')
    expect(decideStuckInputAction(facts({
      rowCount: 1, allowPlainReinject: true, hasPlainText: true, escalate: true,
    }))).toBe('enter')
  })

  it('multi-row with nothing safely re-injectable -> hold (never corrupt via Enter)', () => {
    const a = decideStuckInputAction(facts({ rowCount: 4 }))
    expect(a).toBe('hold')
  })

  it('single-row complete block, pre-escalation -> bare Enter (may submit on its own)', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, blockComplete: true, escalate: false }))).toBe('enter')
  })

  it('single-row complete block, escalated -> clear + verbatim re-inject', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, blockComplete: true, escalate: true }))).toBe('reinject-block')
  })

  it('truncation-guard preserved: escalated truncated preamble -> clear only', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, truncatedPreamble: true, escalate: true }))).toBe('clear-preamble')
  })

  it('single-row truncated block keeps the harmless legacy Enter', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, blockTruncated: true, escalate: true }))).toBe('enter')
  })

  it('single-row default (swallowed Enter) -> bare Enter', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, escalate: true }))).toBe('enter')
  })

  // 2026-07-25 hermes incident: a multi-row scheduled-task tick parked on the
  // MAIN session (no plain re-inject) used to fall into the no-remedy 'hold'
  // branch forever -> channel permanently mute. Clear-only is the safe move:
  // the next schedule fire re-delivers, while re-injecting risks TUI mid-text
  // truncation corrupting the instruction.
  it('multi-row parked scheduled-task tick on main -> clear-scheduled, not hold', () => {
    const a = decideStuckInputAction(facts({ rowCount: 6, scheduledTaskBlock: true }))
    expect(a).toBe('clear-scheduled')
  })

  it('escalated single-row scheduled-task tick -> clear-scheduled', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, scheduledTaskBlock: true, escalate: true }))).toBe('clear-scheduled')
  })

  it('single-row scheduled-task tick pre-escalation still tries the harmless Enter', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, scheduledTaskBlock: true, escalate: false }))).toBe('enter')
  })

  it('STUCKINPUT805 precedence FLIP: clear-scheduled beats plain re-inject on sub-agents too', () => {
    // The previous version of this test pinned the OPPOSITE ("existing path
    // preserved") -- and that precedence WAS the bug: on a sub-agent pane a
    // parked scheduled tick took the reinject-plain branch, whose payload is a
    // scrape of the VISIBLE box. The TUI drops the head rows of an overfull
    // box, so the scrape was the tail fragment -- re-injected byte-identically
    // at 15:06 and 16:00 on 2026-08-05 (10,509-char prompt as its last ~400
    // chars). clear-scheduled is strictly better on every session: the next
    // schedule fire re-delivers the WHOLE prompt.
    const a = decideStuckInputAction(
      facts({ rowCount: 3, scheduledTaskBlock: true, allowPlainReinject: true, hasPlainText: true, machineOrigin: true }),
    )
    expect(a).toBe('clear-scheduled')
  })
})

// Contract for the LOCAL FAST stuck-input recovery (stuck-input-watcher.ts):
// on the 15s tick the same parked signature must reach the clear+re-inject
// escalation (attempt > MAIN_STUCK_ENTER_ATTEMPTS=2, i.e. attempts 3..) WELL
// BEFORE the give-up cap, so a swallowed Enter gets the message actually
// re-injected within ~30-45s instead of waiting minutes for the slow
// channel-monitor backstop. These thresholds mirror LOCAL_FAST_THRESHOLDS,
// which the fast watcher applies to BOTH local sub-agents and the MAIN
// channels session (MAIN no longer bare-Enter-only).
describe('sub-agent fast stuck-input recovery contract', () => {
  const LOCAL_FAST_THRESHOLDS: StuckInputThresholds = {
    confirmMs: 12_000,
    dedupMs: 12_000,
    maxAttempts: 5,
  }

  const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
  const MAIN_STUCK_ENTER_ATTEMPTS = 2 // bare Enters before clear+re-inject escalation

  // Drive a stable parked signature through the decision fn on a fixed tick,
  // collecting the attempt number on every tick that recovers.
  function runSpell(sig: string, tickMs: number, ticks: number): number[] {
    let state = NO_STATE
    let now = 0
    const recoveredAttempts: number[] = []
    for (let i = 0; i < ticks; i++) {
      now += tickMs
      const { recover, next } = decideStuckInputRecovery(sig, state, now, LOCAL_FAST_THRESHOLDS)
      if (recover) recoveredAttempts.push(next.attempts)
      state = next
    }
    return recoveredAttempts
  }

  it('reaches clear+re-inject escalation before the give-up cap', () => {
    // 15s tick (the watcher interval). First seen at t=15s, confirm window
    // 12s already elapsed by the next tick, then one action per tick.
    const attempts = runSpell('parked Németh Gábor ...', 15_000, 10)
    // Recovers exactly maxAttempts times, numbered 1..5.
    expect(attempts).toEqual([1, 2, 3, 4, 5])
    // At least one escalation attempt (>2) happened -> clear + re-inject is
    // exercised, not just bare Enter.
    expect(attempts.some((a) => a > MAIN_STUCK_ENTER_ATTEMPTS)).toBe(true)
  })

  it('stops acting once the give-up cap is hit (no infinite recovery)', () => {
    const attempts = runSpell('still parked', 15_000, 40)
    expect(attempts).toEqual([1, 2, 3, 4, 5])
    expect(attempts.length).toBe(LOCAL_FAST_THRESHOLDS.maxAttempts)
  })

  it('a changed signature restarts the spell (message still arriving / edited)', () => {
    let state = NO_STATE
    let now = 0
    // First signature parks and recovers once...
    now += 15_000
    let d = decideStuckInputRecovery('sig-a', state, now, LOCAL_FAST_THRESHOLDS)
    state = d.next // record only (new spell)
    now += 15_000
    d = decideStuckInputRecovery('sig-a', state, now, LOCAL_FAST_THRESHOLDS)
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(1)
    state = d.next
    // ...then the text changes: confirm window restarts, no immediate action.
    now += 15_000
    d = decideStuckInputRecovery('sig-b', state, now, LOCAL_FAST_THRESHOLDS)
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(0)
    expect(d.next.firstSeenAt).toBe(now)
  })

  it('clears state when nothing is parked', () => {
    const d = decideStuckInputRecovery(null, { parkedSig: 'x', firstSeenAt: 1, lastRecoverAt: 1, attempts: 2 }, 99_999, LOCAL_FAST_THRESHOLDS)
    expect(d.recover).toBe(false)
    expect(d.next.parkedSig).toBeNull()
  })
})

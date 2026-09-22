import { describe, it, expect } from 'vitest'
import {
  nudgeText,
  NUDGE_MAX_CHARS,
  decideNudgePreflight,
  recordNudge,
  INITIAL_NUDGE_STATE,
  MIN_PENDING_AGE_MS,
  NUDGE_DEBOUNCE_MS,
  STALE_NUDGE_COOLDOWN_MS,
  MAX_STALE_NUDGES,
  MAX_NUDGES_PER_HOUR,
  type NudgeState,
} from '../web/inbox-nudge-watcher.js'

// nudgeText: the single visual row typed into the 80-col headless channels
// pane. Both language variants MUST fit the pane width, or a wrapped line
// becomes multi-row parked text that MAIN's stuck-input recovery cannot
// auto-submit (see the module header).
describe('nudgeText', () => {
  it('both language variants stay within NUDGE_MAX_CHARS', () => {
    expect(nudgeText('hu').length).toBeLessThanOrEqual(NUDGE_MAX_CHARS)
    expect(nudgeText('en').length).toBeLessThanOrEqual(NUDGE_MAX_CHARS)
  })

  it('returns distinct, non-empty text per language', () => {
    expect(nudgeText('hu')).not.toBe(nudgeText('en'))
    expect(nudgeText('hu').length).toBeGreaterThan(0)
  })
})

describe('decideNudgePreflight', () => {
  const NOW = 1_000_000

  it('empty inbox with a fresh state is a true no-op (no state churn)', () => {
    const r = decideNudgePreflight({ now: NOW, oldestId: null, oldestAgeMs: 0 }, INITIAL_NUDGE_STATE)
    expect(r.proceed).toBe(false)
    expect(r.state).toBe(INITIAL_NUDGE_STATE) // identity-equal: no unnecessary state replacement
  })

  it('empty inbox after an active spell resets spell-scoped fields but keeps lastNudgeAt', () => {
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, lastNudgeAt: 500, lastNudgeOldestId: 42, staleNudges: 2 }
    const r = decideNudgePreflight({ now: NOW, oldestId: null, oldestAgeMs: 0 }, prev)
    expect(r.proceed).toBe(false)
    expect(r.state.lastNudgeOldestId).toBeNull()
    expect(r.state.staleNudges).toBe(0)
    expect(r.state.lastNudgeAt).toBe(500) // the global debounce floor survives
  })

  it('a message younger than MIN_PENDING_AGE_MS is left alone', () => {
    const r = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS - 1 }, INITIAL_NUDGE_STATE)
    expect(r.proceed).toBe(false)
  })

  it('respects the global debounce floor since the last nudge', () => {
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, lastNudgeAt: NOW - (NUDGE_DEBOUNCE_MS - 1) }
    const r = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    expect(r.proceed).toBe(false)
  })

  it('proceeds once age + debounce clear, with a fresh (non-stale) target', () => {
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS }
    const r = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    expect(r.proceed).toBe(true)
  })

  it('a stale spell (same oldest id, prior nudges) is held back inside the stale cooldown', () => {
    const prev: NudgeState = {
      ...INITIAL_NUDGE_STATE,
      lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS,
      lastNudgeOldestId: 1,
      staleNudges: 1,
    }
    const r = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    expect(r.proceed).toBe(false)
  })

  it('a stale spell proceeds again once the stale cooldown elapses (below MAX_STALE_NUDGES)', () => {
    const prev: NudgeState = {
      ...INITIAL_NUDGE_STATE,
      lastNudgeAt: NOW - STALE_NUDGE_COOLDOWN_MS,
      lastNudgeOldestId: 1,
      staleNudges: 1,
    }
    const r = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    expect(r.proceed).toBe(true)
  })

  it('stops and alerts exactly once after MAX_STALE_NUDGES on the same oldest id', () => {
    const prev: NudgeState = {
      ...INITIAL_NUDGE_STATE,
      lastNudgeAt: NOW - STALE_NUDGE_COOLDOWN_MS,
      lastNudgeOldestId: 1,
      staleNudges: MAX_STALE_NUDGES,
      staleAlerted: false,
    }
    const r1 = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    if (r1.proceed) throw new Error('expected proceed=false')
    expect(r1.staleAlert).toBe(true)
    expect(r1.state.staleAlerted).toBe(true)

    // Second tick with staleAlerted already true: silent, no repeat alert.
    const r2 = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS }, r1.state)
    if (r2.proceed) throw new Error('expected proceed=false')
    expect(r2.staleAlert).toBeUndefined()
  })

  it('the rolling hourly budget blocks once MAX_NUDGES_PER_HOUR is reached, logging once', () => {
    const prev: NudgeState = {
      ...INITIAL_NUDGE_STATE,
      lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS,
      recentNudges: Array.from({ length: MAX_NUDGES_PER_HOUR }, (_, i) => NOW - i * 1000),
    }
    const r1 = decideNudgePreflight({ now: NOW, oldestId: 5, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    if (r1.proceed) throw new Error('expected proceed=false')
    expect(r1.budgetLog).toBe(true)
    expect(r1.state.budgetLogged).toBe(true)

    const r2 = decideNudgePreflight({ now: NOW, oldestId: 5, oldestAgeMs: MIN_PENDING_AGE_MS }, r1.state)
    if (r2.proceed) throw new Error('expected proceed=false')
    expect(r2.budgetLog).toBeUndefined()
  })

  it('budget entries older than the rolling window drop off and free capacity', () => {
    const stale = Array.from({ length: MAX_NUDGES_PER_HOUR }, () => NOW - 2 * 60 * 60_000) // 2h ago
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS, recentNudges: stale }
    const r = decideNudgePreflight({ now: NOW, oldestId: 5, oldestAgeMs: MIN_PENDING_AGE_MS }, prev)
    expect(r.proceed).toBe(true)
    expect(r.state.recentNudges).toEqual([])
  })
})

describe('recordNudge', () => {
  const NOW = 1_000_000

  it('starts a fresh stale-count (1) when the oldest id changes', () => {
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, lastNudgeOldestId: 1, staleNudges: 3, staleAlerted: true }
    const next = recordNudge(prev, NOW, 2)
    expect(next.lastNudgeOldestId).toBe(2)
    expect(next.staleNudges).toBe(1)
    expect(next.staleAlerted).toBe(false) // reset on a genuinely new target
  })

  it('increments staleNudges and preserves staleAlerted when the oldest id repeats', () => {
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, lastNudgeOldestId: 1, staleNudges: 1, staleAlerted: false }
    const next = recordNudge(prev, NOW, 1)
    expect(next.staleNudges).toBe(2)
    expect(next.staleAlerted).toBe(false)
  })

  it('appends to recentNudges and stamps lastNudgeAt', () => {
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, recentNudges: [NOW - 1000] }
    const next = recordNudge(prev, NOW, 9)
    expect(next.lastNudgeAt).toBe(NOW)
    expect(next.recentNudges).toEqual([NOW - 1000, NOW])
  })

  it('prunes recentNudges entries outside the rolling window on the same call', () => {
    const tooOld = NOW - 2 * 60 * 60_000
    const prev: NudgeState = { ...INITIAL_NUDGE_STATE, recentNudges: [tooOld] }
    const next = recordNudge(prev, NOW, 9)
    expect(next.recentNudges).toEqual([NOW])
  })
})

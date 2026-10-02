// Regression: the context-restart gate raised a false "context-tokens-unmeasurable"
// persistent-block alert for a freshly restarted agent.
//
//   - a live session whose transcript had no usage line yet read as null
//     ("cannot measure") instead of 0 (covered in context-gate-stale-signals);
//   - the previous session's block streak was reset in memory only for
//     firstBlockedAt: lastAlertAt survived, and the reset was not asserted to
//     reach agent_state;
//   - an unknown session start disabled the stale-streak guard silently, and the
//     alert text only said "unmeasurable" without saying what or why.
import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase } from '../db.js'
import {
  decideGate,
  resetStreakIfPreviousSession,
  describeUnmeasurableContext,
  SESSION_START_TOLERANCE_MS,
  type GateConfig,
  type GateInputs,
} from '../context-restart-gate.js'
import { readGateRunState, writeGateRunState } from '../web/context-restart-gate-store.js'
import {
  reconcileRunState,
  noteSessionStartUnknown,
  persistentBlockAlertText,
} from '../web/context-restart-gate-runner.js'

beforeAll(() => { initDatabase(':memory:') })

const HOUR_MS = 3_600_000
const NOW = 1_800_000_000_000
const SESSION_START = NOW - 10 * 60_000
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

const BASE_INPUTS: GateInputs = {
  nowMs: NOW,
  contextTokens: null,
  paneState: 'idle',
  paneUsageLimited: false,
  hardGuardPhase: 'idle',
  pendingOutboundCount: 0,
  hasStaleOutbound: false,
  hasChildProcesses: false,
  hasOpenQuestion: false,
  hasLiveTaskState: false,
}

describe('resetStreakIfPreviousSession (pure)', () => {
  const old = { firstBlockedAt: SESSION_START - 5 * HOUR_MS, lastAlertAt: SESSION_START - HOUR_MS, lastClearAt: 123 }

  it('clears BOTH the block clock and the alert clock of a previous session, keeps the rest', () => {
    const r = resetStreakIfPreviousSession(old, SESSION_START)
    expect(r).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: 123 })
    expect(old.firstBlockedAt).not.toBeNull() // input not mutated
  })

  it('a streak of the current session is returned untouched (same object)', () => {
    const live = { firstBlockedAt: SESSION_START + 60_000, lastAlertAt: null, lastClearAt: null }
    expect(resetStreakIfPreviousSession(live, SESSION_START)).toBe(live)
  })

  it('unknown session start or no streak: kept (same object)', () => {
    expect(resetStreakIfPreviousSession(old, null)).toBe(old)
    const none = { firstBlockedAt: null, lastAlertAt: SESSION_START - HOUR_MS, lastClearAt: null }
    expect(resetStreakIfPreviousSession(none, SESSION_START)).toBe(none)
  })

  it('the process-age tolerance applies: just inside keeps, just outside resets', () => {
    const inside = { firstBlockedAt: SESSION_START - SESSION_START_TOLERANCE_MS + 1, lastAlertAt: 5, lastClearAt: null }
    expect(resetStreakIfPreviousSession(inside, SESSION_START)).toBe(inside)
    const outside = { firstBlockedAt: SESSION_START - SESSION_START_TOLERANCE_MS - 1, lastAlertAt: 5, lastClearAt: null }
    expect(resetStreakIfPreviousSession(outside, SESSION_START).lastAlertAt).toBeNull()
  })
})

describe('reconcileRunState: the reset reaches agent_state', () => {
  it('a previous-session streak is nulled in the returned state AND in the persisted row', () => {
    const agent = uniq('agent-a')
    writeGateRunState(agent, { firstBlockedAt: SESSION_START - 5 * HOUR_MS, lastAlertAt: SESSION_START - HOUR_MS, lastClearAt: 777 })
    const r = reconcileRunState(agent, SESSION_START)
    expect(r).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: 777 })
    // Re-read from the store: this is what the NEXT sweep sees.
    expect(readGateRunState(agent)).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: 777 })
  })

  it('a streak of the current session is left in the store as is', () => {
    const agent = uniq('agent-b')
    const state = { firstBlockedAt: SESSION_START + 60_000, lastAlertAt: SESSION_START + 120_000, lastClearAt: null }
    writeGateRunState(agent, state)
    expect(reconcileRunState(agent, SESSION_START)).toEqual(state)
    expect(readGateRunState(agent)).toEqual(state)
  })

  it('unknown session start: nothing is reset or rewritten (guard cannot run)', () => {
    const agent = uniq('agent-c')
    const state = { firstBlockedAt: SESSION_START - 5 * HOUR_MS, lastAlertAt: SESSION_START - HOUR_MS, lastClearAt: null }
    writeGateRunState(agent, state)
    expect(reconcileRunState(agent, null)).toEqual(state)
    expect(readGateRunState(agent)).toEqual(state)
  })

  it('an agent with no stored state reconciles to the empty state', () => {
    expect(reconcileRunState(uniq('agent-d'), SESSION_START)).toEqual({ firstBlockedAt: null, lastAlertAt: null, lastClearAt: null })
  })

  it('the false alarm end to end: inherited streak + null tokens alerts, after the reset it does not', () => {
    const agent = uniq('agent-e')
    writeGateRunState(agent, { firstBlockedAt: SESSION_START - 5 * HOUR_MS, lastAlertAt: null, lastClearAt: null })
    const inherited = readGateRunState(agent)
    expect(decideGate(BASE_INPUTS, CFG, inherited.firstBlockedAt).action).toBe('block-alert') // the bug
    const fixed = reconcileRunState(agent, SESSION_START)
    const d = decideGate(BASE_INPUTS, CFG, fixed.firstBlockedAt)
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/context-tokens-unmeasurable/)
  })
})

describe('fail-closed is unchanged', () => {
  it('an unmeasurable context with a genuine long streak still escalates to block-alert and never allows', () => {
    const d = decideGate(BASE_INPUTS, CFG, NOW - 5 * HOUR_MS)
    expect(d.action).toBe('block-alert')
  })

  it('a measured 0 is a plain below-threshold block (no streak is started, nothing opens)', () => {
    const d = decideGate({ ...BASE_INPUTS, contextTokens: 0 }, CFG, null)
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/below-threshold/)
  })
})

describe('noteSessionStartUnknown: log once per (agent, reason)', () => {
  it('first sighting logs, the same reason does not repeat', () => {
    const a = uniq('agent-f')
    expect(noteSessionStartUnknown(a, 'tmux pane of s not found')).toBe(true)
    expect(noteSessionStartUnknown(a, 'tmux pane of s not found')).toBe(false)
    expect(noteSessionStartUnknown(a, 'tmux pane of s not found')).toBe(false)
  })

  it('a different reason logs again; agents do not share the memory', () => {
    const a = uniq('agent-g')
    const b = uniq('agent-h')
    expect(noteSessionStartUnknown(a, 'reason one')).toBe(true)
    expect(noteSessionStartUnknown(a, 'reason two')).toBe(true)
    expect(noteSessionStartUnknown(b, 'reason one')).toBe(true)
  })

  it('a successful lookup re-arms the log: a later recurrence is logged again', () => {
    const a = uniq('agent-i')
    expect(noteSessionStartUnknown(a, 'ps failed')).toBe(true)
    expect(noteSessionStartUnknown(a, null)).toBe(false)
    expect(noteSessionStartUnknown(a, 'ps failed')).toBe(true)
  })
})

describe('the unmeasurable alert states what could not be measured and why', () => {
  const base = { name: 'agent-a', blockedSinceMin: 300, thresholdTokens: 400_000, childInfo: '', sessionStartReason: null as string | null }

  it('names the token reading cause', () => {
    const t = persistentBlockAlertText({
      ...base, reason: 'context-tokens-unmeasurable (fail-closed)', unmeasurableReason: 'newest transcript s.jsonl is not parseable',
    })
    expect(t).toContain('Ok: context-tokens-unmeasurable (fail-closed).')
    expect(t).toContain('Meres: newest transcript s.jsonl is not parseable.')
    expect(t).not.toContain('inditasi ideje ismeretlen')
  })

  it('also says why the session start is unknown (the reason the stale-streak guard could not run)', () => {
    const t = persistentBlockAlertText({
      ...base, reason: 'context-tokens-unmeasurable (fail-closed)', unmeasurableReason: null,
      sessionStartReason: 'claude process not found under the tmux pane',
    })
    expect(t).toContain('A session inditasi ideje ismeretlen (claude process not found under the tmux pane)')
  })

  it('other block reasons keep the original text, without the measurement detail', () => {
    const t = persistentBlockAlertText({
      ...base, reason: 'pane-busy (mid-turn, not safe)', unmeasurableReason: 'x', sessionStartReason: 'y', childInfo: '',
    })
    expect(t).toBe('[CONTEXT-RESTART-GATE] A(z) "agent-a" agens kapuja 300 perce folyamatosan blokkolt. Ok: pane-busy (mid-turn, not safe). A(z) 400k tokenes kuszob ele ert, de a kapu nem enged -- ellenorizd hogy nincs-e elakadt munka.')
  })

  it('describeUnmeasurableContext falls back to a stated unknown cause, never to silence', () => {
    expect(describeUnmeasurableContext(null, null)).toMatch(/^Meres: ismeretlen ok/)
  })
})

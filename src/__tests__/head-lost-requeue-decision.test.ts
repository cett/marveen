// decideStuckInputAction: the 'clear-requeue' branch (1267). Pure matrix cells, no tmux, no DB. The branch needs ALL of:
// a sub-agent session (allowPlainReinject), parked plain text, a non-truncated-block box, more than one row, a UNIQUE
// tail attribution and a requeue budget that is not spent. Every other cell is the decision it was before this branch.

import { describe, it, expect } from 'vitest'
import {
  decideStuckInputAction, parkedMainInputHasRemedy, type StuckInputActionFacts,
} from '../pane-state.js'

function facts(over: Partial<StuckInputActionFacts> = {}): StuckInputActionFacts {
  return {
    escalate: false,
    rowCount: 4,
    blockComplete: false,
    blockTruncated: false,
    truncatedPreamble: false,
    allowPlainReinject: true,
    hasPlainText: true,
    scheduledTaskBlock: false,
    machineOrigin: false,
    headLostMatch: 'unique',
    requeueBudgetLeft: true,
    ...over,
  }
}

describe('clear-requeue (matrix row 2)', () => {
  it('a unique tail attribution on a multi-row sub-agent box with budget left -> clear-requeue', () => {
    expect(decideStuckInputAction(facts())).toBe('clear-requeue')
  })

  it('needs no escalation: the confirm window of the recovery is the only wait', () => {
    expect(decideStuckInputAction(facts({ escalate: false }))).toBe('clear-requeue')
    expect(decideStuckInputAction(facts({ escalate: true }))).toBe('clear-requeue')
  })
})

describe('everything else stays a hold (rows 3-7)', () => {
  it('no attribution (a human draft, unknown origin, stale) -> hold, as before', () => {
    expect(decideStuckInputAction(facts({ headLostMatch: 'none' }))).toBe('hold')
  })

  it('an ambiguous attribution (several deliveries match) -> hold', () => {
    expect(decideStuckInputAction(facts({ headLostMatch: 'ambiguous' }))).toBe('hold')
  })

  it('a unique attribution with the budget spent -> hold (the caller alerts once)', () => {
    expect(decideStuckInputAction(facts({ requeueBudgetLeft: false }))).toBe('hold')
  })

  it('facts that are not supplied are the safe default: no attribution, no budget -> hold', () => {
    const f = facts()
    delete f.headLostMatch
    expect(decideStuckInputAction(f)).toBe('hold')
    const g = facts()
    delete g.requeueBudgetLeft
    expect(decideStuckInputAction(g)).toBe('hold')
  })

  it('the MAIN session (allowPlainReinject false) never reaches it, whatever the attribution says', () => {
    expect(decideStuckInputAction(facts({ allowPlainReinject: false }))).toBe('hold')
    expect(decideStuckInputAction(facts({ allowPlainReinject: false, hasPlainText: false }))).toBe('hold')
  })

  it('no parked plain text -> hold', () => {
    expect(decideStuckInputAction(facts({ hasPlainText: false }))).toBe('hold')
  })

  it('a truncated <channel> block -> hold (its chat_id is unrecoverable, nothing here is a router frame)', () => {
    expect(decideStuckInputAction(facts({ blockTruncated: true }))).toBe('hold')
  })

  it('a single-row box keeps the legacy Enter: the requeue is for the multi-row hold case only', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1 }))).toBe('enter')
  })
})

describe('the moves that existed before are not touched by the new facts', () => {
  it('a complete <channel> block still re-injects verbatim', () => {
    expect(decideStuckInputAction(facts({ blockComplete: true }))).toBe('reinject-block')
  })

  it('a parked scheduled tick still clears', () => {
    expect(decideStuckInputAction(facts({ scheduledTaskBlock: true }))).toBe('clear-scheduled')
  })

  it('a machine-origin frame with a verified prefix match still re-injects plain, a refuted one still holds', () => {
    expect(decideStuckInputAction(facts({ machineOrigin: true, deliveryMatched: true, headLostMatch: 'none' }))).toBe('reinject-plain')
    expect(decideStuckInputAction(facts({ machineOrigin: true, deliveryMatched: false, headLostMatch: 'none' }))).toBe('hold')
  })

  it('a truncated preamble still clears at full escalation', () => {
    expect(decideStuckInputAction(facts({ truncatedPreamble: true, escalate: true, headLostMatch: 'none' }))).toBe('clear-preamble')
  })
})

describe('the main session soft-remedy probe is blind to the new move', () => {
  it('parkedMainInputHasRemedy builds its facts without an attribution, so a head-lost box still reads "no remedy" there', () => {
    // A multi-row box starting mid-sentence with no wrapper marker: a head-lost frame, as the main session would see it.
    const SEP = '─'.repeat(80)
    const pane = ['', SEP, '❯ tail of some frame, mid sentence, no marker at all in', '  these rows, and a second row of the same box that goes on', '  and a third row that closes it', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(false)
  })
})

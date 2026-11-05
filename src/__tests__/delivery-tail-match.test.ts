// matchDeliveryTail (src/web/delivery-intent.ts): the POSITIVE attribution of a head-lost box. The TUI drops the leading
// rows of an overfull input box, so the box is the TAIL of the frame the router pasted. It is attributed only when its
// collapsed text is a verbatim suffix of exactly ONE fresh delivery that has a ledger row. Anything else is not a match:
// the human-draft side of this contract is the destructive one (a match leads to a clear), so every near miss is pinned.
//
// Privacy: neutral fixtures only (session-a, session-b, agent-a, filler words).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  recordDelivery, clearDeliveries, matchDeliveryTail, removeDeliveryByMsgId, _registrySize,
} from '../web/delivery-intent.js'

const LEDGER = { msgId: 101, toAgent: 'agent-a', tenantId: 'tenant-x' }
const WORDS = Array.from({ length: 60 }, (_, i) => `word${i}`)
// A frame with line breaks inside it (the real frame has them; the box scrape folds them into single spaces).
const FRAME = `HEADER LINE of the frame\n${WORDS.slice(0, 30).join(' ')}\n${WORDS.slice(30).join(' ')}\nCLOSING LINE of the frame`
const FLAT = FRAME.replace(/\s+/g, ' ').trim()

/** The last `n` chars of the collapsed frame, moved forward to a word boundary (a dropped head row ends at one). */
function tailOf(n: number): string {
  const cut = FLAT.slice(-n)
  const sp = cut.indexOf(' ')
  return sp === -1 ? cut : cut.slice(sp + 1)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
  for (const s of ['session-a', 'session-b']) clearDeliveries(s)
})
afterEach(() => { vi.useRealTimers() })

describe('what matches', () => {
  it('the tail of a fresh delivery with a ledger row matches, and names the ledger row', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    const m = matchDeliveryTail('session-a', tailOf(200))
    expect(m).toEqual({ kind: 'match', ref: '101', ledger: LEDGER })
  })

  it('the whole frame is its own suffix', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', FLAT).kind).toBe('match')
  })

  it('folds terminal wrap and line breaks into single spaces on both sides', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    const wrapped = tailOf(200).replace(/ /g, '\n   ')
    expect(matchDeliveryTail('session-a', wrapped).kind).toBe('match')
  })
})

describe('what does not match (each is a near miss that would clear a human draft)', () => {
  it('a PREFIX of the frame is not a tail', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', FLAT.slice(0, 200)).kind).toBe('none')
  })

  it('a piece from the MIDDLE of the frame is not a tail (the loose includes() variant would match it)', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', FLAT.slice(120, 320)).kind).toBe('none')
  })

  it('the tail plus text typed AFTER it is not a tail: the box no longer ends where the frame ends', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', `${tailOf(200)} and one more thing of my own`).kind).toBe('none')
  })

  it('text typed BEFORE the tail is not a tail either', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', `my own words ${tailOf(200)}`).kind).toBe('none')
  })

  it('a box shorter than the minimum is never attributed, the minimum itself is', () => {
    // The frame ends in one 40-char token, so a suffix of exactly 40 and one of 39 chars are both verbatim tails.
    recordDelivery('session-a', `lead ${'a'.repeat(30)} ${'b'.repeat(40)}`, '101', LEDGER)
    expect(matchDeliveryTail('session-a', 'b'.repeat(40)).kind).toBe('match')
    expect(matchDeliveryTail('session-a', 'b'.repeat(39)).kind).toBe('none')
  })

  it('an empty or blank box is none', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', '').kind).toBe('none')
    expect(matchDeliveryTail('session-a', '   \n  ').kind).toBe('none')
  })

  it('a delivery older than five minutes is stale, one at exactly five minutes is still fresh', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    vi.setSystemTime(new Date('2026-01-01T10:05:00Z'))
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('match')
    vi.setSystemTime(new Date('2026-01-01T10:05:00.001Z'))
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('none')
  })

  it('a delivery into ANOTHER session does not attribute', () => {
    recordDelivery('session-b', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('none')
  })

  it('a delivery without a ledger row (a scheduled tick) never matches: there is nothing to requeue', () => {
    recordDelivery('session-a', FRAME, 'scheduled-task')
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('none')
  })

  it('a session that never had a delivery is none', () => {
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('none')
  })
})

describe('ambiguity', () => {
  it('the same text delivered twice (two message ids) is ambiguous, not a match on either', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    recordDelivery('session-a', FRAME, '102', { ...LEDGER, msgId: 102 })
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('ambiguous')
  })

  it('two frames with the same closing text: the shared tail is ambiguous, the unique part matches one', () => {
    const closing = ' shared closing boilerplate of every frame that the wrapper appends'
    recordDelivery('session-a', `first frame body one two three${closing}`, '101', LEDGER)
    recordDelivery('session-a', `second frame body four five six${closing}`, '102', { ...LEDGER, msgId: 102 })
    expect(matchDeliveryTail('session-a', closing.trim()).kind).toBe('ambiguous')
    expect(matchDeliveryTail('session-a', `body four five six${closing}`)).toEqual({
      kind: 'match', ref: '102', ledger: { ...LEDGER, msgId: 102 },
    })
  })

  it('a ledger-less delivery with the same tail still makes it ambiguous (it is a second candidate)', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    recordDelivery('session-a', FRAME, 'scheduled-task')
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('ambiguous')
  })

  it('a stale twin does not make a fresh delivery ambiguous', () => {
    recordDelivery('session-a', FRAME, '100', { ...LEDGER, msgId: 100 })
    vi.setSystemTime(new Date('2026-01-01T10:06:00Z'))
    recordDelivery('session-a', FRAME, '101', LEDGER)
    expect(matchDeliveryTail('session-a', tailOf(200))).toEqual({ kind: 'match', ref: '101', ledger: LEDGER })
  })
})

describe('removeDeliveryByMsgId', () => {
  it('removes only the record of that message: no second match on it, the others stay', () => {
    recordDelivery('session-a', 'other frame that is a completely different text of some length', '102', { ...LEDGER, msgId: 102 })
    recordDelivery('session-a', FRAME, '101', LEDGER)
    removeDeliveryByMsgId('session-a', 101)
    expect(matchDeliveryTail('session-a', tailOf(200)).kind).toBe('none')
    expect(_registrySize('session-a')).toBe(1)
  })

  it('drops the session entry when the last record goes, and is a no-op on an unknown session or id', () => {
    recordDelivery('session-a', FRAME, '101', LEDGER)
    removeDeliveryByMsgId('session-a', 999)
    expect(_registrySize('session-a')).toBe(1)
    removeDeliveryByMsgId('session-a', 101)
    expect(_registrySize('session-a')).toBe(0)
    expect(() => removeDeliveryByMsgId('session-b', 101)).not.toThrow()
  })
})

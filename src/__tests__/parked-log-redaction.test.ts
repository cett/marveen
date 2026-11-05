import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// The un-wedge log lines (clearStaleParkedInput) must not carry the text parked in an input box: the box of the main
// session can hold a human's own draft, the box of a sub-agent an inter-agent frame. They carry the collapsed length and,
// only for a verbatim piece of the wrapper boilerplate, that piece (redactParkedForLog, park-forensics.ts).
//
// Part 1: the redaction helper. Part 2: all six log calls of the un-wedge, driven through the real function with a mocked
// tmux, asserting that the WHOLE logger-call arguments (not just the `parked*` fields) never contain the draft marker.

const h = vi.hoisted(() => {
  const SEP = '\u2500'.repeat(80)
  const FOOTER = '  \u23f5\u23f5 bypass permissions on (shift+tab to cycle)'
  const box = (line: string) => ['', SEP, line, SEP, FOOTER].join('\n')
  return {
    box,
    EMPTY: box('\u276f '),
    // What the mocked pane shows next; a clearing keystroke may swap it for the empty box (see `clearEmpties`).
    pane: '' as string,
    clearEmpties: false,
    calls: [] as string[][],
    logs: [] as Array<{ level: string; args: unknown[] }>,
  }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('send-keys') && (args.includes('C-u') || args.includes('C-k')) && h.clearEmpties) h.pane = h.EMPTY
      if (args.includes('capture-pane')) return h.pane
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))
vi.mock('../logger.js', () => {
  const rec = (level: string) => (...args: unknown[]) => { h.logs.push({ level, args }) }
  return { logger: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), fatal: rec('fatal'), trace: rec('trace'), child: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }) } }
})

import { redactParkedForLog } from '../web/park-forensics.js'
import { clearStaleParkedInput, MAIN_PARKED_HEARTBEAT_AFTER, MAIN_PARKED_OWNER_AFTER } from '../web/agent-process.js'
import { UNTRUSTED_PREAMBLE, TRUSTED_PEER_PREAMBLE, CHANNEL_INBOUND_PREAMBLE } from '../prompt-safety.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim()

describe('redactParkedForLog', () => {
  const boilerplate = flatten([UNTRUSTED_PREAMBLE, TRUSTED_PEER_PREAMBLE, CHANNEL_INBOUND_PREAMBLE].join(' '))
  /** A piece of the boilerplate that is exactly n characters and does not start or end on a space. */
  const exactPiece = (n: number): string => {
    for (let s = 0; s + n <= boilerplate.length; s++) {
      const p = boilerplate.slice(s, s + n)
      if (p === p.trim()) return p
    }
    throw new Error(`no ${n}-char piece`)
  }

  it('shows a verbatim piece of the wrapper boilerplate of 20 characters or more', () => {
    for (const n of [20, 21, 60]) {
      const piece = exactPiece(n)
      expect(redactParkedForLog(piece)).toEqual({ parkedChars: n, parkedShown: piece })
    }
  })

  it('masks a piece shorter than 20 characters: a short run matches almost any text', () => {
    const piece = exactPiece(19)
    expect(redactParkedForLog(piece)).toEqual({ parkedChars: 19, parkedShown: '[non-wrapper 19 chars]' })
  })

  it('masks a row that mixes boilerplate with anything else (a whole parked frame is boilerplate plus a message)', () => {
    const mixed = `${exactPiece(40)} DRAFT-MARKER-mixed`
    const r = redactParkedForLog(mixed)
    expect(r).toEqual({ parkedChars: mixed.length, parkedShown: `[non-wrapper ${mixed.length} chars]` })
    expect(JSON.stringify(r)).not.toContain('DRAFT-MARKER')
  })

  it('masks a human draft and reports only its length', () => {
    const r = redactParkedForLog('DRAFT-MARKER-human please tell agent-a that the plan changed')
    expect(r.parkedShown).toMatch(/^\[non-wrapper \d+ chars\]$/)
    expect(JSON.stringify(r)).not.toContain('DRAFT-MARKER')
  })

  it('collapses tabs, no-break spaces and runs of spaces before measuring, and reports the collapsed length', () => {
    const raw = '  a\t\tb\u00a0\u00a0c     d  '
    expect(redactParkedForLog(raw)).toEqual({ parkedChars: 'a b c d'.length, parkedShown: '[non-wrapper 7 chars]' })
    const piece = exactPiece(30)
    const spread = `\t${piece.replace(/ /g, '\u00a0 \t')}\n`
    expect(redactParkedForLog(spread)).toEqual({ parkedChars: 30, parkedShown: piece })
  })

  it('an empty text is zero characters, masked', () => {
    expect(redactParkedForLog('')).toEqual({ parkedChars: 0, parkedShown: '[non-wrapper 0 chars]' })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The six log calls, through the real function.

let clock = 1_000_000
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
const COOLDOWN = 31_000 // > the un-wedge cooldown, so each call is a fresh round
afterAll(() => { nowSpy.mockRestore() })

const MSG = {
  mainOwner: 'message-router: main-agent parked input -- owner notified with manual fix (box untouched)',
  mainHeartbeat: 'message-router: main-agent parked input -- persisting; visible to the heartbeat round (box untouched)',
  mainUntouched: 'message-router: main-agent parked input -- left untouched',
  subEscalated: 'message-router: sub-agent parked input resisted clearing -- escalated to operator',
  subBackoff: 'message-router: parked input resisted clearing, backing off',
  cleared: 'message-router: cleared stale parked input (channel un-wedge)',
}

const logsFor = (message: string) => h.logs.filter((l) => l.args[1] === message)
const fieldsOf = (l: { args: unknown[] }) => l.args[0] as Record<string, unknown>

/** Every captured logger call of every level, serialised: the marker must not be anywhere in it. */
function expectNoMarkerAnywhere(marker: string): void {
  for (const l of h.logs) expect(JSON.stringify(l.args), `${l.level} ${String(l.args[1])}`).not.toContain(marker)
}

/** The log call carries the redacted fields, not the old raw one. */
function expectRedactedFields(l: { args: unknown[] }, chars: number): void {
  const f = fieldsOf(l)
  expect(f.parked).toBeUndefined()
  expect(f.parkedChars).toBe(chars)
  expect(f.parkedShown).toBe(`[non-wrapper ${chars} chars]`)
}

beforeEach(() => {
  h.calls.length = 0
  h.logs.length = 0
  h.clearEmpties = false
})

describe('the un-wedge log calls never carry the parked text', () => {
  it('main session: left untouched (debug), persisting (heartbeat warn) and owner notified, all redacted', async () => {
    const marker = 'DRAFT-MARKER-main'
    const text = `${marker} human draft for agent-a`
    h.pane = h.box(`\u276f ${text}`)
    for (let i = 0; i < MAIN_PARKED_OWNER_AFTER; i++) {
      await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
      clock += COOLDOWN
    }
    const untouched = logsFor(MSG.mainUntouched)
    const heartbeat = logsFor(MSG.mainHeartbeat)
    const owner = logsFor(MSG.mainOwner)
    expect(untouched).toHaveLength(MAIN_PARKED_HEARTBEAT_AFTER - 1)
    expect(untouched[0]!.level).toBe('debug')
    expect(heartbeat).toHaveLength(MAIN_PARKED_OWNER_AFTER - MAIN_PARKED_HEARTBEAT_AFTER)
    expect(owner).toHaveLength(1)
    for (const l of [...untouched, ...heartbeat, ...owner]) expectRedactedFields(l, text.length)
    expect(fieldsOf(owner[0]!).session).toBe(MAIN_CHANNELS_SESSION)
    expect(typeof fieldsOf(owner[0]!).fails).toBe('number')
    expectNoMarkerAnywhere(marker)
  }, 90_000) // 12 sequential real 2s stable-confirm delays

  it('sub-agent whose box resists clearing: backing off (warn) and, past the threshold, escalated (warn), both redacted', async () => {
    const marker = 'DRAFT-MARKER-resist'
    const text = `${marker} frame text of another agent`
    h.pane = h.box(`\u276f ${text}`) // clearing keystrokes change nothing
    for (let i = 0; i < 6; i++) {
      await clearStaleParkedInput('agent-sub-a')
      clock += COOLDOWN
    }
    const backoff = logsFor(MSG.subBackoff)
    const escalated = logsFor(MSG.subEscalated)
    expect(backoff).toHaveLength(6)
    expect(escalated).toHaveLength(1)
    for (const l of [...backoff, ...escalated]) expectRedactedFields(l, text.length)
    expect(fieldsOf(escalated[0]!).session).toBe('agent-sub-a')
    expectNoMarkerAnywhere(marker)
  }, 120_000)

  it('sub-agent whose box clears: the cleared line is redacted', async () => {
    const marker = 'DRAFT-MARKER-cleared'
    const text = `${marker} stale heartbeat line`
    h.pane = h.box(`\u276f ${text}`)
    h.clearEmpties = true // the first clearing keystroke empties the box
    expect(await clearStaleParkedInput('agent-sub-b')).toBe(true)
    const cleared = logsFor(MSG.cleared)
    expect(cleared).toHaveLength(1)
    expectRedactedFields(cleared[0]!, text.length)
    expect(fieldsOf(cleared[0]!).session).toBe('agent-sub-b')
    expectNoMarkerAnywhere(marker)
  }, 30_000)

  it('the operator alert is not part of the log: its wording is unchanged by the redaction (it still shows the line)', async () => {
    // Pinned so the redaction is not mistaken for a change to the owner alert (a separate, deliberate surface).
    const { notifyChannel } = await import('../notify.js')
    vi.mocked(notifyChannel).mockClear()
    h.pane = h.box('\u276f DRAFT-MARKER-alert visible to the owner only')
    h.clearEmpties = false
    for (let i = 0; i < 6; i++) {
      await clearStaleParkedInput('agent-sub-c')
      clock += COOLDOWN
    }
    expect(notifyChannel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyChannel).mock.calls[0]![0]).toContain('DRAFT-MARKER-alert')
    for (const l of h.logs) expect(JSON.stringify(l.args)).not.toContain('DRAFT-MARKER-alert')
  }, 120_000)
})

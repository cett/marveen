// S4 (observe only): a quota error on the main session's pane, as a second opinion next to the snapshot.
// Health values come from the real classifier, so the corroboration rule is tested against what the monitor
// actually passes in, not against hand-built objects that could drift from it.

import { describe, it, expect } from 'vitest'
import { evaluateS4, S4_TAIL_LINES, S4_SNAPSHOT_FLOOR_PERCENT } from '../claude-plan-s4-signal.js'
import { classifyPlanHealth, type PlanSnapshot } from '../claude-plan-health.js'

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const IN_2H = Math.floor(NOW / 1000) + 2 * 3600
const IN_3D = IN_2H + 3 * 86400

const snap = (five: number, seven: number, ageSec = 5): PlanSnapshot => ({
  kind: 'snapshot',
  ageSec,
  windows: { five_hour: { usedPercent: five, resetsAt: IN_2H }, seven_day: { usedPercent: seven, resetsAt: IN_3D } },
})
const health = (five: number, seven: number, ageSec = 5) => classifyPlanHealth(snap(five, seven, ageSec), NOW)
const HIT = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'
const pane = (...lines: string[]) => lines.join('\n')

describe('evaluateS4: the pane', () => {
  it('no pane, an empty pane and a pane without a quota error are no hit', () => {
    expect(evaluateS4(null, health(90, 10))).toEqual({ hit: false })
    expect(evaluateS4('', health(90, 10))).toEqual({ hit: false })
    expect(evaluateS4(pane('thinking...', 'Done in 3s'), health(90, 10))).toEqual({ hit: false })
  })

  it('a hit is the pattern class and the position from the bottom, nothing else', () => {
    // 'ok', HIT, 'prompt >': the hit is the second of three lines, so -2
    const r = evaluateS4(pane('ok', HIT, 'prompt >'), health(90, 10))
    expect(r).toEqual({ hit: true, pattern: 'quota_exceeded', line: -2, corroborated: true })
  })

  it('only the live bottom of the screen counts: a hit exactly 40 lines from the bottom is in, one more is out', () => {
    // literal 40, not the constant: a test derived from the constant cannot see the constant change
    expect(S4_TAIL_LINES).toBe(40)
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`)
    // the hit is the first of the last 40 lines
    expect(evaluateS4(pane(HIT, ...filler(39)), health(90, 10)).hit).toBe(true)
    // one line further up: scrolled out of the window
    expect(evaluateS4(pane(HIT, ...filler(40)), health(90, 10)).hit).toBe(false)
  })

  it('the LATEST matching line is the one reported, by position', () => {
    const r = evaluateS4(pane('old: 429 too many', 'x', 'newer: usage limit reached', 'y'), health(90, 10))
    expect(r).toMatchObject({ hit: true, line: -2 })
    // the last line itself is -1, the first of the 40 visible is -40
    expect(evaluateS4(pane('x', HIT), health(90, 10))).toMatchObject({ line: -1 })
    expect(evaluateS4(pane(HIT, ...Array.from({ length: 39 }, () => 'x')), health(90, 10))).toMatchObject({ line: -40 })
  })

  it('PRIVACY: no text of the pane line reaches the result, whatever the line says', () => {
    // The pane holds user messages and tool output: a matching line can be an echoed message with any content.
    // This line matches (429) and carries content that must never be echoed anywhere in the result.
    const canary = 'user wrote: HTTP 429, mail jane.doe@example.test the key sk-LEAKCANARY-0123456789 and the diary of agent-z'
    const r = evaluateS4(pane('before', canary, 'after'), health(90, 10))
    expect(r.hit).toBe(true)
    const dump = JSON.stringify(r)
    for (const piece of ['LEAKCANARY', 'jane.doe', 'example.test', 'diary', 'user wrote', 'sk-', 'HTTP']) {
      expect(dump).not.toContain(piece)
    }
    // the shape is fixed: the only keys, and the only string value, are the class identifier
    if (!r.hit) return
    expect(Object.keys(r).sort()).toEqual(['corroborated', 'hit', 'line', 'pattern'])
    expect(Object.values(r).filter((v) => typeof v === 'string')).toEqual(['quota_exceeded'])
  })
})

describe('evaluateS4: corroboration is pane AND (snapshot >= 80% or stale)', () => {
  const corroborated = (h: ReturnType<typeof health>): boolean | null => {
    const r = evaluateS4(HIT, h)
    return r.hit ? r.corroborated : null
  }

  it('a live window at the floor corroborates, one below does not (literal pin, not the constant)', () => {
    expect(S4_SNAPSHOT_FLOOR_PERCENT).toBe(80)
    expect(corroborated(health(80, 10))).toBe(true)
    expect(corroborated(health(79, 10))).toBe(false)
    // the weekly window counts the same
    expect(corroborated(health(10, 80))).toBe(true)
    expect(corroborated(health(10, 79))).toBe(false)
  })

  it('snapshot pressure and exhaustion corroborate', () => {
    expect(corroborated(health(92, 10))).toBe(true)
    expect(corroborated(health(100, 40))).toBe(true)
  })

  it('a stale snapshot corroborates, whether it was high (sticky) or low (stale-below-pressure)', () => {
    const sticky = health(100, 40, 3 * 3600)
    expect(sticky.sticky).toBe(true)
    expect(corroborated(sticky)).toBe(true)
    const staleLow = health(20, 10, 3 * 3600)
    expect(staleLow.reason).toBe('stale-below-pressure')
    expect(corroborated(staleLow)).toBe(true)
  })

  it('a fresh healthy snapshot does not: the hit is reported, flagged uncorroborated', () => {
    expect(corroborated(health(10, 10))).toBe(false)
  })

  it('a missing or malformed snapshot cannot vouch for the pane', () => {
    expect(corroborated(classifyPlanHealth({ kind: 'missing' }, NOW))).toBe(false)
    const malformed = classifyPlanHealth(
      { kind: 'snapshot', ageSec: 5, windows: { five_hour: { usedPercent: Number.NaN, resetsAt: IN_2H } } },
      NOW,
    )
    expect(malformed.status).toBe('unknown')
    expect(corroborated(malformed)).toBe(false)
  })

  it('an expired high window is gone: it does not corroborate', () => {
    const expired = classifyPlanHealth(
      {
        kind: 'snapshot',
        ageSec: 5,
        windows: {
          five_hour: { usedPercent: 99, resetsAt: Math.floor(NOW / 1000) - 60 },
          seven_day: { usedPercent: 10, resetsAt: IN_3D },
        },
      },
      NOW,
    )
    expect(corroborated(expired)).toBe(false)
  })
})

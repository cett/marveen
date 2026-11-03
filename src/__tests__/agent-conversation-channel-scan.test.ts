// channelBodies() finds <channel> envelopes in a transcript entry without an unbounded
// `[^>]*>` / `[\s\S]*?</channel>` pattern: openers by pattern, '>' and '</channel>' by indexOf
// whose result every later opener reuses. The old pattern was quadratic (one 550 kB line held
// the event loop for ~85 s).
import { describe, it, expect } from 'vitest'
import { channelBodies } from '../web/routes/agent-conversation.js'

// The pre-fix pattern, kept here as the oracle for the differential test only.
function oldBodies(text: string): string[] {
  const re = /<channel\b[^>]*>([\s\S]*?)<\/channel>/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1])
  return out
}

const BIG = 550_000
const BUDGET_MS = 300
const ENVELOPE = '<channel source="plugin:telegram:telegram" chat_id="42" message_id="7">hello</channel>'

function timeMs(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

describe('channelBodies', () => {
  const realistic = [
    '',
    'no envelope',
    ENVELOPE,
    `before ${ENVELOPE} middle ${ENVELOPE} after`,
    '<channel source="a">multi\nline\n</channel>',
    '<channel\n  source="a"\n  chat_id="1">x</channel>',
    '<channel source="a">unterminated body',
    '<channel source="a"',
    '<channel source="a">first</channel> <channel source="b">no closer',
    '<channel> bare </channel><channelization>word</channelization>',
    '<channel note="x > y">tail</channel>',
    'a > b < c <channel>nested <channel>inner</channel> outer</channel>',
  ]

  it('returns what the old pattern returned on realistic transcript entries', () => {
    for (const t of realistic) expect(channelBodies(t), t.slice(0, 40)).toEqual(oldBodies(t))
  })

  it('takes an attribute span of 1999 and 2000 characters, not 2001', () => {
    for (const [span, taken] of [[1999, true], [2000, true], [2001, false]] as const) {
      // The span runs from the end of the tag name to the '>'; the space after the name counts.
      const t = `<channel ${'a'.repeat(span - 1)}>body</channel>`
      expect(channelBodies(t), `span ${span}`).toEqual(taken ? ['body'] : [])
    }
  })

  it('still finds a real envelope after an over-long forged opener', () => {
    const forged = `<channel ${'f'.repeat(5000)} `
    expect(channelBodies(forged + ENVELOPE)).toEqual(['hello'])
  })

  it('stays linear on 550 kB of hostile shapes', () => {
    const shapes: Record<string, string> = {
      'openers, no gt': '<channel '.repeat(BIG / 9),
      'openers, one far gt': '<channel '.repeat(BIG / 9) + '>',
      'openers with gt, no closer': '<channel a="1"> '.repeat(BIG / 16),
      'over-long spans': ('<channel ' + 'z'.repeat(2100) + '>').repeat(BIG / 2110),
      'over-long spans with a closer': ('<channel ' + 'z'.repeat(2100) + '></channel>').repeat(BIG / 2120),
      'many closed envelopes': ENVELOPE.repeat(Math.floor(BIG / ENVELOPE.length)),
      'long whitespace after the name': '<channel' + ' '.repeat(BIG),
    }
    for (const [name, text] of Object.entries(shapes)) {
      expect(text.length, name).toBeGreaterThan(BIG * 0.98)
      expect(timeMs(() => channelBodies(text)), name).toBeLessThan(BUDGET_MS)
    }
  })
})

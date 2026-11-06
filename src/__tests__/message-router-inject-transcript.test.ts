// injectTranscript (message-router): the voice transcript replaces the body of the <channel> frame. The frame was found
// with /(<channel[^>]*>)[\s\S]*?(<\/channel>)/, which searched the rest of the text again from every opener without a
// '>' or a closer (quadratic: 550 kB took ~15 s). Only the opener is a pattern now; the '>' and the closer are looked
// up once. The old rule is kept here as the oracle for the differential test.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockWarn = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

import { injectTranscript } from '../web/message-router.js'

function oldInjectTranscript(content: string, transcript: string): string {
  let result = content
    .replace(/\s*attachment_kind="voice"/, '')
    .replace(/\s*attachment_file_id="[^"]*"/, '')
  result = result.replace(
    /(<channel[^>]*>)[\s\S]*?(<\/channel>)/,
    (_m, open: string, close: string) => `${open}\n[Hang \u00e1tirat]: ${transcript}\n${close}`,
  )
  return result
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ATOMS = ['<', '>', '/', ' ', '\t', '  \n ', 'channel', 'CHANNEL', '"', '\n', 'x', '<channel', '</channel>', '<channel a="1">', 'attachment_kind="voice"', ' attachment_file_id="f1"', 'attachment_file_id="', 'attachment_kind="voice', '$&', '$1']

function randomText(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 20)
  let s = ''
  for (let i = 0; i < n; i++) s += ATOMS[Math.floor(rnd() * ATOMS.length)]
  return s
}

function bestOf3Ms(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

const FRAME = (body: string) =>
  `<channel source="telegram" chat_id="100" message_id="7" user="u" attachment_kind="voice" attachment_file_id="file-1">\n${body}\n</channel>`
const EXPECTED_OPEN = '<channel source="telegram" chat_id="100" message_id="7" user="u">'

beforeEach(() => { mockWarn.mockClear() })

describe('injectTranscript: a normal voice frame', () => {
  it('replaces the body with the transcript and drops the two attachment attributes, nothing else', () => {
    expect(injectTranscript(FRAME('(voice message)'), 'hello there')).toBe(`${EXPECTED_OPEN}\n[Hang \u00e1tirat]: hello there\n</channel>`)
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it.each([
    ['empty body', ''],
    ['"(empty message)"', '(empty message)'],
    ['a caption', 'look at this'],
    ['several lines', 'line one\nline two\n\nline four'],
  ])('%s is replaced by the transcript', (_name, body) => {
    expect(injectTranscript(FRAME(body), 'T')).toBe(`${EXPECTED_OPEN}\n[Hang \u00e1tirat]: T\n</channel>`)
  })

  it('a transcript with $1, $&, $$ and $` stays literal', () => {
    const transcript = 'pay $1 and $& then $$ and $` and $\''
    expect(injectTranscript(FRAME('x'), transcript)).toBe(`${EXPECTED_OPEN}\n[Hang \u00e1tirat]: ${transcript}\n</channel>`)
  })

  it('only the FIRST frame is replaced; a second frame and the text around it are untouched', () => {
    const second = '<channel source="telegram" chat_id="200">\nstay\n</channel>'
    const out = injectTranscript(`pre ${FRAME('one')} mid ${second} post`, 'T')
    expect(out).toBe(`pre ${EXPECTED_OPEN}\n[Hang \u00e1tirat]: T\n</channel> mid ${second} post`)
  })

  it('the body ends at the FIRST </channel> after the opener', () => {
    const out = injectTranscript('<channel a="1">b1</channel>b2</channel>', 'T')
    expect(out).toBe('<channel a="1">\n[Hang \u00e1tirat]: T\n</channel>b2</channel>')
  })

  it('a ">" inside the body does not end the opener (the opener ends at the first ">")', () => {
    const out = injectTranscript('<channel a="1">x > y</channel>', 'T')
    expect(out).toBe('<channel a="1">\n[Hang \u00e1tirat]: T\n</channel>')
  })
})

describe('injectTranscript: no usable frame leaves the content unchanged and warns', () => {
  const ctx = { id: 501, agent: 'agent-a' }

  it('no closing </channel>: unchanged (attachment attributes included), one warning without the content', () => {
    const content = '<channel attachment_kind="voice" attachment_file_id="f1" chat_id="1">\nbody without a closer'
    expect(injectTranscript(content, 'T', ctx)).toBe(content)
    expect(mockWarn).toHaveBeenCalledTimes(1)
    const [fields, message] = mockWarn.mock.calls[0]
    expect(fields).toEqual({ id: 501, agent: 'agent-a' })
    expect(String(message)).not.toContain('body without a closer')
  })

  it('an over-long opener (more than 2000 characters before its ">"): unchanged + warning', () => {
    const content = `<channel ${'x'.repeat(2500)}>\nbody\n</channel>`
    expect(injectTranscript(content, 'T', ctx)).toBe(content)
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('an opener with no ">" at all: unchanged + warning', () => {
    const content = '<channel chat_id="1" attachment_kind="voice"'
    expect(injectTranscript(content, 'T', ctx)).toBe(content)
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('no <channel at all: unchanged + warning', () => {
    expect(injectTranscript('just text', 'T', ctx)).toBe('just text')
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('the span limit: 2000 characters before the ">" is a frame, 2001 is not', () => {
    const frame = (n: number) => `<channel ${'x'.repeat(n - 1)}>b</channel>`
    expect(injectTranscript(frame(2000), 'T')).toBe(`<channel ${'x'.repeat(1999)}>\n[Hang \u00e1tirat]: T\n</channel>`)
    expect(mockWarn).not.toHaveBeenCalled()
    expect(injectTranscript(frame(2001), 'T')).toBe(frame(2001))
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('the warning works without a context (the id and the agent are optional)', () => {
    expect(injectTranscript('no frame', 'T')).toBe('no frame')
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })
})

describe('injectTranscript: the old rule as the oracle', () => {
  it('matches the base implementation on 20000 random texts, wherever the old rule found a frame within the span limit', () => {
    const rnd = mulberry32(4242)
    let matched = 0
    for (let i = 0; i < 20_000; i++) {
      const text = randomText(rnd)
      const old = oldInjectTranscript(text, 'T$&')
      const found = /<channel[^>]*>[\s\S]*?<\/channel>/.test(text.replace(/\s*attachment_kind="voice"/, '').replace(/\s*attachment_file_id="[^"]*"/, ''))
      if (found) {
        matched++
        expect(injectTranscript(text, 'T$&'), JSON.stringify(text)).toBe(old)
      } else {
        // Where the old rule found no frame it returned the attribute-stripped text; the new code returns the text unchanged.
        expect(injectTranscript(text, 'T$&'), JSON.stringify(text)).toBe(text)
      }
    }
    expect(matched).toBeGreaterThan(1000) // the generator really reaches the frame branch
  })
})

describe('injectTranscript: linear on hostile input', () => {
  const BIG = 550_000
  const BUDGET_MS = 300

  it.each([
    ['openers with no ">"', '<channel '.repeat(Math.ceil(BIG / 9))],
    ['openers and one far ">" (no closer)', '<channel '.repeat(Math.ceil(BIG / 9)) + '>'],
    ['closed openers with no closer', '<channel a="1">'.repeat(Math.ceil(BIG / 15))],
    ['a frame head then openers', '<channel a="1">' + '<channel '.repeat(Math.ceil(BIG / 9))],
    ['one long attribute run', '<channel ' + 'x'.repeat(BIG)],
    // The attribute removal ran \s*<literal>: a run of whitespace was searched again from every position of the run.
    ['a run of spaces', ' '.repeat(BIG)],
    ['a run of whitespace then a frame', ' \t\n'.repeat(Math.ceil(BIG / 3)) + '<channel a="1">b</channel>'],
    ['many attachment_kind heads, no match', 'attachment_kind="voice'.repeat(Math.ceil(BIG / 22))],
    ['many attachment_file_id heads, no closing quote', 'attachment_file_id="'.repeat(Math.ceil(BIG / 20))],
  ])('%s: 550 kB in under 300 ms (best of 3)', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(BIG)
    const t = bestOf3Ms(() => { injectTranscript(text, 'T') })
    expect(t).toBeLessThan(BUDGET_MS)
  })

  it('the old rule on the same input is the regression evidence: at 80 kB it is more than 20x slower than the new one', () => {
    const text = '<channel '.repeat(Math.ceil(80_000 / 9))
    const tOld = bestOf3Ms(() => { oldInjectTranscript(text, 'T') })
    const tNew = bestOf3Ms(() => { injectTranscript(text, 'T') })
    expect(tOld).toBeGreaterThan(tNew * 20)
  })
})

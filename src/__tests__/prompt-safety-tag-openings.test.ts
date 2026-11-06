// tagOpenings: the shared, linear "find the tag openers and where each tag ends" helper behind the <channel> scrubs
// of the federation poller and the message router. The pattern it replaces, /<tag[^>]*>/, searches the rest of the
// text again from every opener that has no '>' after it (550 kB of openers: ~15 s).
import { describe, it, expect } from 'vitest'
import { tagOpenings, TAG_SPAN_MAX } from '../prompt-safety.js'

const OPENER = /<channel/g
const all = (text: string) => [...tagOpenings(text, OPENER)]

function bestOf3Ms(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

describe('tagOpenings', () => {
  it('reports the opener position, the end of the opener text, and the index just past the closing ">"', () => {
    const text = 'ab<channel x="1">body'
    expect(all(text)).toEqual([{ start: 2, openerEnd: 10, tagEnd: 17 }])
    expect(text.slice(0, 17)).toBe('ab<channel x="1">')
  })

  it('finds every opener, left to right, openers inside an earlier tag included', () => {
    const text = '<channel <channel a>x<channel b>'
    expect(all(text).map(o => o.start)).toEqual([0, 9, 21])
    // The first two share one ">" (the tag spans both openers); the caller decides to skip the inner one.
    expect(all(text).map(o => o.tagEnd)).toEqual([20, 20, 32])
  })

  it('no opener: nothing', () => {
    expect(all('plain text > with a gt')).toEqual([])
    expect(all('')).toEqual([])
  })

  it('an opener at the very end of the text has no ">": tagEnd -1', () => {
    expect(all('text <channel')).toEqual([{ start: 5, openerEnd: 13, tagEnd: -1 }])
  })

  it('the ">" must be within TAG_SPAN_MAX characters of the end of the opener: 1999 / 2000 / 2001', () => {
    expect(TAG_SPAN_MAX).toBe(2000)
    const at = (n: number) => `<channel${'x'.repeat(n)}>`
    expect(all(at(1999))[0].tagEnd).toBe(8 + 1999 + 1)
    expect(all(at(2000))[0].tagEnd).toBe(8 + 2000 + 1)
    expect(all(at(2001))[0].tagEnd).toBe(-1)
  })

  it('an over-long opener does not hide a later, short one that has its own ">"', () => {
    const text = `<channel${'x'.repeat(3000)}<channel a="1">`
    const [first, second] = all(text)
    expect(first.tagEnd).toBe(-1)
    // The later opener is within the span of the same ">": it is a tag of its own.
    expect(second.tagEnd).toBe(text.length)
  })

  it('a ">" before an opener is not its closing ">"', () => {
    const [o] = all('a>b<channel')
    expect(o.tagEnd).toBe(-1)
  })

  it('works on a case-insensitive, space-tolerant opener pattern with a lookahead', () => {
    const rx = /<(?:\s*\/)?\s*channel\b/gi
    const found = [...tagOpenings('< / CHANNEL x> <channelx> <channel-x>', rx)]
    expect(found.map(o => o.start)).toEqual([0, 26])
  })

  it('is lazy: taking the first opener of a huge text does not walk the rest', () => {
    const big = '<channel '.repeat(60_000)
    const t = bestOf3Ms(() => { tagOpenings(big, OPENER).next() })
    expect(t).toBeLessThan(50)
  })

  it('is linear on 550 kB of openers with no ">" (under 300 ms, best of 3)', () => {
    const big = '<channel '.repeat(Math.ceil(550_000 / 9))
    const t = bestOf3Ms(() => { for (const o of tagOpenings(big, OPENER)) void o.tagEnd })
    expect(t).toBeLessThan(300)
  })

  it('is linear when every opener is followed by a far ">"', () => {
    const big = '<channel '.repeat(Math.ceil(550_000 / 9)) + '>'
    const t = bestOf3Ms(() => { for (const o of tagOpenings(big, OPENER)) void o.tagEnd })
    expect(t).toBeLessThan(300)
  })
})

// stripMarkup / stripAngleTags / literalBlocks are linear: the openers are found by a pattern
// (or indexOf) and the closer is looked up once and reused. The patterns they replace
// (/<script[\s\S]*?<\/script>/gi, /<style...>/gi, /<[^>]+>/g, /<tag>([\s\S]*?)<\/tag>/g) were
// quadratic on text made of openers and no closer (500 KB of `<a ` took ~35 s).
// The old patterns stay here as the oracle for the differential tests.
import { describe, it, expect } from 'vitest'
import { stripMarkup, stripAngleTags, literalBlocks, decodeEntities } from '../web/import-utils.js'

function oldStripMarkup(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function oldBlocks(text: string, tag: string, limit = Infinity): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while (out.length < limit && (m = re.exec(text)) !== null) out.push(m[1])
  return out
}

const BIG = 550_000
const BUDGET_MS = 300

function timeMs(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

// Deterministic pseudo-random text over the tokens that matter to these patterns.
function fuzz(seed: number, tokens: string[], count: number): string {
  let s = seed
  let out = ''
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out += tokens[s % tokens.length]
  }
  return out
}

const REALISTIC = [
  '',
  'plain text only',
  '<p>Hello <b>world</b></p>',
  '<html><head><style>p{color:red}</style><script>var a = "<b>";</script></head><body>x</body></html>',
  '<SCRIPT type="x">a</SCRIPT>text<Style>b</STYLE>',
  '<script>unclosed script <b>bold</b>',
  '<script>a</script><script>b',
  '<scripts>not a script</script>',
  '<script><script>nested</script> after </script> tail',
  'a < b and c > d',
  '<>',
  '<><a>',
  '<<a>>',
  'x <a <b> y',
  '<a\nmulti\nline>tail',
  'unterminated <a',
  '&lt;script&gt;kept&lt;/script&gt; <i>x</i> &ouml;',
  '<svg><path d="M0 0"/></svg>',
]

describe('stripMarkup', () => {
  it('gives what the old patterns gave on realistic input', () => {
    for (const t of REALISTIC) expect(stripMarkup(t), t.slice(0, 40)).toBe(oldStripMarkup(t))
  })

  it('gives what the old patterns gave on 3000 random strings over the tokens that matter', () => {
    const tokens = ['<', '>', '<script', '</script>', '<style', '</style>', '</', 'a', ' ', '/', '<SCRIPT', '</STYLE>', '&amp;', '\n']
    for (let seed = 1; seed <= 3000; seed++) {
      const t = fuzz(seed, tokens, 1 + (seed % 14))
      expect(stripMarkup(t), JSON.stringify(t)).toBe(oldStripMarkup(t))
    }
  })

  it('stays linear on 550 kB of hostile shapes', () => {
    const shapes: Record<string, string> = {
      'script openers, no closer': '<script '.repeat(BIG / 8),
      'style openers, no closer': '<style '.repeat(BIG / 7),
      'script openers, closer at the end': '<script '.repeat(BIG / 8) + '</script>',
      'angle openers, no gt': '<a '.repeat(BIG / 3),
      'angle openers, one far gt': '<a '.repeat(BIG / 3) + '>',
      'empty tags': '<>'.repeat(BIG / 2),
      'closed scripts': '<script>x</script>'.repeat(BIG / 18),
      'closed tags': '<a>'.repeat(BIG / 3),
      'mixed openers': '<script <style <a '.repeat(BIG / 17),
    }
    for (const [name, text] of Object.entries(shapes)) {
      expect(text.length, name).toBeGreaterThan(BIG * 0.98)
      expect(timeMs(() => stripMarkup(text)), name).toBeLessThan(BUDGET_MS)
    }
  })
})

describe('stripAngleTags', () => {
  it('matches replace(/<[^>]+>/g, " ") on random strings', () => {
    const tokens = ['<', '>', 'a', ' ', '<>', 'b']
    for (let seed = 1; seed <= 3000; seed++) {
      const t = fuzz(seed, tokens, seed % 16)
      expect(stripAngleTags(t), JSON.stringify(t)).toBe(t.replace(/<[^>]+>/g, ' '))
    }
  })
})

describe('literalBlocks', () => {
  it('matches the old [\\s\\S]*? pattern, whole and limited to the first block', () => {
    const tokens = ['<item>', '</item>', '<title>', '</title>', 'x', ' ', '<', '>']
    for (let seed = 1; seed <= 3000; seed++) {
      const t = fuzz(seed, tokens, seed % 14)
      expect(literalBlocks(t, '<item>', '</item>'), JSON.stringify(t)).toEqual(oldBlocks(t, 'item'))
      expect(literalBlocks(t, '<title>', '</title>', 1), JSON.stringify(t)).toEqual(oldBlocks(t, 'title', 1))
    }
  })

  it('stays linear on 550 kB of openers, with and without a closer', () => {
    for (const text of ['<item>'.repeat(BIG / 6), '<item>'.repeat(BIG / 6) + '</item>', '<item>x</item>'.repeat(BIG / 14)]) {
      expect(timeMs(() => literalBlocks(text, '<item>', '</item>'))).toBeLessThan(BUDGET_MS)
      expect(timeMs(() => literalBlocks(text, '<title>', '</title>', 1))).toBeLessThan(BUDGET_MS)
    }
  })
})

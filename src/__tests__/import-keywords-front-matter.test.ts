// extractKeywords (import-crawler): the YAML front matter `tags: [..]` is read linearly and only from the front matter.
// The pattern it replaces, /^---[\s\S]*?tags:\s*\[([^\]]+)\][\s\S]*?---/i, retried both lazy spans from every
// `tags: [` that had no `]` or no later `---` (quadratic: 550 kB took ~17 s), and it also accepted a `tags: [..]`
// from anywhere after the first `---`, i.e. from the document body. The old rule is kept as the oracle.
import { describe, it, expect } from 'vitest'
import { basename, extname } from 'node:path'
import { extractKeywords } from '../web/import-crawler.js'

/** extractKeywords of the base commit, verbatim. */
function oldExtractKeywords(content: string, fileName: string): string {
  const fmMatch = content.match(/^---[\s\S]*?tags:\s*\[([^\]]+)\][\s\S]*?---/i)
  if (fmMatch) {
    return fmMatch[1].replace(/['"\s]/g, '').replace(/,/g, ', ').trim()
  }
  const stem = basename(fileName, extname(fileName))
  const words = content
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 20)
  if (stem) words.unshift(stem)
  return [...new Set(words)].slice(0, 20).join(', ')
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

/** Best of three CPU times (user + system, ms) of `fn` in this process. The cost bounds are CPU time, not wall clock:
 *  with parallel workers the wall clock mostly counts the time the process was NOT running, so a wall-clock bound is
 *  flaky exactly when the machine is busy. A quadratic regression is seconds to minutes of CPU time, however busy the
 *  machine. */
function bestOf3CpuMs(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const before = process.cpuUsage()
    fn()
    const used = process.cpuUsage(before)
    best = Math.min(best, (used.user + used.system) / 1000)
  }
  return best
}

/** The vitest default test timeout (15 s) is wall clock too: the old rule on 80 kB takes about 0.3 s of CPU, but 7-8 s
 *  of wall time per run with 60 busy loops on 10 cores, three runs in one test. The CPU bounds are the regression
 *  guard; this per-test timeout only has to be out of the way. */
const PERF_TEST_TIMEOUT_MS = 120_000

describe('extractKeywords: front matter tags', () => {
  it.each([
    ['plain', '---\ntitle: X\ntags: [alpha, beta, gamma]\n---\nbody', 'alpha, beta, gamma'],
    ['quoted', '---\ntags: ["alpha", \'beta\', "gamma delta"]\n---\nbody', 'alpha, beta, gammadelta'],
    ['one tag', '---\ntags: [solo]\n---\n', 'solo'],
    ['tags first, more keys after', '---\ntags: [a, b]\ntitle: T\ndate: 2026-01-01\n---\nbody', 'a, b'],
    ['upper case key', '---\nTAGS: [Up, Low]\n---\nbody', 'Up, Low'],
    ['spaces and a newline between the colon and the bracket', '---\ntags:  \n  [a, b]\n---\nbody', 'a, b'],
    ['CRLF line ends', '---\r\ntitle: X\r\ntags: [a, b]\r\n---\r\nbody', 'a, b'],
    ['the first non-empty tags list wins over an empty one before it', '---\ntags: []\ntags: [late]\n---\nbody', 'late'],
    ['tags between other keys', '---\ntitle: X\ntags: [a, b]\nauthor: Y\n---\nbody', 'a, b'],
  ])('%s', (_name, md, expected) => {
    expect(extractKeywords(md, 'doc.md')).toBe(expected)
    expect(oldExtractKeywords(md, 'doc.md')).toBe(expected) // the base agrees on every proper front matter
  })

  it('a front matter without tags falls back to the first words and the file name stem', () => {
    const md = '---\ntitle: Release notes\nauthor: someone\n---\nfirst second third'
    const kw = extractKeywords(md, 'notes.md')
    expect(kw.split(', ')[0]).toBe('notes')
    expect(kw).toContain('first')
  })

  it('a `tags: [..]` in the BODY is no longer a keyword source (the base took it); the fallback applies', () => {
    const md = '---\ntitle: X\n---\nsome text\ntags: [body, only]\nmore\n---\n'
    expect(oldExtractKeywords(md, 'doc.md')).toBe('body, only')
    const kw = extractKeywords(md, 'doc.md')
    expect(kw).not.toBe('body, only')
    expect(kw.split(', ')[0]).toBe('doc')
  })

  it('no front matter at all: a `tags: [..]` anywhere is not a source, the fallback applies', () => {
    const md = 'plain text\ntags: [x, y]\n---\n'
    expect(extractKeywords(md, 'plain.md').split(', ')[0]).toBe('plain')
    expect(extractKeywords(md, 'plain.md')).not.toBe('x, y')
  })

  it('an opening `---` with no closing fence is not a front matter block', () => {
    const md = '---\ntags: [a, b]\nstill going, no closer'
    expect(extractKeywords(md, 'open.md').split(', ')[0]).toBe('open')
  })

  it('an unclosed bracket in the front matter ends the search, the fallback applies', () => {
    const md = '---\ntags: [a, b\n---\nbody words here'
    expect(extractKeywords(md, 'doc.md').split(', ')[0]).toBe('doc')
  })

  it('the fallback (20 tokens plus the file name stem) is unchanged for content with no front matter', () => {
    const content = Array.from({ length: 40 }, (_v, i) => `word${i}`).join(' ')
    expect(extractKeywords(content, 'stem.txt')).toBe(oldExtractKeywords(content, 'stem.txt'))
    expect(extractKeywords(content, 'stem.txt').split(', ').length).toBe(20)
  })
})

describe('extractKeywords: the old rule as the oracle', () => {
  const FM_LINES = [
    'title: X', 'draft: true', 'tags: [a, b]', 'tags: ["q", \'r\']', 'tags: []', 'tags:  [ z ]', 'TAGS: [up]', 'tags: [one two, three]',
    'tags: [x', 'tags:', 'date: 2026-01-01', '', 'tags: [with-dash, under_score]',
  ]
  const BODY_WORDS = ['alpha', 'beta', 'gamma', 'text', 'more', 'lines', '---', 'x', '[', ']']

  it('a proper front matter (body without a `tags:`) gives the base answer on 20000 random files', () => {
    const rnd = mulberry32(4242)
    let withTags = 0
    for (let i = 0; i < 20_000; i++) {
      const lines: string[] = []
      const n = Math.floor(rnd() * 6)
      for (let j = 0; j < n; j++) lines.push(FM_LINES[Math.floor(rnd() * FM_LINES.length)])
      const nl = rnd() < 0.2 ? '\r\n' : '\n'
      const body = Array.from({ length: Math.floor(rnd() * 8) }, () => BODY_WORDS[Math.floor(rnd() * BODY_WORDS.length)]).join(' ')
      const md = ['---', ...lines, '---', body].join(nl)
      // A `]`-less `tags: [x` line can swallow lines up to a later `]`; the base then reads across the fence. Skip
      // only those: they are the documented difference (a list that does not close inside the front matter).
      const fmText = lines.join(nl)
      const closesInside = !/tags:\s*\[[^\]]*$/i.test(fmText) || /\]/.test(fmText.slice(fmText.search(/tags:\s*\[[^\]]*$/i)))
      if (!closesInside) continue
      if (/tags:\s*\[[^\]]+\]/i.test(fmText)) withTags++
      expect(extractKeywords(md, 'f.md'), JSON.stringify(md)).toBe(oldExtractKeywords(md, 'f.md'))
    }
    expect(withTags).toBeGreaterThan(3000)
  })

  it('chaos: a new answer that differs from the base is only ever a fallback where the base matched a tags list outside the front matter', () => {
    const ATOMS = ['---', '\n', 'tags:', ' [', ']', 'a, b', '---\n', 'tags: [x]', 'body', '\r\n', ' ', 'TAGS: [Y]', '[', 'tags: []']
    const rnd = mulberry32(99)
    let differing = 0
    for (let i = 0; i < 20_000; i++) {
      const n = 1 + Math.floor(rnd() * 16)
      let s = ''
      for (let j = 0; j < n; j++) s += ATOMS[Math.floor(rnd() * ATOMS.length)]
      const now = extractKeywords(s, 'f.md')
      const before = oldExtractKeywords(s, 'f.md')
      if (now !== before) {
        differing++
        // The base only ever answered differently by reading a tags list out of a text that is not a front matter
        // block: either it does not start with `---`... or the list is not inside the block.
        expect(/^---[\s\S]*?tags:\s*\[([^\]]+)\][\s\S]*?---/i.test(s), JSON.stringify(s)).toBe(true)
      }
    }
    expect(differing).toBeGreaterThan(100) // the generator does reach the changed cases
  })
})

describe('extractKeywords: linear on hostile input', () => {
  const BIG = 550_000
  // CPU time of the worst input here: 16 ms on an idle machine, 31 ms with 60 busy loops on 10 cores.
  // 100 ms is 3-6x the real cost at worst, and the quadratic rule needs seconds to minutes on the same input.
  const CPU_BUDGET_MS = 100

  it.each([
    ['front matter, many `tags: [a` with no `]`', '---\n' + 'tags: [a'.repeat(Math.ceil(BIG / 8)) + '\n---'],
    ['front matter, many `tags:` + long space runs', '---\n' + ('tags:' + ' '.repeat(995)).repeat(Math.ceil(BIG / 1000)) + '\n---'],
    ['front matter, one `tags:` + a huge space run', '---\ntags:' + ' '.repeat(BIG) + '\n---'],
    ['front matter, many empty `tags: []`', '---\n' + 'tags: []'.repeat(Math.ceil(BIG / 8)) + '\n---'],
    ['front matter, `tags: [` openers and one far `]`', '---\n' + 'tags: ['.repeat(Math.ceil(BIG / 7)) + ']\n---'],
    ['no front matter, many `tags: [a`', 'tags: [a'.repeat(Math.ceil(BIG / 8))],
    ['no closing fence', '---\n' + 'tags: [a'.repeat(Math.ceil(BIG / 8))],
    ['dashes only', '-'.repeat(BIG)],
    ['many fences', '---\n'.repeat(Math.ceil(BIG / 4))],
    ['front matter, a huge tags list', '---\ntags: [' + 'tag, '.repeat(Math.ceil(BIG / 5)) + 'end]\n---\nbody'],
  ])('%s: 550 kB in under 100 ms of CPU (best of 3)', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(BIG - 10)
    const t = bestOf3CpuMs(() => { extractKeywords(text, 'f.md') })
    expect(t, `${Math.round(t * 10) / 10} ms of CPU`).toBeLessThan(CPU_BUDGET_MS)
  }, PERF_TEST_TIMEOUT_MS)

  it('the old rule on the same input is the regression evidence: at 80 kB it is more than 20x slower than the new one', () => {
    const text = '---\n' + 'tags: [a'.repeat(Math.ceil(80_000 / 8)) + '\n---'
    const tOld = bestOf3CpuMs(() => { oldExtractKeywords(text, 'f.md') })
    const tNew = bestOf3CpuMs(() => { extractKeywords(text, 'f.md') })
    // CPU time, with a 1 ms floor under the new one: a sub-millisecond reading is mostly timer and GC noise.
    expect(tOld, `old ${Math.round(tOld)} ms, new ${Math.round(tNew * 10) / 10} ms of CPU`).toBeGreaterThan(Math.max(tNew, 1) * 20)
  }, PERF_TEST_TIMEOUT_MS)
})

// formatForTelegram: the fenced-block extraction and the [text](url) conversion run in linear time, and give the output
// the regex versions gave. The old pattern /```(\w*)\n?([\s\S]*?)```/g was quadratic on an opening fence with no closing
// one followed by a long word, and /\[(.+?)\]\((.+?)\)/g was quadratic (cubic with `](` and no `)`) on a line full of `[`.
// The agent text that goes through it can carry text echoed from a web page or a peer, and it runs on the event loop.
// The old function is kept below as `legacyFormatForTelegram`, verbatim, so the new one is compared with it.

import { describe, it, expect } from 'vitest'
import { escapeHtml, formatForTelegram } from '../format.js'

const BOX_EMPTY = String.fromCharCode(0x2610)
const BOX_DONE = String.fromCharCode(0x2611)
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const NEL = String.fromCharCode(0x85)

// The function as it was before the change (only the two box characters are written as code points).
function legacyFormatForTelegram(text: string): string {
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length
    const escaped = escapeHtml(code.trimEnd())
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    return `\x00CB${idx}\x00`
  })
  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00IC${idx}\x00`
  })
  result = escapeHtml(result)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
  result = result.replace(/^- \[ \]/gm, BOX_EMPTY)
  result = result.replace(/^- \[x\]/gm, BOX_DONE)
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)])
  return result.trim()
}

// A small seeded generator (mulberry32): the same texts on every run.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The pieces the brief names, plus the characters the escape and the line rules care about. The words cover both ends of
// every \w range (a z A Z 0 9 _) so a wrong language class shows.
const PIECES = [
  '```', '```', '```', '`', '`', '**', '__', '~~', '*', '_', '[', '[', ']', ']', '(', '(', ')', ')', '#', '-', ' ', ' ', ' ',
  '\n', '\n', '\n', '\r', LS, PS, NEL, '\t', '<', '>', '&', 'word', 'x', 'js', 'ts', 'a', 'z', 'A', 'Z', '0', '9', '_x', 'ab_9Z',
  '](', '[ ]', '- [ ]', '- [x]', '---', '***', 'http://x.y/z?q=1&r=2',
]

function randomText(next: () => number, pieces: number): string {
  let s = ''
  for (let i = 0; i < pieces; i++) s += PIECES[Math.floor(next() * PIECES.length)]
  return s
}

const same = (text: string): void => {
  expect(formatForTelegram(text)).toBe(legacyFormatForTelegram(text))
}

describe('formatForTelegram: same output as the regex version', () => {
  it('24000 random texts of 1 to 60 pieces', () => {
    const next = rng(20261106)
    for (let i = 0; i < 24000; i++) {
      const text = randomText(next, 1 + Math.floor(next() * 60))
      const got = formatForTelegram(text)
      const want = legacyFormatForTelegram(text)
      if (got !== want) expect(got, JSON.stringify(text)).toBe(want)
    }
  })

  it('3000 longer random texts of 200 to 400 pieces', () => {
    const next = rng(7)
    for (let i = 0; i < 3000; i++) {
      const text = randomText(next, 200 + Math.floor(next() * 200))
      const got = formatForTelegram(text)
      const want = legacyFormatForTelegram(text)
      if (got !== want) expect(got, JSON.stringify(text)).toBe(want)
    }
  })

  it('4000 random texts made only of the fence, link and line pieces (the dense cases)', () => {
    const next = rng(99)
    const dense = ['```', '`', '[', ']', '(', ')', '](', 'a', 'js', ' ', '\n', '\r', LS]
    for (let i = 0; i < 4000; i++) {
      let text = ''
      const n = 1 + Math.floor(next() * 40)
      for (let k = 0; k < n; k++) text += dense[Math.floor(next() * dense.length)]
      const got = formatForTelegram(text)
      const want = legacyFormatForTelegram(text)
      if (got !== want) expect(got, JSON.stringify(text)).toBe(want)
    }
  })

  it('the plain markdown the tests of this file already had', () => {
    for (const text of ['# Cim', 'ez **vastag** szoveg', 'ez *dolt* szoveg', 'a `parancs` kod', '[szoveg](https://pelda.hu)', 'ez ~~torolt~~ szoveg', '- [ ] a\n- [x] b']) same(text)
  })
})

describe('fenced blocks', () => {
  const CASES: Array<[string, string]> = [
    ['with a language', '```js\nconsole.log(1)\n```'],
    ['without a language', '```\ncode\n```'],
    ['the language right against the fence', '```js```'],
    ['no newline after the language', '```jscode```'],
    ['an empty block', '``````'],
    ['an empty block with a newline', '```\n```'],
    ['a language and nothing else', '```js\n```'],
    ['two newlines after the fence: only the first is dropped', '```\n\ncode\n```'],
    ['CRLF: the carriage return stays in the body', '```ts\r\ncode\r\n```'],
    ['a language with every kind of word character', '```aZ09_\nx\n```'],
    ['a language that stops at a hyphen', '```c-sharp\nx\n```'],
    ['four backticks', '````x```'],
    ['five backticks', '`````'],
    ['six backticks', '``````'],
    ['seven backticks', '```````'],
    ['an unclosed fence', 'before ```js\nnever closed'],
    ['an unclosed fence at the very end', 'text ```'],
    ['a fence at the end after a closed block', '```a```\n```'],
    ['two blocks and text between', 'one ```a\nx\n``` two ```b\ny\n``` three'],
    ['an odd number of fences', '```a``` ```b``` ```c'],
    ['a block with html in it', '```\n<b>&amp;</b>\n```'],
    ['trailing whitespace in the body', '```\ncode   \n\n  \n```'],
    ['an inline code next to a block', '`i` ```\nb\n``` `j`'],
    ['an inline code inside a block', '```\n`inner`\n```'],
    ['a fence inside an inline-looking span', '`a ``` b`'],
    ['markdown inside a block stays as it is', '```\n**not bold** [not](link)\n```'],
  ]
  it.each(CASES)('%s', (_name, text) => same(text))

  it('the language class: the first character outside [A-Za-z0-9_] ends the language', () => {
    for (let c = 0; c < 256; c++) same('```a' + String.fromCharCode(c) + 'b\nx\n```')
  })

  it('a text that holds the placeholder of a block is handled as before (pinned, with and without real blocks)', () => {
    same('\x00CB0\x00')
    same('\x00CB0\x00 ```a\nx\n```')
    same('```a\nx\n``` \x00CB0\x00 \x00CB1\x00')
    same('\x00IC0\x00 `i`')
  })

  it('a block comes out as <pre> with the escaped body', () => {
    expect(formatForTelegram('```js\n<x> & y\n```')).toBe('<pre><code class="language-js">&lt;x&gt; &amp; y</code></pre>')
    expect(formatForTelegram('```\nplain\n```')).toBe('<pre>plain</pre>')
  })
})

describe('links', () => {
  const CASES: Array<[string, string]> = [
    ['a link', '[a](b)'],
    ['text around', 'x [a](b) y [c](d) z'],
    ['empty text is not a link', '[](x)'],
    ['empty text, then a link', '[](x)](y)'],
    ['empty url is not a link', '[a]()'],
    ['empty url, then a closing paren', '[a]())'],
    ['a one-character url', '[a](b)'],
    ['no closing paren', '[a](b'],
    ['no url', '[a]'],
    ['a bracket inside the text', '[a[b](c)'],
    ['nested brackets', '[[a](b)](c)'],
    ['a pair-looking text', '[a](](b)'],
    ['two parens', '[a](b)(c)'],
    ['the text holds a ](', '[a](b](c)'],
    ['a url with parens', '[a](b(c))'],
    ['several openers, one pair', '[a [b [c](d)'],
    ['the first opener has the pair, a later one has none', '[a](b) [c]'],
    ['the line ends before the url closes', '[a](b\n)'],
    ['the line ends inside the text', '[a\n](b)'],
    ['a carriage return ends the line', '[a](b\r)'],
    ['a line separator ends the line', `[a](b${LS})`],
    ['a paragraph separator ends the line', `[a](b${PS})`],
    ['a next-line character does not end a line', `[a](b${NEL})`],
    ['each line has its own link', '[a](b)\n[c](d)\r[e](f)'],
    ['a link after a failed line', '[a](b\n[c](d)'],
    ['html in the link is escaped first', '[<a>](http://x/?a=1&b=2)'],
  ]
  it.each(CASES)('%s', (_name, text) => same(text))

  it('a link comes out as an anchor', () => {
    expect(formatForTelegram('[szoveg](https://pelda.hu)')).toBe('<a href="https://pelda.hu">szoveg</a>')
  })

  it('lines of 4095, 4096 and 4097 characters (and a long one) come out as the regex version gave them', () => {
    for (const len of [4095, 4096, 4097, 20000]) {
      const filler = 'x'.repeat(len)
      same('[' + filler + '](u)')
      same('[a](' + filler + ')')
      same('[a](' + filler)
      same('[' + filler + '](u) [' + filler + '](v)')
      same('**' + filler + '** and _' + filler + '_ and ~~' + filler + '~~')
    }
  })
})

describe('time on hostile text (best of 3, 550 kB)', () => {
  const SIZE = 550_000
  const rep = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
  const SHAPES: Array<[string, string]> = [
    ['one opening fence and a long word', '```' + rep('a', SIZE)],
    ['one opening fence and a long word, then a line', '```' + rep('ab', SIZE / 2) + '\nx'],
    ['repeated ```a', rep('```a', SIZE)],
    ['repeated "``` x" lines', rep('``` x\n', SIZE)],
    ['an odd run of backticks', rep('`', SIZE | 1)],
    ['** and a long line, no closer', '**' + rep('a', SIZE)],
    ['repeated "** "', rep('** ', SIZE)],
    ['repeated "__a"', rep('__a', SIZE)],
    ['repeated "~~ "', rep('~~ ', SIZE)],
    ['[ and a long line, no ](', '[' + rep('a', SIZE)],
    ['repeated "[a" on one line', rep('[a', SIZE)],
    ['repeated "[a](" on one line, no )', rep('[a](', SIZE)],
    ['repeated "[a]" on one line, no (', rep('[a]', SIZE)],
    ['repeated "[a](b" on one line, no )', rep('[a](b', SIZE)],
    ['repeated "[a](b)" on one line (all links)', rep('[a](b)', SIZE)],
    ['repeated "[](" on one line', rep('[](', SIZE)],
    ['repeated "*a" on one line', rep('*a', SIZE)],
    ['repeated "_a" on one line', rep('_a', SIZE)],
    ['repeated "*a**" on one line', rep('*a**', SIZE)],
    ['snake_case words on one line', rep('foo_bar_baz ', SIZE)],
    ['# and a long run of spaces', '#' + rep(' ', SIZE) + '\n'],
    ['repeated "#\\n"', rep('#\n', SIZE)],
    ['repeated "[a](" lines', rep('[a](\n', SIZE)],
  ]
  it.each(SHAPES)('%s', (_name, text) => {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      formatForTelegram(text)
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(300)
  })
})

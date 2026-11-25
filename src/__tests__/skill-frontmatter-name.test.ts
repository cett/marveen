// frontmatterName (src/web/skill-frontmatter-name.ts): the linear read of a skill's `name:` must give EXACTLY what the two regular
// expressions it replaced gave, and must not depend on the shape of the text.
//
//   - DIFFERENTIAL: the legacy pair below is the reference; both run on fixed edge cases and on 30 000 generated texts built from the
//     tokens that matter (name:, quotes, spaces, every line terminator, ---). Any difference fails with the text.
//   - TIME: the shape that cost 3.4 s (a `name:` line, a long whitespace run, then a character) and its relatives finish in
//     milliseconds. Mutant: put the legacy pair back as the implementation and the TIME cells go red (seconds, past the limit).
import { describe, it, expect } from 'vitest'
import { frontmatterName } from '../web/skill-frontmatter-name.js'

// the reference: what hooks-tenant.ts did before
const LEGACY_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/
function legacy(content: string | null): string | null {
  const m = LEGACY_FRONTMATTER.exec(content ?? '')
  if (!m) return null
  const nm = /^name:\s*(.+?)\s*$/m.exec(m[1]!)
  return nm ? nm[1]!.trim().replace(/^["']+|["']+$/g, '') : null
}

const fm = (...lines: string[]): string => `---\n${lines.join('\n')}\n---\nbody`

describe('frontmatterName: the same answers as the regular expressions it replaced', () => {
  const FIXED: Array<[string, string | null]> = [
    ['a plain name', fm('name: demo')],
    ['a quoted name', fm('name: "demo"')],
    ['single quotes', fm("name: 'demo'")],
    ['unbalanced quote', fm('name: "demo')],
    ['trailing spaces', fm('name: demo   ')],
    ['tabs', fm('name:\tdemo\t')],
    ['no space after the colon', fm('name:demo')],
    ['other keys around it', fm('description: x', 'name: demo', 'tools: y')],
    ['name after a description', fm('description: name: nope', 'name: yes')],
    ['an indented name is not a name line', fm('  name: demo')],
    ['the value on the next line', '---\nname:\n  demo\n---\n'],
    ['the value two lines down', '---\nname:\n\n  demo\n---\n'],
    ['an empty name, then a later one', fm('name:', 'name: second')],
    ['only whitespace after the colon', fm('name:   ')],
    ['only line breaks after the colon', '---\nname:\n---\n'],
    ['whitespace then the end of the block', '---\nname:  \n\n---\n'],
    ['a CR in the value', '---\nname: a\rb\n---\n'],
    ['U+2028 in the value', '---\nname: a\u2028b\n---\n'],
    ['U+2029 in the value', '---\nname: a\u2029b\n---\n'],
    ['CRLF line ends', '---\r\nname: demo\r\n---\r\n'],
    ['no closing fence', '---\nname: demo\n'],
    ['no opening fence', 'name: demo\n---\n'],
    ['leading blank line', '\n---\nname: demo\n---\n'],
    ['spaces after the opening fence', '---   \nname: demo\n---\n'],
    ['empty content', ''],
    ['two name lines', fm('name: one', 'name: two')],
    ['a name line that is only quotes', fm('name: ""')],
    ['non-breaking space', fm('name:\u00a0demo\u00a0')],
  ]
  it.each(FIXED)('%s', (_name, text) => {
    expect(frontmatterName(text)).toBe(legacy(text))
  })

  it('null content', () => {
    expect(frontmatterName(null)).toBe(legacy(null))
  })

  it('30 000 generated texts give the same answer', () => {
    // a small deterministic generator (no dependency, the same texts on every run)
    let seed = 0x2545f491
    const next = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n }
    const TOKENS = ['name:', 'name:', 'name: ', ' ', ' ', '  ', '\t', '\n', '\n', '\r', '\r\n', '\u2028', '\u2029', '\u00a0', '"', "'", 'a', 'b', 'demo', '---', '\n---', 'description:', 'x y', ':']
    for (let i = 0; i < 30000; i++) {
      let s = next(4) === 0 ? '' : '---\n'
      const n = next(14)
      for (let j = 0; j < n; j++) s += TOKENS[next(TOKENS.length)]
      if (next(3) !== 0) s += '\n---\ntail'
      const got = frontmatterName(s)
      const want = legacy(s)
      if (got !== want) throw new Error(`differs on ${JSON.stringify(s)}: got ${JSON.stringify(got)}, the legacy pair gave ${JSON.stringify(want)}`)
    }
  })
})

describe('frontmatterName: linear time, whatever the shape of the text', () => {
  const N = 200_000
  const sp = ' '.repeat(N)
  const SHAPES: Array<[string, string]> = [
    ['a name, a long whitespace run, then a character (the 3.4 s shape)', `---\nname: x${sp}y\n---\n`],
    ['the same with tabs', `---\nname: x${'\t'.repeat(N)}y\n---\n`],
    ['a long whitespace run before the value', `---\nname:${sp}x\n---\n`],
    ['only whitespace after the colon', `---\nname:${sp}\n---\n`],
    ['whitespace runs on many lines', `---\n${(`name: a${' '.repeat(50)}b\n`).repeat(4000)}---\n`],
    ['many name lines that have no value', `---\n${'name:\n'.repeat(N / 6)}---\n`],
    ['a long whitespace run after the opening fence', `---${sp}x\n---\n`],
    ['no closing fence, long block', `---\nname: a${sp}`],
    ['a very long value', `---\nname: ${'a'.repeat(N)}\n---\n`],
    ['whitespace runs of non-breaking spaces', `---\nname: x${'\u00a0'.repeat(N)}y\n---\n`],
  ]
  it.each(SHAPES)('%s', (_n, text) => {
    const t0 = performance.now()
    frontmatterName(text)
    expect(performance.now() - t0).toBeLessThan(250)
  })
})

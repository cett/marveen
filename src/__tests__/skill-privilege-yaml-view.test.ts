// The privilege gate reads the frontmatter two ways: the original line scanner and a js-yaml load, and a privilege key either
// one sees counts. The scanner alone could be hidden from: a block scalar with an indented `---` line closes its head early,
// a quoted key or a flow mapping is not a bare token to it, and a BOM is trimmed away. The skill loader is Claude Code
// itself, so the gate has to be at least as suspicious as any reasonable reader. Where the readers disagree where the head
// ends, or the head cannot be parsed safely, any edit of the head counts. The A to D and H cases go through
// skillTouchesPrivilege, so they run unchanged against the line-scanner-only gate (and are red there).
import { describe, it, expect } from 'vitest'
import { load as yamlLoad } from 'js-yaml'
import { privilegeView, skillTouchesPrivilege } from '../skill-privilege.js'

const doc = (head: string, body = '# body\n') => `---\n${head}\n---\n${body}`
const touches = (before: string, after: string): boolean => skillTouchesPrivilege({ content: before, files: [] }, { content: after, files: [] }).touches
const created = (after: string): boolean => skillTouchesPrivilege(null, { content: after, files: [] }).touches
const BASE = doc('name: x')

describe('hidden privilege keys: A, B, C, D, H (each was invisible to the line scanner)', () => {
  it('A: a block scalar with an indented --- line, then allowed-tools at column 0', () => {
    const before = doc('name: x\ndescription: |\n  first\n  ---\n  second')
    const after = doc('name: x\ndescription: |\n  first\n  ---\n  second\nallowed-tools: Bash')
    expect(touches(before, after)).toBe(true)
  })

  it('B: the same trick after a folded description hides tools: [Bash, Write]', () => {
    const before = doc('name: x\ndescription: >\n  folded\n  ---\n  more')
    const after = doc('name: x\ndescription: >\n  folded\n  ---\n  more\ntools: [Bash, Write]')
    expect(touches(before, after)).toBe(true)
  })

  it('C: a quoted key is a key', () => {
    expect(touches(BASE, doc('name: x\n"allowed-tools": Bash'))).toBe(true)
    expect(touches(BASE, doc("name: x\n'hooks': pre"))).toBe(true)
    expect(created(doc('name: x\n"allowed-tools": Bash'))).toBe(true)
  })

  it('D: a flow mapping at the root is a mapping', () => {
    expect(touches(doc('{name: x}'), doc('{name: x, allowed-tools: Bash}'))).toBe(true)
    expect(created(doc('{name: x, allowed-tools: Bash}'))).toBe(true)
  })

  it('H: a BOM before the opening --- is dropped for both readers, and a hidden key behind it is still seen', () => {
    expect(touches(`﻿${BASE}`, `﻿${doc('name: x\n"allowed-tools": Bash')}`)).toBe(true)
    expect(touches(`﻿${BASE}`, `﻿${doc('name: x\nallowed-tools: Bash')}`)).toBe(true)
  })

  it('E, F, G, I: what the scanner already saw is still seen (plain key, anchor, case, space before the colon)', () => {
    expect(touches(BASE, doc('name: x\nallowed-tools: Bash'))).toBe(true)
    expect(touches(BASE, doc('name: x\nx: &a [Bash]\ntools: *a'))).toBe(true)
    expect(touches(BASE, doc('name: x\nAllowed-Tools: Bash'))).toBe(true)
    expect(touches(BASE, doc('name: x\nallowed-tools : Bash'))).toBe(true)
  })

  it('the same text before and after is not a change, and a body edit is not a change', () => {
    const a = doc('name: x\n"allowed-tools": Bash\ndescription: |\n  a\n  ---\n  b')
    expect(touches(a, a)).toBe(false)
    expect(touches(doc('name: x\n"allowed-tools": Bash'), doc('name: x\n"allowed-tools": Bash', '# a different body\n'))).toBe(false)
  })

  it('a change of the value of a quoted key counts', () => {
    expect(touches(doc('name: x\n"allowed-tools": Read'), doc('name: x\n"allowed-tools": Bash'))).toBe(true)
  })
})

describe('the two readers disagree where the head ends: any edit of the head counts (!region)', () => {
  const split = (name: string) => doc(`name: ${name}\ndescription: |\n  a\n  ---\n  b\nnote: x`)
  it('a harmless-looking edit inside an ambiguous head is a change', () => {
    expect(privilegeView(split('x')).has('!region')).toBe(true)
    expect(touches(split('x'), split('y'))).toBe(true)
  })
  it('a head both readers close at the same line has no !region', () => {
    expect(privilegeView(BASE).has('!region')).toBe(false)
    expect(touches(doc('name: x'), doc('name: y'))).toBe(false)
  })
})

describe('a head that cannot be read safely is gated (!unparsable), on a create too', () => {
  it('invalid YAML: any edit counts, and so does a create', () => {
    expect(privilegeView(doc('name: [unclosed')).has('!unparsable')).toBe(true)
    expect(touches(doc('name: [unclosed'), doc('name: [unclosed again'))).toBe(true)
    expect(created(doc('name: [unclosed'))).toBe(true)
  })

  it('a head above 64 KB is not parsed: unparsable, and fast', () => {
    const big = doc(`name: x\n${Array.from({ length: 3000 }, (_, i) => `k${i}: ${'v'.repeat(30)}`).join('\n')}`)
    expect(big.length).toBeGreaterThan(100_000)
    const t0 = Date.now()
    expect(privilegeView(big).has('!unparsable')).toBe(true)
    expect(created(big)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('an alias bomb (40 levels, each referencing the previous twice) is gated, in well under a second', () => {
    const lines = ['name: x', 'a0: &a0 [1, 1]']
    for (let i = 1; i < 40; i++) lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`)
    lines.push('tools: *a39')
    const bomb = doc(lines.join('\n'))
    const t0 = Date.now()
    const view = privilegeView(bomb)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(view.has('!unparsable')).toBe(true)
    expect(created(bomb)).toBe(true)
  })

  it('a duplicate key is invalid YAML to the loader: gated, not silently last-wins', () => {
    expect(privilegeView(doc('name: x\nname: y')).has('!unparsable')).toBe(true)
  })
})

describe('differential: whatever a YAML load of the column-0-closed head sees, the gate compares', () => {
  // deterministic PRNG (mulberry32): the same 2400 documents on every run
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const FRAGMENTS = [
    'name: x', 'description: plain text', 'description: >\n  folded\n  text', 'description: |\n  block\n  ---\n  more\n  text',
    'allowed-tools: Bash', 'allowed_tools: [Read, Bash]', '"allowed-tools": Bash', "'tools': [Bash]", 'tools:\n  - Bash\n  - Write',
    'Allowed-Tools: Read', 'hooks:\n  pre: run', '"hooks": x', 'x: &a [Bash]\ntools: *a', 'model: fast', 'a: |\n  keep\n  ---\nhooks: z',
    '\tbad: tab', 'key with spaces: v', "? tools\n: Bash", 'allowed-tools : Bash', '#comment: x', 'description: "quoted"',
  ]
  const make = (r: () => number): string => {
    const flow = r() < 0.12
    const head = flow
      ? `{name: x${r() < 0.7 ? ', allowed-tools: Bash' : ''}${r() < 0.3 ? ', "tools": [Bash]' : ''}}`
      : Array.from({ length: 1 + Math.floor(r() * 5) }, () => FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]).join('\n')
    let text = `---\n${head}\n---\n# body\n---\ntail\n`
    if (r() < 0.3) text = text.replace(/\n/g, '\r\n')
    if (r() < 0.2) text = `﻿${text}`
    return text
  }
  const PRIVILEGE = new Set(['allowed-tools', 'allowed_tools', 'tools', 'hooks', 'description'])
  const CAPABILITY = new Set(['allowed-tools', 'allowed_tools', 'tools', 'hooks'])

  it('2400 generated frontmatters: every privilege key a js-yaml load sees is compared, an unreadable head is gated, and a capability key makes touches true', () => {
    const r = rng(20261111)
    let withKeys = 0
    let unreadable = 0
    for (let n = 0; n < 2400; n++) {
      const text = make(r)
      const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
      const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l))
      const head = lines.slice(1, end).join('\n')
      const view = privilegeView(text)
      let loaded: unknown
      try { loaded = yamlLoad(head) } catch { unreadable++; expect(view.has('!unparsable'), JSON.stringify(text)).toBe(true); continue }
      if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) continue
      for (const rawKey of Object.keys(loaded as Record<string, unknown>)) {
        const key = rawKey.trim().toLowerCase()
        if (!PRIVILEGE.has(key)) continue
        expect(view.has(key), `${key} in ${JSON.stringify(text)}`).toBe(true)
        if (CAPABILITY.has(key)) { withKeys++; expect(touches(BASE, text), `adding ${key}: ${JSON.stringify(text)}`).toBe(true) }
      }
    }
    // the generator is not vacuous: it produced documents with capability keys and documents that are not valid YAML
    expect(withKeys).toBeGreaterThan(300)
    expect(unreadable).toBeGreaterThan(50)
  })
})

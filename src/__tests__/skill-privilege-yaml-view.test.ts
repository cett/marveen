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

// On the real corpus about a quarter of the SKILL.md files are not valid YAML, all for one harmless reason (an unquoted
// description with a colon and a space), and the loader reads them fine. So an unparsable head gates an UPDATE on any
// change of the head (!unparsable), but gates a CREATE only when it also names a capability key (!unparsable-cap).
describe('a head that cannot be read safely: gated on any update, on a create unless it has the benign shape', () => {
  const COLON = 'name: x\ndescription: Does a thing: with a colon in it'

  it('invalid YAML: any edit of the head counts on an update', () => {
    expect(privilegeView(doc('name: [unclosed')).has('!unparsable')).toBe(true)
    expect(touches(doc('name: [unclosed'), doc('name: [unclosed again'))).toBe(true)
    expect(touches(doc(COLON), doc(`${COLON} and more`))).toBe(true)
  })

  it('the shape of the real corpus (a description with a colon) is unparsable and a create goes live', () => {
    const view = privilegeView(doc(COLON))
    expect(view.has('!unparsable')).toBe(true)
    expect(view.has('!unparsable-cap')).toBe(false)
    expect(created(doc(COLON))).toBe(false)
    expect(created(doc('name: [unclosed'))).toBe(false)
  })

  it('the four probe heads that slipped through the keyword check: escaped capability key names are held, and so is the bare hooks', () => {
    for (const head of [
      `${COLON}\n"h\\x6fooks": pre`,
      `${COLON}\n"t\\x6f\\x6fls": Bash`,
      `${COLON}\n"allowed-t\\x6fols": Bash`,
      `${COLON}\nhooks: pre`,
    ]) {
      expect(privilegeView(doc(head)).has('!unparsable-hold'), head).toBe(true)
      expect(created(doc(head)), head).toBe(true)
    }
  })

  it('the same unparsable head with a capability key name is held, quoted, bare, in a flow mapping, any case', () => {
    for (const head of [
      `${COLON}\n"allowed-tools": Bash`,
      `${COLON}\nallowed_tools: Bash`,
      `${COLON}\nTools: [Bash]`,
      `${COLON}\n'hooks': pre`,
      '{name: x, tools: [Bash]',
      'name: [unclosed\nALLOWED-TOOLS: Bash',
    ]) {
      expect(created(doc(head)), head).toBe(true)
    }
  })

  it('anything but a plain list of root keys is held on a create: anchor, tag, explicit key, flow, list, indented first line, tab, backslash', () => {
    for (const extra of [
      '&a note: x',
      '!!str note: x',
      '? note\n: x',
      '{note: x}',
      '- note',
      '[note]',
      '"note": x',
      "'note': x",
      'note : x',
      'note:x',
      '\tnote: x',
      'note: a\\b',
      'note: a\x01b',
      'a key with spaces: x',
    ]) {
      expect(created(doc(`${COLON}\n${extra}`)), JSON.stringify(extra)).toBe(true)
    }
    expect(created(doc(` indented first\n${COLON}`))).toBe(true)
    expect(created(doc(`# only a comment\n${COLON.split('\n')[1]}`))).toBe(false) // a comment first is fine: the first KEY line decides
    expect(created(doc('# nothing but comments: here'))).toBe(false) // no root key at all and no parse failure: parsable, nothing to hold
  })

  it('an empty head or one of comments only has no keys: not unreadable, so a create goes live and an update is not held for it', () => {
    for (const head of ['', '   ', '# just a comment', '# a: b\n\n# c']) {
      expect(privilegeView(doc(head)).has('!unparsable'), JSON.stringify(head)).toBe(false)
      expect(created(doc(head)), JSON.stringify(head)).toBe(false)
    }
    expect(touches(doc('# one'), doc('# two'))).toBe(false)
  })

  it('what real skills look like when they are not valid YAML goes live: comments, blank lines, continuation lines, other words, non-ASCII text', () => {
    expect(created(doc(`name: x\n# a comment\n\n${COLON.split('\n')[1]}\n  and a continuation line\n\nnote: y`))).toBe(false)
    expect(created(doc('name: x\ndescription: Ez egy leírás: kettősponttal, ékezetekkel'))).toBe(false)
    expect(created(doc('name: x\ndescription: Does a thing: and a "quoted" word and a back-tick `code`'))).toBe(false)
  })

  it('description alone never holds a create, unparsable or not', () => {
    expect(created(doc('name: x\ndescription: a: b: c'))).toBe(false)
  })

  it('a head the readers split differently is held on a create (!region is not narrowed)', () => {
    expect(created(doc('name: x\nnote: |\n  a\n  ---\n  b\nmore: x'))).toBe(true)
  })

  it('a head above 64 KB is not parsed: unparsable and fast; it is held on a create only when it names a capability key', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `k${i}: ${'v'.repeat(30)}`)
    const big = doc(`name: x\n${lines.join('\n')}`)
    expect(big.length).toBeGreaterThan(100_000)
    const t0 = Date.now()
    expect(privilegeView(big).has('!unparsable')).toBe(true)
    expect(created(big)).toBe(false)
    expect(created(doc(`name: x\n${lines.join('\n')}\n"tools": Bash`))).toBe(true)
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
    'name: x', 'description: plain text', 'description: Does a thing: with a colon in it', 'note: another one: with a colon', 'description: >\n  folded\n  text', 'description: |\n  block\n  ---\n  more\n  text',
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
    let createAllowed = 0
    for (let n = 0; n < 2400; n++) {
      const text = make(r)
      const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
      const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l))
      const head = lines.slice(1, end).join('\n')
      const view = privilegeView(text)
      // js-yaml refuses an input with no content ("expected a document"); an empty or comment-only head is a document with no keys
      if (head.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('#'))) { expect(view.has('!unparsable')).toBe(false); continue }
      let loaded: unknown
      try { loaded = yamlLoad(head) } catch {
        unreadable++
        expect(view.has('!unparsable'), JSON.stringify(text)).toBe(true)
        // the update path: an unreadable head is never let through (nothing that was refused before is allowed now)
        expect(touches(BASE, text), `update ${JSON.stringify(text)}`).toBe(true)
        // the create path: held unless the head has the benign shape (Rick's four rules, written out here independently of
        // the source: first non-comment line a bare root key; every column-0 line a bare key, a comment or empty; no
        // backslash, tab or control character; no capability name), or when the readers split the head
        const colZero = head.split('\n').filter((l) => l.trim() !== '' && !l.startsWith(' ') && !l.startsWith('#'))
        const firstOk = (() => { for (const l of head.split('\n')) { if (l.trim() === '' || l.startsWith('#')) continue; return !l.startsWith(' ') } return false })()
        const benign = firstOk && colZero.every((l) => /^[A-Za-z0-9_-]+:( .*)?$/.test(l)) && !/[\\\t\u0000-\u0009\u000b-\u001f\u007f]/.test(head) && !/allowed[-_]tools|tools|hooks/i.test(head)
        const holds = !benign || view.has('!region')
        expect(created(text), `create ${JSON.stringify(text)}`).toBe(holds)
        if (!holds) createAllowed++
        continue
      }
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
    // the create-path class that goes live now (an unreadable head with no capability key name and no split): not empty
    expect(createAllowed).toBeGreaterThan(5)
  })
})

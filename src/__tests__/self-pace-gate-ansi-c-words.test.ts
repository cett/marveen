// A protected path spelled with ANSI-C quoting ($'..'), locale quoting ($"..") or a command substitution inside a word that has
// a literal head (`<dir>/$(echo x)`) must reach the protected-path rules as the word the shell builds, not as a word that looks
// harmless. tokenizeShell.readWord builds that word (see DYN and readAnsiC in the gate); wordKind judges a word whose tail it
// cannot read by its literal head.
//   A. the invariant: the verdict of a spelled path equals the verdict of the plain spelling, writer by writer, in the agent
//      directory, the install root and a worktree copy ($'..' and $".."); a substitution behind a protected head is refused wherever
//      the plain path is
//   B. escapes that SPELL a protected name are refused, the same escapes spelling an unrelated name are free
//   C. reads stay free; the single-quoted body of the fleet API wrapper is still data
//   D. an unreadable target with no protected head keeps the verdict it had before
//   E. bounds: nothing hangs, the verdict stays fail-closed
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, tokenizeShell, DYN } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a git worktree copy: a real path outside the install
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ansi-c-words-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(agentCwd, { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command }, opts(cwd)).deny)
const where = (c: string) => ({ agent: denied(c, agentCwd), root: denied(c, root), copy: denied(c, wt) })

// a writer, or a reader that is not a plain read, with the path word T
const WRITERS: Array<[string, (t: string) => string]> = [
  ['redirect >', (t) => `echo x > ${t}`], ['redirect >>', (t) => `echo x >> ${t}`], ['cp destination', (t) => `cp /tmp/x ${t}`], ['cp source', (t) => `cp ${t} /tmp/y`],
  ['mv source', (t) => `mv ${t} /tmp/y`], ['mv destination', (t) => `mv /tmp/x ${t}`], ['tee', (t) => `tee ${t} < /dev/null`], ['sed -i', (t) => `sed -i s/a/b/ ${t}`],
  ['ln', (t) => `ln -s /tmp/x ${t}`], ['install', (t) => `install /tmp/x ${t}`], ['dd of=', (t) => `dd if=/dev/null of=${t}`], ['rm', (t) => `rm ${t}`],
  ['truncate', (t) => `truncate -s 0 ${t}`], ['touch', (t) => `touch ${t}`],
]
const ansi = (p: string) => `$'${p}'`
const locale = (p: string) => `$"${p}"`

describe('A. the spelled path has the verdict of the plain path', () => {
  const targets = () => [['a protected file', join(root, 'scripts', 'doctor.sh')], ['a protected file in a protected directory', join(root, 'scripts', 'hooks', 'egress-gate.mjs')],
    ['the gate scripts directory', join(root, 'scripts')], ['a protected file of the store', join(root, 'store', 'egress-allowlist.json')], ['the store directory', join(root, 'store')], ['the install root', root]]
  it.each([['ANSI-C', ansi], ['locale', locale]] as const)('%s quoting never changes the verdict of any writer on any target, in any directory', (_n, spell) => {
    for (const [tn, tp] of targets()) {
      for (const [wn, w] of WRITERS) {
        const plain = where(w(tp)); const spelled = where(w(spell(tp)))
        expect({ tn, wn, spelled }).toEqual({ tn, wn, spelled: plain })
      }
    }
  })
  it('the cells of the report: every writer on a protected file is refused in the install, the agent directory and (absolute path) the copy', () => {
    const f = join(root, 'scripts', 'doctor.sh')
    const cells = [`echo x > ${ansi(f)}`, `cp /tmp/x ${ansi(f)}`, `tee ${ansi(f)} < /dev/null`, `mv ${ansi(f)} /tmp/y`, `rm ${locale(f)}`, `cp /tmp/x ${join(root, 'scripts')}/$(echo doctor.sh)`, `echo x > ${join(root, 'scripts')}/$(echo doctor.sh)`]
    for (const c of cells) expect({ c, ...where(c) }).toEqual({ c, agent: true, root: true, copy: true })
  })
  it('a substitution behind a protected head is refused wherever the plain path is (file, directory-with-a-name-prefix, store, backtick, double quotes)', () => {
    const s = join(root, 'scripts')
    const spelled = [
      `${s}/$(echo doctor.sh)`, `${s}/doc$(echo tor.sh)`, `${join(s, 'hooks')}/$(echo egress-gate.mjs)`, `${join(root, 'store')}/$(echo egress-allowlist.json)`,
      `${s}/\`echo doctor.sh\``, `"${s}/$(echo doctor.sh)"`, `${s}/$(echo $(echo doctor.sh))`, `${s}/$(echo "d o" | tr -d ' ')ctor.sh`,
    ]
    for (const t of spelled) for (const [wn, w] of WRITERS) {
      const r = where(w(t))
      expect({ t, wn, agent: r.agent, root: r.root }).toEqual({ t, wn, agent: true, root: true })
    }
  })
  it('the twin: the same words in a worktree copy are free (relative path, the copy has its own scripts directory)', () => {
    for (const c of [`echo x > $'scripts/doctor.sh'`, `cp /tmp/x $"scripts/doctor.sh"`, `rm scripts/$(echo doctor.sh)`, `echo x > scripts/doc$(echo tor.sh)`]) expect({ c, copy: denied(c, wt) }).toEqual({ c, copy: false })
  })
  it('a bare name behind a substitution lands in the working directory: refused in the gate scripts directory, free elsewhere (the install root included)', () => {
    expect(denied('echo x > doc$(echo tor.sh)', join(root, 'scripts'))).toBe(true)
    expect(denied('echo x > doc$(echo tor.sh)', root)).toBe(false)
    expect(denied('echo x > doc$(echo tor.sh)', agentCwd)).toBe(false)
    expect(denied('at=$(date)', root)).toBe(false) // an assignment of a substitution has no head
    expect(denied('at=$(date)', join(root, 'scripts'))).toBe(false) // not even in the gate scripts directory, where a bare name would land in it
    // an assignment whose value starts with a protected head is judged by that head, as the plain assignment is
    const s = join(root, 'scripts')
    expect(where(`V=${s}/$(echo doctor.sh)`)).toEqual(where(`V=${s}/doctor.sh`))
    expect(denied(`V=${s}/$(echo doctor.sh)`, root)).toBe(true)
  })
  it('a head in the agent directories is not judged by the head (an agent writes there all the time)', () => {
    for (const c of [`echo x > ${agentCwd}/$(date)`, `touch ${join(root, 'agents')}/new$(echo 1)`, `cp /tmp/x ${join(agentCwd, 'notes')}/$(echo a).txt`]) expect({ c, ...where(c) }).toEqual({ c, agent: false, root: false, copy: false })
  })
})

describe('B. an escape that spells a protected name is read as the name', () => {
  it.each(['\\x64octor.sh', '\\144octor.sh', '\\u0064octor.sh', '\\U00000064octor.sh', 'd\\157ctor.sh', '\\x64\\x6f\\x63\\x74\\x6f\\x72.sh'])('refused in the install: %s', (name) => {
    const c = `echo x > $'${join(root, 'scripts')}/${name}'`
    expect({ c, agent: denied(c, agentCwd), root: denied(c, root) }).toEqual({ c, agent: true, root: true })
  })
  it('a relative path spelled by an escape: refused in the install root, free in the copy', () => {
    const c = `rm $'scripts/h\\x6foks/egress-gate.mjs'`
    expect({ c, root: denied(c, root), copy: denied(c, wt) }).toEqual({ c, root: true, copy: false })
  })
  it('the same escapes spelling an unrelated name are free, in the install as well', () => {
    for (const c of [`echo x > $'/tmp/\\x61'`, `echo x > $'${join(agentCwd, '\\x61')}'`, `echo x > $'${join(root, 'agents', 'agent-a')}/\\u0061.txt'`]) {
      expect({ c, ...where(c) }).toEqual({ c, agent: false, root: false, copy: false })
    }
  })
  it('every escape of bash is decoded by the tokenizer to the character bash builds', () => {
    const w = (s: string) => tokenizeShell(`echo ${s}`).words[1]
    expect(w(`$'a\\ab\\bc\\ed\\Ee\\ff\\ng\\rh\\ti\\vj\\\\k\\'l\\"m\\?n'`)).toBe('a\x07b\bc\x1bd\x1be\ff\ng\rh\ti\vj\\k\'l"m?n')
    expect(w(`$'\\101\\x41\\x4a\\u0041\\U00000041\\cA'`)).toBe('AAJAA\x01')
    expect(w(`$'\\7'`)).toBe('\x07')
    expect(w(`$'\\u00e9'`)).toBe('é')
    expect(w('$"scripts/x"')).toBe('scripts/x')
    expect(w(`a$'b'c"d"'e'`)).toBe('abcde')
  })
  it('an ANSI-C string it cannot decode is an unreadable word: NUL, an unknown escape, a byte above 0x7f, an escape with no digits, an unterminated string', () => {
    for (const s of [`$'a\\x00b'`, `$'a\\0b'`, `$'a\\qb'`, `$'a\\xffb'`, `$'a\\x'`, `$'a\\u'`, `$'abc`, `$'a\\`]) {
      const word = tokenizeShell(`echo ${s}`).words[1]
      expect({ s, unreadable: word.includes(DYN) }).toEqual({ s, unreadable: true })
    }
  })
})

describe('C. reads stay free', () => {
  it.each([
    (f: string) => `cat $'${f}'`, (f: string) => `grep x $'${f}'`, (f: string) => `cat $"${f}"`, (f: string) => `head -n 1 $'${f}'`,
  ])('a reader of a protected file spelled in ANSI-C or locale quoting is free, as the plain read is', (mk) => {
    const f = join(root, 'scripts', 'doctor.sh')
    expect(where(mk(f))).toEqual(where(mk(f).replace(/\$['"]/, '').replace(/['"]$/, '')))
    expect(denied(mk(f), agentCwd)).toBe(false)
  })
  it('git diff and a message text naming the path are free', () => {
    expect(denied(`git diff -- $'scripts/doctor.sh'`, root)).toBe(false)
    expect(denied(`echo $'scripts/doctor.sh'`, root)).toBe(false)
    expect(denied(`echo $'${join(root, 'scripts', 'doctor.sh')}'`, agentCwd)).toBe(false)
  })
  it('the single-quoted JSON body of the fleet API wrapper is still data, with a dollar-quote lookalike in it', () => {
    const body = `'{"content":"$\\"scripts/doctor.sh\\" and $x and scripts/hooks | xargs rm"}'`
    const c = `bash ${join(root, 'scripts', 'agent-api.sh')} --agent agent-a POST /api/messages ${body}`
    expect(denied(c, agentCwd)).toBe(false)
    // the twin: the same words outside the body are the protected write they are
    expect(denied(`rm $"scripts/doctor.sh" ; bash ${join(root, 'scripts', 'agent-api.sh')} --agent agent-a POST /api/messages ${body}`, root)).toBe(true)
  })
})

describe('D. an unreadable target with no protected head keeps its verdict', () => {
  it.each(['echo x > $(mktemp)', 'cp a $(echo b)', 'echo x > /tmp/$(date)', 'cp a /tmp/$(echo b)', 'echo x > $(echo /tmp/y)'])('free in all three directories: %s', (c) => {
    expect({ c, ...where(c) }).toEqual({ c, agent: false, root: false, copy: false })
  })
  it('a word with no head at all is read as it was: the substitution is cut at the parenthesis', () => {
    expect(tokenizeShell('cp a $(echo b)').words).toEqual(['cp', 'a', '$', 'echo', 'b'])
    expect(tokenizeShell('echo $(date)x').words.includes(DYN)).toBe(false)
  })
})

describe('E. bounds: no hang, fail-closed in the install', () => {
  const scripts = () => join(root, 'scripts')
  const timed = (c: string) => { const t = Date.now(); const r = where(c); return { ...r, ms: Date.now() - t } }
  it('a 10000 character substitution behind a protected head is refused (past the bound the word is flagged)', () => {
    const r = timed(`echo x > ${scripts()}/$(${'a'.repeat(10000)})`)
    expect({ agent: r.agent, root: r.root, fast: r.ms < 3000 }).toEqual({ agent: true, root: true, fast: true })
  })
  it('64 and 200 nested substitutions behind a protected head are refused', () => {
    for (const d of [64, 200]) {
      const r = timed(`echo x > ${scripts()}/${'$('.repeat(d)}a${')'.repeat(d)}`)
      expect({ d, agent: r.agent, root: r.root, fast: r.ms < 3000 }).toEqual({ d, agent: true, root: true, fast: true })
    }
  })
  it('an unbalanced substitution and an unterminated ANSI-C string naming a protected path are refused', () => {
    for (const c of [`echo x > ${scripts()}/$(echo doctor.sh`, `echo x > ${scripts()}/\`echo doctor.sh`, `echo x > $'${join(scripts(), 'doctor.sh')}`]) {
      const r = timed(c)
      expect({ c, agent: r.agent, root: r.root, fast: r.ms < 3000 }).toEqual({ c, agent: true, root: true, fast: true })
    }
  })
  it('a long run of dollar-quotes and backticks is read in linear time', () => {
    for (const c of [`echo ${"$'".repeat(5000)}`, `echo a${'`'.repeat(5000)}`, `echo a${'$('.repeat(5000)}`, `echo ${"$'\\x".repeat(3000)}`]) {
      const r = timed(c)
      expect({ fast: r.ms < 3000 }).toEqual({ fast: true })
    }
  })
})

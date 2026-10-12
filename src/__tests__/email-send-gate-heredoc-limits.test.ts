import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  scanHeredocs,
  gateDecision,
  isSendInvocation,
  buildTooLargeMsg,
  InspectionLimitError,
  MAX_CMD_CHARS,
  MAX_HEREDOC_OPENERS,
  MAX_OPENER_LINE_CHARS,
  MAX_WRAPPER_FLAG_STARTS,
  // @ts-expect-error -- plain .mjs hook script, no types
} from '../../scripts/email-send-gate.mjs'

// The heredoc scan of the ported send classifier was superlinear.
// A hook still running at its timeout is NOT a deny in the host (only exit 2 / a deny decision
// blocks), so a slow classifier was a fail-OPEN. This pins three things:
//   1. the linear scanner finds EXACTLY what the old regex found (differential, seeded fuzz);
//   2. hostile shapes finish fast, or are refused as "too large to inspect" (a DENY);
//   3. the hook ENTRYPOINT denies such a call, inside a time bound.
// The python twin is pinned in scripts/__tests__/outgoing-copy-gate-heredoc-scan.test.py and
// outgoing-copy-gate-failclosed.test.py; the constants below must match it (last test).

const ROOT = join(__dirname, '..', '..')
const GATE_JS = join(ROOT, 'scripts', 'email-send-gate.mjs')
const GATE_PY = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

// The regex this scanner replaced, kept here ONLY as the reference for the differential.
const LEGACY_HEREDOC_RE = /(<<-?\s*'?(\w+)'?[^\n]*)\n[\s\S]*?\n\2(?=\s|$)/g

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(rnd: () => number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const words = ['EOF', 'EO', 'EOFX', 'E', 'A', 'AB', 'ABC', 'PY', 'X1', '_']
  const junk = ['', ' ', ' > f', ' | bash', "'", '"x"', ' ;', '\t', ' EOF']
  const tails = ['', ' ', ';', 'x', '\t', '-', "'", '\r']
  let s = ''
  const parts = 1 + Math.floor(rnd() * 4)
  for (let p = 0; p < parts; p++) {
    s += pick(['', 'cat ', 'python3 - ', 'x\n', ' ', 'a<<b '])
    s += pick(['<<', '<<-', '<<<', '<< ', '<<\n', '<<  '])
    s += pick(['', "'", '"'])
    s += pick(words)
    s += pick(['', "'", '"'])
    s += pick(junk)
    s += pick(['\n', '\n', '\n', '\r\n', ''])
    const lines = Math.floor(rnd() * 4)
    for (let l = 0; l < lines; l++) {
      s += pick(['body', '', ' EOF', 'EOF' + pick(tails), pick(words) + pick(tails), '<<' + pick(words)]) + '\n'
    }
    if (rnd() < 0.75) s += pick(words) + pick(tails)
    if (rnd() < 0.5) s += '\n'
  }
  return s
}

const legacy = (s: string) =>
  [...s.matchAll(LEGACY_HEREDOC_RE)].map((m) => ({
    start: m.index!,
    introEnd: m.index! + m[1].length,
    bodyStart: m.index! + m[1].length + 1,
    bodyEnd: m.index! + m[0].length - m[2].length,
    end: m.index! + m[0].length,
  }))

describe('scanHeredocs finds exactly what the old regex found', () => {
  it('seeded differential: 30000 generated commands, identical matches', () => {
    const rnd = mulberry32(0xb2b2)
    let withMatch = 0
    let multi = 0
    for (let i = 0; i < 30000; i++) {
      const s = generate(rnd)
      const want = legacy(s)
      if (want.length) withMatch++
      if (want.length > 1) multi++
      expect(scanHeredocs(s), JSON.stringify(s)).toEqual(want)
    }
    // the generator must actually exercise matches, shorter-prefix closers and several heredocs
    expect(withMatch).toBeGreaterThan(5000)
    expect(multi).toBeGreaterThan(200)
  })

  it('keeps the old edge semantics: a prefix of the word may close, the first body line cannot', () => {
    expect(scanHeredocs('cat <<EOFX\nbody\nEOF\n')).toHaveLength(1) // closer EOF, a prefix of EOFX
    expect(scanHeredocs('cat <<EOF\nEOF\n')).toHaveLength(0) // an empty heredoc is no match
    expect(scanHeredocs('cat <<EOF\nbody\nEOF;\n')).toHaveLength(0) // the closer needs whitespace/end after it
  })
})

const REPEAT = (s: string, n: number) => s.repeat(n)
const CAP = MAX_CMD_CHARS

const HOSTILE: Array<[string, () => string]> = [
  ['32 never-closed openers and 100K of padding', () => Array.from({ length: 32 }, (_, i) => `cat <<T${i}\n`).join('') + 'x'.repeat(100_000)],
  ['`<<` followed by 100K word characters and no newline (the quadratic intro backtracking)', () => 'cat <<' + 'A'.repeat(100_000)],
  ['whitespace run after `<<`', () => ('<<' + ' '.repeat(120_000))],
  ['120K of `<<`', () => REPEAT('<<', 60_000)],
  ['one opener and 100K lines of padding', () => 'cat <<ZZZ\n' + REPEAT('x\n', 50_000)],
  ['many closer-looking lines of different lengths', () => 'cat <<ZZZ\n' + Array.from({ length: 1200 }, (_, i) => 'A'.repeat((i % 200) + 1) + ' \n').join('')],
  ['a long matched opener line full of `cat`', () => REPEAT('cat ', 1000) + '<<EOF\nbody\nEOF\n'],
  ['unbalanced quote and `resend` words (the legacy fallback patterns)', () => ("'" + REPEAT('resend ', 17_000)).slice(0, CAP)],
  ['assignment chain', () => (REPEAT('A=1 ', 30_000) + 'ls').slice(0, CAP)],
  ['keyword chain', () => (REPEAT('! ', 60_000) + 'ls').slice(0, CAP)],
]

describe('hostile shapes finish fast or are refused as too large (a deny), never hang', () => {
  for (const [name, make] of HOSTILE) {
    it(name, () => {
      const cmd = make()
      const t0 = Date.now()
      let verdict: string
      try {
        verdict = String(isSendInvocation(cmd))
      } catch (e) {
        expect(e).toBeInstanceOf(InspectionLimitError)
        verdict = 'limit'
      }
      const ms = Date.now() - t0
      expect(ms, `${name}: ${ms} ms (${verdict})`).toBeLessThan(3000)
    })
  }

  it('200 openers x 100K padding (18 s+ before) is refused at once', () => {
    const cmd = Array.from({ length: 200 }, (_, i) => `cat <<T${i}\n`).join('') + 'x'.repeat(100_000)
    const t0 = Date.now()
    const d = gateDecision('Bash', { command: cmd })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(d.deny).toBe(true)
    expect(d.tooLarge).toMatch(/heredoc openers/)
  })

  it('a wrapper with 40000 unknown flags (an out-of-memory crash before) is refused at once', () => {
    const cmd = 'sudo ' + REPEAT('--a ', 30_000) + 'true'
    const t0 = Date.now()
    const d = gateDecision('Bash', { command: cmd })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(d).toMatchObject({ deny: true })
    expect(d.tooLarge).toMatch(/unknown long flags/)
  })
})

describe('the limits are a deny with a reason, and sit right at the documented values', () => {
  it('openers: MAX is fine, MAX+1 is refused', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `cat <<T${i}\n`).join('')
    expect(gateDecision('Bash', { command: mk(MAX_HEREDOC_OPENERS) })).toEqual({ deny: false })
    expect(gateDecision('Bash', { command: mk(MAX_HEREDOC_OPENERS + 1) }).tooLarge).toMatch(/openers/)
  })

  it('command length: MAX is fine, MAX+1 is refused (even a harmless one)', () => {
    expect(gateDecision('Bash', { command: 'a'.repeat(MAX_CMD_CHARS) })).toEqual({ deny: false })
    const d = gateDecision('Bash', { command: 'a'.repeat(MAX_CMD_CHARS + 1) })
    expect(d.deny).toBe(true)
    expect(d.tooLarge).toMatch(/characters/)
  })

  it('opener line: a matched heredoc whose opening line is over the limit is refused', () => {
    const ok = 'x'.repeat(MAX_OPENER_LINE_CHARS - 20) + ' <<EOF\nbody\nEOF\n'
    const bad = 'x'.repeat(MAX_OPENER_LINE_CHARS + 1) + ' <<EOF\nbody\nEOF\n'
    expect(gateDecision('Bash', { command: ok }).deny).toBe(false)
    expect(gateDecision('Bash', { command: bad }).tooLarge).toMatch(/opener line/)
  })

  it('wrapper flags: MAX is fine, MAX+1 is refused', () => {
    expect(gateDecision('Bash', { command: 'sudo ' + '--a '.repeat(MAX_WRAPPER_FLAG_STARTS) + 'ls' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'sudo ' + '--a '.repeat(MAX_WRAPPER_FLAG_STARTS + 1) + 'ls' }).tooLarge).toMatch(/flags/)
  })

  it('a real send under the limits is still caught, and unclosed openers do not hide it', () => {
    expect(gateDecision('Bash', { command: 'cat <<A\ncat <<B\nsendmail a@example.invalid' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: "python3 - <<'PY'\nimport send\nPY\n" }).deny).toBe(true)
  })

  it('the deny message says why and what to do', () => {
    expect(buildTooLargeMsg('x')).toMatch(/tul nagy/)
  })
})

describe('the hook entrypoint denies a too-large call inside a time bound', () => {
  function runHook(command: string) {
    const t0 = Date.now()
    const out = execFileSync('node', [GATE_JS], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf-8',
      timeout: 8000,
    })
    return { out, ms: Date.now() - t0 }
  }

  it('200 openers x 100K: a deny decision (not a timeout, which the host would let through)', () => {
    const cmd = Array.from({ length: 200 }, (_, i) => `cat <<T${i}\n`).join('') + 'x'.repeat(100_000)
    const { out, ms } = runHook(cmd)
    const decision = JSON.parse(out).hookSpecificOutput
    expect(decision.permissionDecision).toBe('deny')
    expect(decision.permissionDecisionReason).toMatch(/tul nagy/)
    expect(ms).toBeLessThan(5000)
  })

  it('a harmless command within the limits passes with no output', () => {
    expect(runHook("echo hi\ncat <<'EOF'\nhello\nEOF\n").out).toBe('')
  })
})

describe('the JS and python copies carry the same limits', () => {
  const py = readFileSync(GATE_PY, 'utf-8')
  const num = (name: string) => Number(new RegExp(`^${name} = (\\d+)`, 'm').exec(py)?.[1])
  it.each([
    ['MAX_CMD_CHARS', MAX_CMD_CHARS],
    ['MAX_HEREDOC_OPENERS', MAX_HEREDOC_OPENERS],
    ['MAX_OPENER_LINE_CHARS', MAX_OPENER_LINE_CHARS],
    ['MAX_WRAPPER_FLAG_STARTS', MAX_WRAPPER_FLAG_STARTS],
  ])('%s', (name, jsValue) => {
    expect(num(name)).toBe(jsValue)
  })
})

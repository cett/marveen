import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, MAX_CMD_CHARS } from '../../scripts/self-pace-gate.mjs'

// The self-pace gate had no input size cap, and its old scheduler regex was quadratic on a long run of `(` or
// backticks (250 KB: 40 s, far past the 10 s hook timeout; a hook still running at its timeout does not block).
// The scheduler check is linear now (self-pace-gate-linear.test.ts), but other scans of the gate are not all linear
// (the backtick-pair shape below still takes about 2.5 s at the cap), so the cap stays as the outer bound.

const GATE = join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
const run = (command: string) =>
  execFileSync('node', [GATE], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' }), encoding: 'utf-8', timeout: 30000 })

describe('Bash command size cap', () => {
  it('is 64 KiB, above the longest real call seen (about 32 KB)', () => {
    expect(MAX_CMD_CHARS).toBe(65536)
  })
  it('a command over the cap is denied, fail-closed', () => {
    expect(gateDecision('Bash', { command: 'echo ' + 'a'.repeat(MAX_CMD_CHARS) })).toEqual({ deny: true, reason: 'too-large' })
  })
  it('a command exactly at the cap is still read', () => {
    expect(gateDecision('Bash', { command: 'echo ' + 'a'.repeat(MAX_CMD_CHARS - 5) })).toEqual({ deny: false })
  })
  it('the cap does not touch the other tools', () => {
    expect(gateDecision('Read', { file_path: '/tmp/x' })).toEqual({ deny: false })
  })
  it('the hook entrypoint answers a deny with the too-large message, not the self-pace text', () => {
    const out = JSON.parse(run('echo ' + 'a'.repeat(MAX_CMD_CHARS + 10)))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('tul nagy')
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain('Self-pace')
  })
})

describe('hostile shapes at the cap finish well inside the hook timeout', () => {
  const n = MAX_CMD_CHARS - 10
  // The budget is relative to the machine, not an absolute number of milliseconds. Some scans of the gate are
  // superlinear, so the cost at the cap is pure CPU speed times a fixed amount of backtracking: a CI runner 2.5x slower than
  // a laptop takes 2.5x as long (backticks: 3-4 s of CPU on an idle laptop, 9.3 s on one CI run, which broke an
  // absolute 8 s ceiling although nothing in the gate had changed). So the cost of every shape is divided by the cost
  // of a fixed reference job measured in the same process, right before and right after the shape, and the RATIO is
  // what is bounded. The reference is a quadratic backtracking regex that does not come from the gate (any change of
  // the gate pattern moves the shape and not the reference), about 0.5 s on an idle laptop.
  //   measured here (4 rounds, +-10%): parens 4.5, assignment 4.1, path 2.3, dollar parens 2.7, backticks 5.8
  //   (the worst); with the regex engine in interpreter mode (`node --regexp-interpret-all`, a genuinely slower
  //   machine: the gate alone takes 7-30 s of CPU, 3-12x an idle laptop) the test stays green.
  // The limit is about 1.9x the worst ratio, the same margin the absolute ceiling had on an idle laptop. Raising the
  // cap to 128 KiB (ratios 12 to 19 on three shapes) or two more runs of the scheduler pattern per segment (ratio 16 on
  // parens) still fails.
  const RATIO_LIMIT = 11
  const REF_INPUT = '('.repeat(30000)
  const REF_RX = /(^|[(`])(?:\S*\/)?crontab/
  const cpuMs = (fn: () => void): number => {
    const c0 = process.cpuUsage()
    fn()
    const c = process.cpuUsage(c0)
    return (c.user + c.system) / 1000
  }
  const referenceMs = (): number => cpuMs(() => { REF_RX.test(REF_INPUT) })
  const shapes: Array<[string, string]> = [
    ['parens', '('.repeat(n)],
    ['assignment after a paren', '(a='.repeat(Math.floor(n / 3))],
    ['path after a paren', '(a/'.repeat(Math.floor(n / 3))],
    ['dollar parens', '$('.repeat(Math.floor(n / 2))],
    ['backticks', '`a'.repeat(Math.floor(n / 2))],
  ]
  for (const [name, command] of shapes) {
    // CPU time of this (forked, serial) test process, not wall clock: a wall-clock figure measures the machine load as
    // much as the pattern (a loaded machine took 7-10 s of wall time for a gate that needs 1.5-3.6 s of CPU). The
    // reference is taken on both sides of the shape and the larger reading counts, so a slowdown in the middle of the
    // run (another job taking the core) cannot make the ratio look worse than it is.
    it(name, () => {
      const before = referenceMs()
      const ms = cpuMs(() => { gateDecision('Bash', { command }) })
      const after = referenceMs()
      const reference = Math.max(before, after, 1)
      const ratio = ms / reference
      expect(ratio, `${name}: ${Math.round(ms)} ms of CPU, reference ${Math.round(before)}/${Math.round(after)} ms, ratio ${ratio.toFixed(1)}`).toBeLessThan(RATIO_LIMIT)
      // The vitest default (15 s) is a wall-clock limit on the whole test, which on a slow machine would end the
      // test before the ratio is looked at: the shape takes 5-10 s there, two reference runs more. Generous on purpose.
    }, 120_000)
  }
})

// Verdicts of the scheduler pattern, pinned so a later change cannot narrow them unnoticed. The wrapper-word rows are
// the ones a boundary-limited rewrite of the wrapper prefix loses (an unlisted wrapper word inside a substitution).
describe('the scheduler verdicts', () => {
  for (const [cmd, deny] of [
    ['crontab -r', true],
    ['sudo crontab -', true],
    ['X=$(crontab -)', true],
    ['X=$(nohup crontab -r)', true],
    ['X=`setsid crontab -r`', true],
    ['X=$(echo crontab -r)', true],
    ['A=1 /usr/bin/at now', true],
    ['echo `crontab -r`', true],
    ['(crontab -r)', true],
    ['a;b/crontab -r', true],
    ['crontab -l', false],
    ['launchctl list', false],
    ['atq', false],
    ['echo hello (world) at least', false],
  ] as Array<[string, boolean]>) {
    it(`${deny ? 'denies' : 'allows'}: ${cmd}`, () => {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(deny)
    })
  }
})

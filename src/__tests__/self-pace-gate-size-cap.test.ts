import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, MAX_CMD_CHARS } from '../../scripts/self-pace-gate.mjs'

// The self-pace gate had no input size cap, and its scheduler pattern (SCHED_PREFIX) is quadratic on a long run
// of `(` or backticks (250 KB: 40 s, far past the 10 s hook timeout; a hook still running at its timeout does
// not block). The pattern is NOT made linear here: narrowing its `\S*` changes verdicts (see the comment at
// SCHED_PREFIX). The cap keeps the quadratic cost inside the timeout instead.

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
  const shapes: Array<[string, string]> = [
    ['parens', '('.repeat(n)],
    ['assignment after a paren', '(a='.repeat(Math.floor(n / 3))],
    ['path after a paren', '(a/'.repeat(Math.floor(n / 3))],
    ['dollar parens', '$('.repeat(Math.floor(n / 2))],
    ['backticks', '`a'.repeat(Math.floor(n / 2))],
  ]
  for (const [name, command] of shapes) {
    it(name, () => {
      const t0 = Date.now()
      gateDecision('Bash', { command })
      const ms = Date.now() - t0
      expect(ms, `${name}: ${ms} ms`).toBeLessThan(6000)
    })
  }
})

// Verdicts of the scheduler pattern, pinned so a later change cannot narrow them unnoticed. The wrapper-word rows are
// the ones a boundary-limited rewrite of SCHED_PREFIX loses (an unlisted wrapper word inside a substitution).
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

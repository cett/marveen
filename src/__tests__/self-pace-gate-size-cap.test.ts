import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, MAX_CMD_CHARS } from '../../scripts/self-pace-gate.mjs'

// The self-pace gate had no input size cap, and its scheduler pattern was quadratic on a long run of `(`
// (250 KB: 40 s, far past the 10 s hook timeout; a hook still running at its timeout does not block). The
// cap refuses what the scans cannot finish; the pattern is now linear.

const GATE = join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
const run = (command: string) =>
  execFileSync('node', [GATE], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' }), encoding: 'utf-8', timeout: 30000 })

describe('Bash command size cap', () => {
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

describe('the scheduler pattern is linear at the cap', () => {
  const shapes: Array<[string, string]> = [
    ['parens', '('.repeat(MAX_CMD_CHARS - 10)],
    ['assignment after a paren', '(a='.repeat(Math.floor((MAX_CMD_CHARS - 10) / 3))],
    ['path after a paren', '(a/'.repeat(Math.floor((MAX_CMD_CHARS - 10) / 3))],
    ['dollar parens', '$('.repeat(Math.floor((MAX_CMD_CHARS - 10) / 2))],
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

describe('the scheduler verdicts are unchanged', () => {
  for (const [cmd, deny] of [
    ['crontab -r', true],
    ['sudo crontab -', true],
    ['X=$(crontab -)', true],
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

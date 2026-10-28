// The tmux binary resolver and the restart gate that used to hardcode /usr/bin/tmux (which does not exist where
// tmux comes from Homebrew, so the gate could neither read the pane nor send /clear there).
// Three branches of the resolver (recorded value, lazy search, explicit error), the recording script, and the
// gate's source: every tmux call goes through tmuxBin().
import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { makeLazyBinResolver, tmuxBin } from '../platform.js'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tmux-bin-test-')); dirs.push(d); return d }
const fakeBin = (dir: string, name: string): string => {
  const p = join(dir, name)
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}
const savedPath = process.env['PATH']
afterEach(() => {
  process.env['PATH'] = savedPath
  delete process.env['TMUX_BIN']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('makeLazyBinResolver', () => {
  it('a recorded location that exists wins over the search', () => {
    const recorded = fakeBin(tmp(), 'tmuxfake-rec')
    const onPath = tmp(); fakeBin(onPath, 'tmuxfake-rec')
    process.env['PATH'] = `${onPath}:${savedPath}`
    expect(makeLazyBinResolver('tmuxfake-rec', { recorded: () => recorded })()).toBe(recorded)
  })

  it('a recorded location that is gone, relative or empty falls back to the search', () => {
    const onPath = tmp(); const found = fakeBin(onPath, 'tmuxfake-stale')
    process.env['PATH'] = `${onPath}:${savedPath}`
    // 'package.json' exists relative to the working directory: a relative value must still not be served.
    for (const stale of ['/nowhere/tmux-moved', 'tmux', 'package.json', '', undefined]) {
      expect(makeLazyBinResolver('tmuxfake-stale', { recorded: () => stale })()).toBe(found)
    }
  })

  it('the recorded location is read on every call: a binary that disappears later is not served from a cache', () => {
    const rec = fakeBin(tmp(), 'tmuxfake-late')
    const onPath = tmp(); const found = fakeBin(onPath, 'tmuxfake-late')
    process.env['PATH'] = `${onPath}:${savedPath}`
    const resolver = makeLazyBinResolver('tmuxfake-late', { recorded: () => rec })
    expect(resolver()).toBe(rec)
    rmSync(rec)
    expect(resolver()).toBe(found)
  })

  it('without a recorded value the search finds the binary on PATH', () => {
    const onPath = tmp(); const found = fakeBin(onPath, 'tmuxfake-path')
    process.env['PATH'] = `${onPath}:${savedPath}`
    expect(makeLazyBinResolver('tmuxfake-path')()).toBe(found)
  })

  it('a binary that is nowhere is an explicit error, not a guessed path', () => {
    expect(() => makeLazyBinResolver('tmuxfake-nowhere-xyz', { recorded: () => '/nowhere/x' })()).toThrow(/Required binary not found on PATH: tmuxfake-nowhere-xyz/)
  })
})

describe('tmuxBin', () => {
  it('takes the TMUX_BIN of the environment first, when it exists', () => {
    const rec = fakeBin(tmp(), 'tmux')
    process.env['TMUX_BIN'] = rec
    expect(tmuxBin()).toBe(rec)
  })

  it('is the one resolver of the process-session module and of the restart gate (no hardcoded path left)', async () => {
    const session = await import('../web/agent-process-session.js')
    expect(session.tmuxBin).toBe(tmuxBin)
    const gate = readFileSync(resolve(__dirname, '../web/context-restart-gate-runner.ts'), 'utf-8')
    expect(gate).not.toMatch(/\/usr\/bin\/tmux/)
    expect(gate).not.toMatch(/process\.env\.TMUX_BIN/)
    expect(gate.match(/execFileSync\(tmuxBin\(\),/g)?.length).toBe(3)
    expect(gate).not.toMatch(/execFileSync\(TMUX\b/)
  })
})

describe('scripts/record-tmux-bin.sh', () => {
  const script = resolve(__dirname, '../../scripts/record-tmux-bin.sh')
  const run = (envFile: string, path: string): string =>
    execFileSync('/bin/bash', [script, envFile], { env: { PATH: path, HOME: tmpdir() }, encoding: 'utf-8' })
  const envWith = (content: string): string => { const f = join(tmp(), '.env'); writeFileSync(f, content, { mode: 0o600 }); return f }

  it('writes the tmux it finds into a file that has none, keeping the other lines and the mode', () => {
    const bin = tmp(); const tmuxPath = fakeBin(bin, 'tmux')
    const f = envWith('A=1\nB=2\n')
    expect(run(f, `${bin}:/usr/bin:/bin`)).toContain(`TMUX_BIN=${tmuxPath}`)
    expect(readFileSync(f, 'utf-8')).toBe(`A=1\nB=2\nTMUX_BIN=${tmuxPath}\n`)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('keeps a recorded value that still points at an executable', () => {
    const bin = tmp(); fakeBin(bin, 'tmux')
    const other = fakeBin(tmp(), 'tmux-other')
    const f = envWith(`TMUX_BIN=${other}\nA=1\n`)
    expect(run(f, `${bin}:/usr/bin:/bin`)).toBe('')
    expect(readFileSync(f, 'utf-8')).toBe(`TMUX_BIN=${other}\nA=1\n`)
  })

  it('replaces a stale value once and leaves one TMUX_BIN line', () => {
    const bin = tmp(); const tmuxPath = fakeBin(bin, 'tmux')
    const f = envWith('TMUX_BIN=/gone/tmux\nA=1\n')
    run(f, `${bin}:/usr/bin:/bin`)
    const lines = readFileSync(f, 'utf-8').split('\n').filter((l) => l.startsWith('TMUX_BIN='))
    expect(lines).toEqual([`TMUX_BIN=${tmuxPath}`])
  })

  it('writes nothing when tmux is nowhere on PATH, and fails on a missing file', () => {
    const empty = tmp()
    const f = envWith('A=1\n')
    expect(run(f, `${empty}:/nonexistent`)).toBe('')
    expect(readFileSync(f, 'utf-8')).toBe('A=1\n')
    expect(() => run(join(empty, 'no.env'), '/usr/bin:/bin')).toThrow()
  })
})

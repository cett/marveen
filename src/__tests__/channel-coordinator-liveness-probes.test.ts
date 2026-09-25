// Coverage for three previously-untested functions in
// src/channel-coordinator/liveness.ts: getClaudePidForSession (tmux/ps/pgrep
// pane-to-pid resolution), readRespawnStampMs and readKeepaliveAgeMs (the two
// file-mtime/stamp readers decideNativeChannelDown's facts are built from).
// The pure decision functions built on top of these (decideHasPluginAlive,
// decideNativeChannelDown) already have their own coverage elsewhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

import { execFileSync } from 'node:child_process'
import { getClaudePidForSession } from '../channel-coordinator/liveness.js'

type Behavior = { tmux?: string | Error; ps?: string | Error; pgrep?: string | Error }

function mockExec(behavior: Behavior) {
  vi.mocked(execFileSync).mockImplementation(((_cmd: string, args?: readonly string[]) => {
    const a = (args ?? []) as string[]
    if (a.includes('list-panes')) {
      if (behavior.tmux instanceof Error) throw behavior.tmux
      return (behavior.tmux ?? '') as unknown as Buffer
    }
    if (a[0] === '-p') {
      if (behavior.ps instanceof Error) throw behavior.ps
      return (behavior.ps ?? '') as unknown as Buffer
    }
    if (a[0] === '-P') {
      if (behavior.pgrep instanceof Error) throw behavior.pgrep
      return (behavior.pgrep ?? '') as unknown as Buffer
    }
    throw new Error('unexpected execFileSync args: ' + JSON.stringify(a))
  }) as typeof execFileSync)
}

describe('getClaudePidForSession', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset()
  })

  it('returns the pane pid when its own command is claude', () => {
    mockExec({ tmux: '4242\n', ps: 'claude\n' })
    expect(getClaudePidForSession('main-channels')).toBe(4242)
  })

  it('returns the pane pid when its command is an absolute /.../claude path', () => {
    mockExec({ tmux: '4242\n', ps: '/opt/homebrew/bin/claude\n' })
    expect(getClaudePidForSession('main-channels')).toBe(4242)
  })

  it('falls back to a pgrep-found claude child when the pane itself is a shell', () => {
    mockExec({ tmux: '4242\n', ps: '-zsh\n', pgrep: '5050\n' })
    expect(getClaudePidForSession('main-channels')).toBe(5050)
  })

  it('returns null when the pane is a shell and pgrep finds no claude child', () => {
    mockExec({ tmux: '4242\n', ps: '-zsh\n', pgrep: new Error('no matching process') })
    expect(getClaudePidForSession('main-channels')).toBeNull()
  })

  it('returns null when tmux list-panes fails (session does not exist)', () => {
    mockExec({ tmux: new Error('no such session') })
    expect(getClaudePidForSession('missing-session')).toBeNull()
  })

  it('returns null when tmux returns an unparsable pane pid', () => {
    mockExec({ tmux: '\n' })
    expect(getClaudePidForSession('main-channels')).toBeNull()
  })

  it('returns null when ps for the pane pid throws', () => {
    mockExec({ tmux: '4242\n', ps: new Error('No such process') })
    expect(getClaudePidForSession('main-channels')).toBeNull()
  })
})

describe('readRespawnStampMs / readKeepaliveAgeMs (STORE_DIR-relative files)', () => {
  let storeDir: string
  let mod: typeof import('../channel-coordinator/liveness.js')

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'liveness-probes-'))
    process.env['MARVEEN_STORE_DIR'] = storeDir
    vi.resetModules()
    mod = await import('../channel-coordinator/liveness.js')
  })

  afterEach(() => {
    delete process.env['MARVEEN_STORE_DIR']
    rmSync(storeDir, { recursive: true, force: true })
  })

  describe('readRespawnStampMs', () => {
    it('returns 0 when the stamp file does not exist', () => {
      expect(mod.readRespawnStampMs()).toBe(0)
    })

    it('reads a unix-seconds stamp and converts it to ms', () => {
      writeFileSync(mod.RESPAWN_STAMP_FILE, '1700000000\n')
      expect(mod.readRespawnStampMs()).toBe(1700000000000)
    })

    it('returns 0 for a non-numeric stamp', () => {
      writeFileSync(mod.RESPAWN_STAMP_FILE, 'not-a-number')
      expect(mod.readRespawnStampMs()).toBe(0)
    })

    it('returns 0 for a zero/negative stamp', () => {
      writeFileSync(mod.RESPAWN_STAMP_FILE, '0')
      expect(mod.readRespawnStampMs()).toBe(0)
      writeFileSync(mod.RESPAWN_STAMP_FILE, '-5')
      expect(mod.readRespawnStampMs()).toBe(0)
    })
  })

  describe('readKeepaliveAgeMs', () => {
    it('returns null when the keepalive file does not exist', () => {
      expect(mod.readKeepaliveAgeMs(Date.now())).toBeNull()
    })

    it('returns the elapsed ms since the file mtime', () => {
      writeFileSync(mod.KEEPALIVE_FILE, 'x')
      const mtime = new Date(Date.now() - 5 * 60 * 1000)
      utimesSync(mod.KEEPALIVE_FILE, mtime, mtime)
      const now = Date.now()
      const age = mod.readKeepaliveAgeMs(now)
      expect(age).not.toBeNull()
      expect(Math.abs((age as number) - 5 * 60 * 1000)).toBeLessThan(2000)
    })
  })
})

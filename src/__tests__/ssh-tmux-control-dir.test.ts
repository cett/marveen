// coverage batch-51: ensureControlDir/cleanStaleSshSockets (0% covered
// before this file). controlDir() honors XDG_RUNTIME_DIR, so redirecting it
// to a temp dir sandboxes ensureControlDir()'s real mkdirSync call without
// touching the operator's actual /tmp or runtime dir.
//
// ensureControlDir() memoizes "already ensured" in a module-level boolean,
// so a single shared import across tests would only ever create the FIRST
// test's directory (the reference to which flag caught this: expected the
// second test's freshly-minted sandbox dir to exist, got false). vi.resetModules()
// + a dynamic re-import per test gives each test its own unmemoized module
// instance, same as this suite's ensureControlDir() itself is designed to be
// called once per process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let realXdg: string | undefined
let sandbox: string
let mod: typeof import('../web/ssh-tmux.js')

beforeEach(async () => {
  realXdg = process.env.XDG_RUNTIME_DIR
  sandbox = mkdtempSync(join(tmpdir(), 'ssh-tmux-controldir-'))
  process.env.XDG_RUNTIME_DIR = sandbox
  vi.resetModules()
  mod = await import('../web/ssh-tmux.js')
})

afterEach(() => {
  if (realXdg === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = realXdg
  rmSync(sandbox, { recursive: true, force: true })
})

describe('ensureControlDir', () => {
  it('creates the control dir with mode 0700 when absent', () => {
    const dir = mod.controlDir()
    expect(existsSync(dir)).toBe(false)
    mod.ensureControlDir()
    expect(existsSync(dir)).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('does not throw on a second call once already created', () => {
    mod.ensureControlDir()
    expect(() => mod.ensureControlDir()).not.toThrow()
    expect(existsSync(mod.controlDir())).toBe(true)
  })
})

describe('cleanStaleSshSockets', () => {
  it('swallows the error from a nonexistent ControlMaster socket instead of throwing', () => {
    expect(() => mod.cleanStaleSshSockets('no-such-host.invalid')).not.toThrow()
  })
})

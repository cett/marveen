import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  CONTROL_PATH,
  shQuote,
  buildTmuxInvocation,
  buildSshExec,
  sessionInList,
  SSH_OPTS,
  controlDir,
} from '../web/ssh-tmux.js'

describe('shQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shQuote('hello')).toBe("'hello'")
  })

  it('escapes an embedded single quote with the POSIX dance', () => {
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  it('keeps glob/bracket characters literal (inside single quotes)', () => {
    expect(shQuote('claude-opus-4-8[1m]')).toBe("'claude-opus-4-8[1m]'")
  })

  it('keeps shell metacharacters literal', () => {
    expect(shQuote('a; rm -rf / && echo $HOME')).toBe("'a; rm -rf / && echo $HOME'")
  })
})

describe('buildTmuxInvocation', () => {
  it('host=null returns the bare local binary + args (byte-identical to a direct local call)', () => {
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', ['list-sessions'])).toEqual({
      file: '/usr/bin/tmux',
      args: ['list-sessions'],
    })
  })

  it('host set wraps every tmux arg in one shell-quoted ssh command string', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', '-l', "a'b c"])
    expect(inv.file).toBe('ssh')
    // SSH_OPTS, then the host, then exactly ONE remote command string.
    expect(inv.args.length).toBe(SSH_OPTS.length + 2)
    expect(inv.args.slice(0, SSH_OPTS.length)).toEqual([...SSH_OPTS])
    expect(inv.args[SSH_OPTS.length]).toBe('devbox')
    expect(inv.args[SSH_OPTS.length + 1]).toBe(
      "tmux 'send-keys' '-t' 'agent-x' '-l' 'a'\\''b c'",
    )
  })

  it('a full new-session launch command rides as a SINGLE argv element with brackets kept literal', () => {
    const cmd = "cd '/home/user/p' && claude --continue --model 'claude-opus-4-8[1m]'"
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['new-session', '-d', '-s', 'agent-x', cmd])
    expect(inv.file).toBe('ssh')
    // host + ONE command string => no splitting of cmd across argv elements.
    expect(inv.args.length).toBe(SSH_OPTS.length + 2)
    const remote = inv.args[SSH_OPTS.length + 1]
    expect(remote.startsWith("tmux 'new-session' '-d' '-s' 'agent-x' ")).toBe(true)
    // The bracketed model token survives intact inside the quoting.
    expect(remote).toContain('claude-opus-4-8[1m]')
  })

  it('preserves a slid leading-dash chunk (Hungarian suffix) verbatim', () => {
    const inv = buildTmuxInvocation('devbox', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', '-l', ' -szal'])
    const remote = inv.args[SSH_OPTS.length + 1]
    expect(remote.endsWith("' -szal'")).toBe(true)
  })
})

describe('buildSshExec', () => {
  it('builds an ssh invocation with SSH_OPTS + host + the raw remote command', () => {
    const inv = buildSshExec('devbox', 'which claude')
    expect(inv.file).toBe('ssh')
    expect(inv.args).toEqual([...SSH_OPTS, 'devbox', 'which claude'])
  })
})

describe('SSH_OPTS', () => {
  it('bounds an alive-but-unresponsive remote (ServerAlive), not just TCP connect', () => {
    expect(SSH_OPTS).toContain('ServerAliveInterval=2')
    expect(SSH_OPTS).toContain('ServerAliveCountMax=2')
    expect(SSH_OPTS).toContain('ConnectTimeout=5')
    expect(SSH_OPTS).toContain('BatchMode=yes')
  })

  it('uses a private ControlMaster socket dir, not a bare world-writable /tmp path', () => {
    const cpIdx = SSH_OPTS.indexOf('ControlMaster=auto')
    expect(cpIdx).toBeGreaterThanOrEqual(0)
    const controlPathOpt = SSH_OPTS.find(o => o.startsWith('ControlPath='))
    expect(controlPathOpt).toBeDefined()
    expect(controlPathOpt).toContain(controlDir())
    expect(controlDir()).toMatch(/marveen-ssh/)
    // Not the bare `/tmp/<file>` form flagged as world-writable.
    expect(controlPathOpt).not.toMatch(/ControlPath=\/tmp\/[^/]+%/)
  })

  // The socket name must not grow with the user/host name: macOS caps a unix
  // socket path at 104 bytes and a long FQDN overflowed the spelled-out form.
  it('names the ControlMaster socket by the %C hash, not by user/host/port', () => {
    expect(CONTROL_PATH).toMatch(/\/cm-%C$/)
    expect(CONTROL_PATH).not.toMatch(/%[rhp]/)
    expect(SSH_OPTS).toContain(`ControlPath=${CONTROL_PATH}`)
  })

  // Real ssh, no mocks: `ssh -G` prints the config with the tokens expanded
  // exactly as the connection would. ssh appends "." + 16 random chars to the
  // socket path while binding it, so the expanded path needs 17 bytes of room.
  const SUN_PATH_MAX = 104
  const BIND_SUFFIX = 17
  const expandControlPath = (template: string): string | null => {
    const longHost = `${'h'.repeat(60)}.example.internal`
    try {
      const out = execFileSync('ssh', ['-G', '-o', `ControlPath=${template}`, '-l', 'someuser', longHost], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.split('\n').find(l => l.startsWith('controlpath '))?.slice('controlpath '.length) ?? null
    } catch { return null }
  }
  const sshCanExpand = expandControlPath('/tmp/x-%C') !== null

  it.skipIf(!sshCanExpand)('the expanded socket path fits the unix socket limit for a long user and host', () => {
    const expanded = expandControlPath(CONTROL_PATH)
    expect(expanded).not.toBeNull()
    expect(expanded as string).not.toContain('%')
    expect((expanded as string).length + BIND_SUFFIX).toBeLessThanOrEqual(SUN_PATH_MAX)
    // Same long names, the old spelled-out template: proves the check bites.
    const old = expandControlPath(join(controlDir(), 'cm-%r@%h:%p'))
    expect((old as string).length + BIND_SUFFIX).toBeGreaterThan(SUN_PATH_MAX)
  })
})

describe('sessionInList', () => {
  it('matches an exact session line', () => {
    expect(sessionInList('agent-a\nagent-b\n', 'agent-b')).toBe(true)
  })

  it('is false when the session is absent', () => {
    expect(sessionInList('agent-a\n', 'agent-x')).toBe(false)
  })

  it('does not match on a substring of a longer session name', () => {
    expect(sessionInList('agent-bbb\n', 'agent-b')).toBe(false)
  })
})

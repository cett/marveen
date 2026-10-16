import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import {
  isInfrastructureChild,
  findClaudePidInTree,
  isClaudeComm,
  parseChildPids,
  parseEtimeOutput,
  getChildPids,
  getPidAgeSeconds,
  getCommForPid,
  extractMcpPackageNames,
  isMcpProcess,
  TASKSTATE_FRESH_WINDOW_MS,
} from '../web/context-restart-gate-runner.js'

// isInfrastructureChild: absolute-delta classifier separating MCP-server /
// plugin-runner infrastructure from real work children (Task-tool subagents,
// background Bash). Absolute delta (not ratio) is the whole point -- see the
// module header for why a ratio would misclassify a long-running subagent in
// a long session.
describe('isInfrastructureChild', () => {
  it('a transient exec() younger than CHILD_MIN_AGE_S (3s) is infra', () => {
    expect(isInfrastructureChild(1, 500)).toBe(true)
    expect(isInfrastructureChild(2, 500)).toBe(true)
  })

  it('a child started within 60s of the claude process (MCP startup) is infra', () => {
    expect(isInfrastructureChild(10, 65)).toBe(true) // delta = 55s < 60s
    expect(isInfrastructureChild(10, 70)).toBe(true) // delta = 60s, boundary inclusive
  })

  it('a child spawned well after boot (delta > 60s) is possibly-work', () => {
    expect(isInfrastructureChild(10, 71)).toBe(false) // delta = 61s
    expect(isInfrastructureChild(300, 6000)).toBe(false) // a 90-min subagent in a 2h session
  })

  it('a young claude process cannot misclassify a same-age child as infra beyond the delta', () => {
    // claudeAgeS - INFRA_AGE_DELTA_S goes negative; any age >= 3s still infra
    // because childAgeS >= claudeAgeS - 60 trivially holds for a small claudeAgeS.
    expect(isInfrastructureChild(5, 10)).toBe(true)
  })
})

// findClaudePidInTree: locate the actual claude process in either the direct
// shape (pane IS claude) or the wrapper shape (pane is a shell, claude is a
// child) -- fail-closed (null) when it cannot be found in either position.
describe('findClaudePidInTree', () => {
  it('direct shape: paneComm is claude -> pane IS claude', () => {
    expect(findClaudePidInTree(100, 'claude', [])).toBe(100)
  })

  it('wrapper shape: paneComm is bash, claude found among children', () => {
    const children = [
      { pid: 200, comm: 'node' },
      { pid: 201, comm: 'claude' },
    ]
    expect(findClaudePidInTree(100, 'bash', children)).toBe(201)
  })

  it('fail-closed: paneComm is null (ps lookup failed)', () => {
    expect(findClaudePidInTree(100, null, [{ pid: 200, comm: 'claude' }])).toBeNull()
  })

  it('fail-closed: neither the pane nor any child is claude', () => {
    const children = [{ pid: 200, comm: 'node' }, { pid: 201, comm: 'bash' }]
    expect(findClaudePidInTree(100, 'bash', children)).toBeNull()
  })

  it('picks the FIRST matching child when (implausibly) more than one is named claude', () => {
    const children = [
      { pid: 201, comm: 'claude' },
      { pid: 202, comm: 'claude' },
    ]
    expect(findClaudePidInTree(100, 'bash', children)).toBe(201)
  })

  // macOS prints the full executable path for `ps -o comm=`.
  it('macOS shape: a full-path comm is claude (pane and child)', () => {
    expect(findClaudePidInTree(100, '/opt/tools/bin/claude', [])).toBe(100)
    const children = [{ pid: 200, comm: '/bin/zsh' }, { pid: 201, comm: '/opt/tools/bin/claude' }]
    expect(findClaudePidInTree(100, '/bin/zsh', children)).toBe(201)
  })

  it('a null child comm (ps lookup failed) is skipped, not matched', () => {
    const children = [{ pid: 200, comm: null }, { pid: 201, comm: 'claude' }]
    expect(findClaudePidInTree(100, 'bash', children)).toBe(201)
  })
})

describe('isClaudeComm', () => {
  it('accepts the bare name and a path ending in /claude', () => {
    expect(isClaudeComm('claude')).toBe(true)
    expect(isClaudeComm('/opt/tools/bin/claude')).toBe(true)
  })

  it('rejects look-alikes', () => {
    expect(isClaudeComm('claude-code')).toBe(false)
    expect(isClaudeComm('/opt/bin/notclaude')).toBe(false)
    expect(isClaudeComm('/opt/claude/bin/node')).toBe(false)
    expect(isClaudeComm('')).toBe(false)
  })
})

// parseChildPids: children from one `ps -axo pid=,ppid=` snapshot (the form
// both GNU and BSD ps accept; `--ppid` is GNU only).
describe('parseChildPids', () => {
  const snapshot = [
    '    1     0',
    '  100     1',
    '  200   100',
    '12345   100',
    '  300   200',
    '',
  ].join('\n')

  it('returns exactly the direct children of the parent', () => {
    expect(parseChildPids(snapshot, 100)).toEqual([200, 12345])
    expect(parseChildPids(snapshot, 200)).toEqual([300])
  })

  it('does not match a pid that is only a substring of another (10 vs 100)', () => {
    expect(parseChildPids(snapshot, 10)).toEqual([])
  })

  it('a parent without children and an empty snapshot give an empty list', () => {
    expect(parseChildPids(snapshot, 300)).toEqual([])
    expect(parseChildPids('', 100)).toEqual([])
  })

  it('skips malformed lines (header, garbage, a third column) instead of throwing', () => {
    const noisy = ['  PID  PPID', 'garbage', '  200   100 extra', '  201   100'].join('\n')
    expect(parseChildPids(noisy, 100)).toEqual([201])
  })
})

// parseEtimeOutput: `ps -o etime=` ([[dd-]hh:]mm:ss), the portable replacement
// for the GNU-only `etimes=`.
describe('parseEtimeOutput', () => {
  it('parses mm:ss, hh:mm:ss and dd-hh:mm:ss, padded or not', () => {
    expect(parseEtimeOutput('00:07\n')).toBe(7)
    expect(parseEtimeOutput('   05:12')).toBe(312)
    expect(parseEtimeOutput('01:05:23\n')).toBe(3923)
    expect(parseEtimeOutput(' 2-03:04:05\n')).toBe(183845)
  })

  it('returns null (fail-closed upstream) for empty, plain-seconds and malformed output', () => {
    expect(parseEtimeOutput('')).toBeNull()
    expect(parseEtimeOutput('\n')).toBeNull()
    expect(parseEtimeOutput('312')).toBeNull()      // the old etimes= shape is NOT etime
    expect(parseEtimeOutput('05:99')).toBeNull()
    expect(parseEtimeOutput('ps: error')).toBeNull()
  })
})

// The host's own ps, no mocks: this is the check that a GNU-only flag cannot
// pass. On a BSD/macOS host `ps --ppid` and `-o etimes=` fail outright, so the
// helpers would return [] / null and these tests fail.
describe('real ps on this host', () => {
  it('finds a spawned child via getChildPids and reads a small non-negative age', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(child.pid).toBeTypeOf('number')
      const pid = child.pid as number
      expect(getChildPids(process.pid)).toContain(pid)
      expect(getChildPids(pid)).toEqual([])
      const age = getPidAgeSeconds(pid)
      expect(age).not.toBeNull()
      expect(age as number).toBeGreaterThanOrEqual(0)
      expect(age as number).toBeLessThan(30)
      const comm = getCommForPid(pid)
      expect(comm === 'sleep' || comm?.endsWith('/sleep')).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('a pid that does not exist gives null / empty, not a throw', () => {
    // First pid in the valid range that no process holds (kill -0 -> ESRCH).
    let dead = 99000
    while (dead > 1000) {
      try { process.kill(dead, 0); dead-- } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') break
        dead--
      }
    }
    expect(getPidAgeSeconds(dead)).toBeNull()
    expect(getChildPids(dead)).toEqual([])
  })
})

// extractMcpPackageNames: pull identifying package names out of a .mcp.json
// mcpServers block, stripping runtime launchers (npx/node/bun/...), absolute
// paths, and version suffixes so the result can be matched against a running
// child's argv regardless of how it was launched.
describe('extractMcpPackageNames', () => {
  it('extracts the package name from an npx-launched server, stripping the version', () => {
    const names = extractMcpPackageNames({
      gmail: { command: 'npx', args: ['-y', 'gmail-mcp-server@1.0.30'] },
    })
    expect(names).toContain('gmail-mcp-server')
  })

  it('strips an absolute path prefix down to the basename', () => {
    const names = extractMcpPackageNames({
      filesystem: { command: '/usr/local/bin/mcp-server-filesystem' },
    })
    expect(names).toContain('mcp-server-filesystem')
  })

  it('skips runtime launchers, flags, and short/junk tokens', () => {
    const names = extractMcpPackageNames({
      x: { command: 'npx', args: ['-y', '--yes', 'bun', 'node', 'run', 'ab'] },
    })
    expect(names).toEqual([])
  })

  it('handles multiple servers and a missing/malformed args array', () => {
    const names = extractMcpPackageNames({
      a: { command: 'npx', args: ['playwright-mcp-server'] },
      b: { command: 'node' }, // no args at all
    })
    expect(names).toContain('playwright-mcp-server')
    expect(names).not.toContain('node')
  })

  it('returns an empty array for an empty mcpServers object', () => {
    expect(extractMcpPackageNames({})).toEqual([])
  })
})

// isMcpProcess: either a plugin-cache path OR a known .mcp.json package name
// in argv marks a child as infrastructure regardless of its age (a
// post-reconnect MCP server restarts fresh/young).
describe('isMcpProcess', () => {
  it('matches on the channel-plugin cache path', () => {
    expect(isMcpProcess('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/plugins/cache/telegram/index.js', [])).toBe(true)
  })

  it('matches on a known .mcp.json package pattern', () => {
    expect(isMcpProcess('node /path/to/gmail-mcp-server/index.js', ['gmail-mcp-server'])).toBe(true)
  })

  it('false when neither the plugin path nor any pattern matches', () => {
    expect(isMcpProcess('python3 scripts/run_task.py --foo', ['gmail-mcp-server'])).toBe(false)
  })

  it('false against an empty pattern list with no plugin path', () => {
    expect(isMcpProcess('bash -c "sleep 100"', [])).toBe(false)
  })
})

describe('TASKSTATE_FRESH_WINDOW_MS', () => {
  it('is exactly 10 minutes', () => {
    expect(TASKSTATE_FRESH_WINDOW_MS).toBe(10 * 60 * 1000)
  })
})

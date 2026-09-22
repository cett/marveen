import { describe, it, expect } from 'vitest'
import {
  isInfrastructureChild,
  findClaudePidInTree,
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

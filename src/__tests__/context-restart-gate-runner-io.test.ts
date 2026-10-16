// Backend coverage batch-55: the I/O-wrapped process-tree + task-state helpers in
// context-restart-gate-runner.ts that stayed uncovered after the earlier pass
// (isInfrastructureChild / findClaudePidInTree / extractMcpPackageNames /
// isMcpProcess -- see context-restart-gate-runner.test.ts) only exercised the
// pure decision cores. hasLiveChildProcesses and getLiveWorkChildArgs walk the
// real process tree via execFileSync(tmux/ps); hasLiveTaskStateFile and
// getMcpJsonPatterns read real files. All four (plus the ps-wrapper helpers
// they call: getPanePid/getCommForPid/getChildPids/getPidAgeSeconds/
// getChildArgsStr) were 0%-exercised, per coverage-final.json for this file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { writeTaskState, clearTaskState } from '../web/agent-taskstate.js'
import {
  hasLiveChildProcesses,
  claudeSessionStartMs,
  resolveClaudeSessionStart,
  getLiveWorkChildArgs,
  hasLiveTaskStateFile,
  getMcpJsonPatterns,
  extractMcpPackageNames,
} from '../web/context-restart-gate-runner.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

const SESSION = 'gate-io-test-session'

// Seconds -> the `[[dd-]hh:]mm:ss` shape of `ps -o etime=` (right-aligned and
// space padded, as BSD ps prints it).
function toEtime(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const body = d > 0 ? `${d}-${pad(h)}:${pad(m)}:${pad(s)}` : h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  return body.padStart(12)
}

// Builds an execFileSync dispatcher mimicking tmux list-panes + the four
// per-pid `ps` lookups (comm=/etime=/args=) that hasLiveChildProcesses and
// getLiveWorkChildArgs walk the process tree with.
async function mockProcessTree(opts: {
  panePid?: number | 'fail'
  comm?: Record<number, string | 'fail'>
  children?: Record<number, number[]>
  age?: Record<number, number | 'fail'>
  args?: Record<number, string | 'fail'>
}) {
  const { execFileSync } = await import('node:child_process')
  vi.mocked(execFileSync).mockImplementation(((_cmd: string, a?: readonly string[]) => {
    const args = (a ?? []) as string[]
    if (args.includes('list-panes')) {
      if (opts.panePid === undefined || opts.panePid === 'fail') throw new Error('tmux: no such session')
      return `${opts.panePid}\n` as unknown as Buffer
    }
    // The portable snapshot form: BSD ps has no --ppid. Rows are padded like
    // the real thing, with unrelated processes mixed in.
    if (args.includes('-axo')) {
      const rows = ['  1     0', ' 99999     1']
      for (const [parent, kids] of Object.entries(opts.children ?? {})) {
        for (const kid of kids) rows.push(`${String(kid).padStart(6)} ${String(parent).padStart(5)}`)
      }
      return rows.join('\n') + '\n' as unknown as Buffer
    }
    if (args[0] === '-p') {
      const pid = Number(args[1])
      if (args.includes('comm=')) {
        const v = opts.comm?.[pid]
        if (v === undefined || v === 'fail') throw new Error(`ps -o comm= failed for ${pid}`)
        return `${v}\n` as unknown as Buffer
      }
      if (args.includes('etime=')) {
        const v = opts.age?.[pid]
        if (v === undefined || v === 'fail') throw new Error(`ps -o etime= failed for ${pid}`)
        return `${toEtime(v)}\n` as unknown as Buffer
      }
      if (args.includes('args=')) {
        const v = opts.args?.[pid]
        if (v === undefined || v === 'fail') throw new Error(`ps -o args= failed for ${pid}`)
        return `${v}\n` as unknown as Buffer
      }
    }
    throw new Error('unexpected execFileSync call in gate-runner-io test: ' + JSON.stringify(args))
  }) as typeof execFileSync)
}

describe('hasLiveChildProcesses', () => {
  it('fail-closed: tmux list-panes fails (no such session) -> null', async () => {
    await mockProcessTree({})
    expect(hasLiveChildProcesses(SESSION, [])).toBeNull()
  })

  it('fail-closed: neither the pane nor any child is claude -> null', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'bash' },
      children: { 100: [] },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBeNull()
  })

  it('fail-closed: claude located but its age cannot be read -> null', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: {},
      age: { 100: 'fail' },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBeNull()
  })

  it('no children at all -> false (nothing live)', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [] },
      age: { 100: 500 },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBe(false)
  })

  it('only infrastructure children (young, near-boot MCP servers) -> false', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [200, 201] },
      age: { 100: 500, 200: 2, 201: 495 },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBe(false)
  })

  it('a young reconnected MCP server child is still infra via args pattern match', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [200] },
      age: { 100: 500, 200: 10 },
      args: { 200: 'node /plugins/cache/telegram/index.js' },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBe(false)
  })

  it('a live work child (Task-tool subagent, mid-session, not MCP-shaped) -> true', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [200] },
      age: { 100: 500, 200: 300 },
      args: { 200: 'bash -c npm run build' },
    })
    expect(hasLiveChildProcesses(SESSION, ['some-mcp-pkg'])).toBe(true)
  })

  it('wrapper shape: pane is bash, claude is a child -> inspects claude own children', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'bash', 101: 'claude' },
      children: { 100: [101], 101: [202] },
      age: { 101: 500, 202: 300 },
      args: { 202: 'bash -c echo work' },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBe(true)
  })

  it('fail-closed mid-loop: a child age cannot be read -> null', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [200] },
      age: { 100: 500, 200: 'fail' },
    })
    expect(hasLiveChildProcesses(SESSION, [])).toBeNull()
  })
})

describe('claudeSessionStartMs', () => {
  const NOW = 1_800_000_000_000

  it('direct shape: now minus the claude process age', async () => {
    await mockProcessTree({ panePid: 100, comm: { 100: 'claude' }, children: { 100: [] }, age: { 100: 600 } })
    expect(claudeSessionStartMs(SESSION, NOW)).toBe(NOW - 600_000)
  })

  it('wrapper shape: uses the claude child, not the wrapper shell', async () => {
    await mockProcessTree({
      panePid: 100, comm: { 100: 'bash', 101: 'claude' }, children: { 100: [101] }, age: { 100: 9000, 101: 120 },
    })
    expect(claudeSessionStartMs(SESSION, NOW)).toBe(NOW - 120_000)
  })

  it('cannot tell -> null (no pane, no claude in the tree, or no age)', async () => {
    await mockProcessTree({})
    expect(claudeSessionStartMs(SESSION, NOW)).toBeNull()
    await mockProcessTree({ panePid: 100, comm: { 100: 'bash' }, children: { 100: [] } })
    expect(claudeSessionStartMs(SESSION, NOW)).toBeNull()
    await mockProcessTree({ panePid: 100, comm: { 100: 'claude' }, children: { 100: [] }, age: { 100: 'fail' } })
    expect(claudeSessionStartMs(SESSION, NOW)).toBeNull()
  })
})

describe('getLiveWorkChildArgs', () => {
  it('collects args strings of live (non-infra, non-MCP) children only', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [200, 201, 202] },
      age: { 100: 500, 200: 2, 201: 300, 202: 310 },
      args: { 201: 'bash -c npm run build', 202: 'node /plugins/cache/telegram/index.js' },
    })
    expect(getLiveWorkChildArgs(SESSION, [])).toEqual(['bash -c npm run build'])
  })

  it('falls back to a "PID N" placeholder when args cannot be read for a live child', async () => {
    await mockProcessTree({
      panePid: 100,
      comm: { 100: 'claude' },
      children: { 100: [200] },
      age: { 100: 500, 200: 300 },
      args: { 200: 'fail' },
    })
    expect(getLiveWorkChildArgs(SESSION, [])).toEqual(['PID 200'])
  })

  it('any failure in the walk is swallowed -> []', async () => {
    await mockProcessTree({})
    expect(getLiveWorkChildArgs(SESSION, [])).toEqual([])
  })
})

describe('hasLiveTaskStateFile', () => {
  const AGENT = 'gate-io-taskstate-agent'
  const nowMs = 1_800_000_000_000

  afterEach(() => clearTaskState(AGENT))

  it('no record on disk -> false', () => {
    clearTaskState(AGENT)
    expect(hasLiveTaskStateFile(AGENT, nowMs)).toBe(false)
  })

  it('fresh, non-empty, unconsumed record -> true', () => {
    writeTaskState(AGENT, { nextAction: 'resume step 3', summary: 'mid-refactor' }, nowMs - 60_000)
    expect(hasLiveTaskStateFile(AGENT, nowMs)).toBe(true)
  })

  it('record older than the 10-minute fresh window -> false', () => {
    writeTaskState(AGENT, { nextAction: 'resume step 3' }, nowMs - 11 * 60_000)
    expect(hasLiveTaskStateFile(AGENT, nowMs)).toBe(false)
  })

  it('record with an empty nextAction -> false (nothing to resume)', () => {
    writeTaskState(AGENT, { nextAction: '   ' }, nowMs - 60_000)
    expect(hasLiveTaskStateFile(AGENT, nowMs)).toBe(false)
  })

  it('corrupt JSON on disk -> false (fail-open, does not throw)', () => {
    const dir = join(STORE_DIR, 'agent-taskstate')
    if (!existsSync(dir)) writeTaskState(AGENT, { nextAction: 'x' }, nowMs)
    writeFileSync(join(dir, `${AGENT}.json`), '{not valid json')
    expect(hasLiveTaskStateFile(AGENT, nowMs)).toBe(false)
  })
})

describe('getMcpJsonPatterns', () => {
  let workingDir: string

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'gate-io-mcpjson-'))
  })

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true })
  })

  it('no .mcp.json in the working dir -> []', () => {
    expect(getMcpJsonPatterns(workingDir)).toEqual([])
  })

  it('malformed .mcp.json -> [] (fail-closed, does not throw)', () => {
    writeFileSync(join(workingDir, '.mcp.json'), '{not valid json')
    expect(getMcpJsonPatterns(workingDir)).toEqual([])
  })

  it('extracts package name patterns from a real .mcp.json', () => {
    writeFileSync(join(workingDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        gmail: { command: 'npx', args: ['-y', 'gmail-mcp-server@1.0.30'] },
      },
    }))
    expect(getMcpJsonPatterns(workingDir)).toEqual(['gmail-mcp-server'])
  })
})

describe('extractMcpPackageNames edge cases', () => {
  it('skips a non-string / falsy arg entry without throwing', () => {
    expect(extractMcpPackageNames({
      weird: { command: 'node', args: [null, 0, '', 'gmail-mcp-server@1.0.30'] },
    })).toEqual(['gmail-mcp-server'])
  })
})

describe('resolveClaudeSessionStart: says why the start is unknown', () => {
  const NOW = 1_800_000_000_000

  it('known start carries no reason', async () => {
    await mockProcessTree({ panePid: 100, comm: { 100: 'claude' }, children: { 100: [] }, age: { 100: 600 } })
    expect(resolveClaudeSessionStart(SESSION, NOW)).toEqual({ startMs: NOW - 600_000, reason: null })
  })

  it('no tmux pane -> reason names the session', async () => {
    await mockProcessTree({})
    const r = resolveClaudeSessionStart(SESSION, NOW)
    expect(r.startMs).toBeNull()
    expect(r.reason).toContain(SESSION)
  })

  it('claude not under the pane -> its own reason', async () => {
    await mockProcessTree({ panePid: 100, comm: { 100: 'bash' }, children: { 100: [] } })
    expect(resolveClaudeSessionStart(SESSION, NOW).reason).toMatch(/claude process not found/)
  })

  it('ps cannot read the age -> its own reason', async () => {
    await mockProcessTree({ panePid: 100, comm: { 100: 'claude' }, children: { 100: [] }, age: { 100: 'fail' } })
    expect(resolveClaudeSessionStart(SESSION, NOW).reason).toMatch(/could not read the age/)
  })
})

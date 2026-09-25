// Coverage for the two orchestration-level pieces of
// src/web/schedule-mcp-precheck.ts that schedule-mcp-precheck.test.ts does not
// reach: resolveMcpProcessPatterns (reads + merges .mcp.json files) and
// checkTaskMcpRequirements (the full pre-check pipeline, fail-open gates
// included). The pure helpers (deriveProcessPattern, collectSubtreeCmdlines,
// decideMcpPrecheck) already have their own coverage there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

let projectRoot: string
let agentsBaseDir: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'mcp-precheck-root-'))
  agentsBaseDir = mkdtempSync(join(tmpdir(), 'mcp-precheck-agents-'))
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>()
    return { ...actual, PROJECT_ROOT: projectRoot }
  })
})

afterEach(() => {
  vi.doUnmock('../config.js')
  vi.doUnmock('../web/agent-config.js')
  vi.doUnmock('../channel-coordinator/liveness.js')
  rmSync(projectRoot, { recursive: true, force: true })
  rmSync(agentsBaseDir, { recursive: true, force: true })
})

function writeMcpJson(dir: string, mcpServers: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers }))
}

async function loadResolve() {
  const mod = await import('../web/schedule-mcp-precheck.js')
  return mod.resolveMcpProcessPatterns
}

describe('resolveMcpProcessPatterns', () => {
  it('returns {} when no .mcp.json exists anywhere', async () => {
    const resolve = await loadResolve()
    expect(resolve(null)).toEqual({})
  })

  it('derives patterns from the project-root .mcp.json', async () => {
    writeMcpJson(projectRoot, {
      gmail: { command: 'node', args: ['/opt/mcp/gmail/dist/index.js'] },
      garmin: { command: 'garmin-mcp', args: [] },
    })
    const resolve = await loadResolve()
    expect(resolve(null)).toEqual({
      gmail: '/opt/mcp/gmail/dist/index.js',
      garmin: 'garmin-mcp',
    })
  })

  it('merges the agent .mcp.json, agent winning on name collision', async () => {
    writeMcpJson(projectRoot, { gmail: { command: 'node', args: ['/root/gmail/index.js'] } })
    const agentDir = join(agentsBaseDir, 'alice')
    writeMcpJson(agentDir, { gmail: { command: 'node', args: ['/root/alice-gmail/index.js'] }, ollama: { command: 'ollama-mcp', args: [] } })
    vi.doMock('../web/agent-config.js', () => ({ agentDir: (name: string) => join(agentsBaseDir, name) }))
    const resolve = await loadResolve()
    expect(resolve('alice')).toEqual({
      gmail: '/root/alice-gmail/index.js',
      ollama: 'ollama-mcp',
    })
  })

  it('falls back to the root config only when agentDir throws (unknown agent)', async () => {
    writeMcpJson(projectRoot, { gmail: { command: 'node', args: ['/root/gmail/index.js'] } })
    vi.doMock('../web/agent-config.js', () => ({
      agentDir: () => { throw new Error('unknown agent') },
    }))
    const resolve = await loadResolve()
    expect(resolve('nonexistent')).toEqual({ gmail: '/root/gmail/index.js' })
  })

  it('skips an unparsable .mcp.json without throwing (fail-open)', async () => {
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(join(projectRoot, '.mcp.json'), '{not valid json')
    const resolve = await loadResolve()
    expect(resolve(null)).toEqual({})
  })

  it('omits a server whose pattern cannot be derived', async () => {
    writeMcpJson(projectRoot, { noop: {} })
    const resolve = await loadResolve()
    expect(resolve(null)).toEqual({})
  })
})

describe('checkTaskMcpRequirements', () => {
  async function loadCheck() {
    const mod = await import('../web/schedule-mcp-precheck.js')
    return mod.checkTaskMcpRequirements
  }

  it('ok:true with no calls made when required is undefined/empty', async () => {
    const { execFileSync } = await import('node:child_process')
    const check = await loadCheck()
    expect(check(undefined, 'alice', 'alice-session', null)).toEqual({ ok: true, missing: [], unknown: [] })
    expect(check([], 'alice', 'alice-session', null)).toEqual({ ok: true, missing: [], unknown: [] })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('ok:true (skipped) for a remote session (host set)', async () => {
    const check = await loadCheck()
    expect(check(['gmail'], 'alice', 'alice-session', 'remote.example.com')).toEqual({ ok: true, missing: [], unknown: [] })
  })

  it('ok:true (skipped) when the claude pid cannot be resolved', async () => {
    vi.doMock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession: () => null }))
    const check = await loadCheck()
    expect(check(['gmail'], 'alice', 'alice-session', null)).toEqual({ ok: true, missing: [], unknown: [] })
  })

  it('ok:true (skipped) when the ps snapshot fails', async () => {
    vi.doMock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession: () => 200 }))
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('ps failed') })
    const check = await loadCheck()
    expect(check(['gmail'], 'alice', 'alice-session', null)).toEqual({ ok: true, missing: [], unknown: [] })
  })

  it('blocks on a required server with no live process under the session', async () => {
    writeMcpJson(projectRoot, { gmail: { command: 'node', args: ['/opt/mcp/gmail/dist/index.js'] } })
    vi.doMock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession: () => 200 }))
    const ps = [
      '  PID  PPID COMMAND',
      '  200     1 claude',
      '  201   200 npm exec ollama-mcp',
    ].join('\n')
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementationOnce(() => ps)
    const check = await loadCheck()
    const result = check(['gmail'], 'alice', 'alice-session', null)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['gmail'])
  })

  it('passes when the required server has a live process under the session', async () => {
    writeMcpJson(projectRoot, { gmail: { command: 'node', args: ['/opt/mcp/gmail/dist/index.js'] } })
    vi.doMock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession: () => 200 }))
    const ps = [
      '  PID  PPID COMMAND',
      '  200     1 claude',
      '  201   200 node /opt/mcp/gmail/dist/index.js',
    ].join('\n')
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementationOnce(() => ps)
    const check = await loadCheck()
    expect(check(['gmail'], 'alice', 'alice-session', null)).toEqual({ ok: true, missing: [], unknown: [] })
  })

  it('reports an undeclared required server as unknown, not missing (fail-open)', async () => {
    vi.doMock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession: () => 200 }))
    const ps = ['  PID  PPID COMMAND', '  200     1 claude'].join('\n')
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementationOnce(() => ps)
    const check = await loadCheck()
    const result = check(['nonexistent-server'], 'alice', 'alice-session', null)
    expect(result.ok).toBe(true)
    expect(result.unknown).toEqual(['nonexistent-server'])
  })
})

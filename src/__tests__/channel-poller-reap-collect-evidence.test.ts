// Coverage for collectPollerEvidence (src/web/channel-poller-reap.ts),
// previously untested. It is the I/O wiring around the already-covered pure
// core buildPollerEvidence (see poller-evidence.test.ts): reads bot.pid off
// disk, scans `ps eww -e` for env-var-matched pollers, snapshots `ps -axww`
// for the process tree, and combines them. execSync is mocked (differentiated
// by the command string, matching the two distinct ps invocations); bot.pid
// is a real file under a temp channel-state dir via channelStateDir's own
// agentDir override, so no filesystem mocking is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

import { execSync } from 'node:child_process'
import { channelStateDir } from '../channel-provider.js'
import { collectPollerEvidence } from '../web/channel-poller-reap.js'

let agentDirPath: string
let chanDir: string

beforeEach(() => {
  agentDirPath = mkdtempSync(join(tmpdir(), 'poller-evidence-agent-'))
  chanDir = channelStateDir('telegram', agentDirPath)
  mkdirSync(chanDir, { recursive: true })
  vi.mocked(execSync).mockReset()
})

afterEach(() => {
  rmSync(agentDirPath, { recursive: true, force: true })
})

function mockPs(opts: { snapshot?: string; envScan?: string }) {
  vi.mocked(execSync).mockImplementation(((cmd: string) => {
    if (cmd.startsWith('/bin/ps -axww')) return opts.snapshot ?? ''
    if (cmd === '/bin/ps eww -e') return opts.envScan ?? ''
    throw new Error('unexpected execSync command: ' + cmd)
  }) as typeof execSync)
}

describe('collectPollerEvidence', () => {
  it('no-poller: no bot.pid, no env-scan match, nothing alive', () => {
    mockPs({ snapshot: '', envScan: '' })
    const evidence = collectPollerEvidence('telegram', agentDirPath, 100)
    expect(evidence).toEqual({
      botPid: null,
      botPidAlive: false,
      envScanPids: [],
      rows: [],
      interpretation: 'no-poller',
    })
  })

  it('in-tree: bot.pid alive and parented under claudePid', () => {
    writeFileSync(join(chanDir, 'bot.pid'), '300\n')
    const snapshot = [
      '100 1 claude --channels plugin:telegram',
      '200 100 bun run --cwd /plugins/telegram start',
      '300 200 bun server.ts',
    ].join('\n')
    mockPs({ snapshot, envScan: '' })
    const evidence = collectPollerEvidence('telegram', agentDirPath, 100)
    expect(evidence.botPid).toBe(300)
    expect(evidence.botPidAlive).toBe(true)
    expect(evidence.interpretation).toBe('in-tree')
    expect(evidence.rows).toEqual([{ pid: 300, ppid: 200, inClaudeTree: true }])
  })

  it('no-poller: bot.pid file exists but the process is gone from the ps snapshot', () => {
    writeFileSync(join(chanDir, 'bot.pid'), '999\n')
    mockPs({ snapshot: '100 1 claude --channels plugin:telegram', envScan: '' })
    const evidence = collectPollerEvidence('telegram', agentDirPath, 100)
    expect(evidence.botPid).toBe(999)
    expect(evidence.botPidAlive).toBe(false)
    expect(evidence.rows).toEqual([])
    expect(evidence.interpretation).toBe('no-poller')
  })

  it('orphaned: env-scan finds a live poller reparented outside the claude tree', () => {
    const snapshot = [
      '100 1 claude --channels plugin:telegram',
      // Reparented to init -- ancestor chain never reaches claudePid.
      '500 1 bun server.ts',
    ].join('\n')
    const envScan = `500 s000 S+ 0:00.01 bun server.ts HOME=/x TELEGRAM_STATE_DIR=${chanDir}`
    mockPs({ snapshot, envScan })
    const evidence = collectPollerEvidence('telegram', agentDirPath, 100)
    expect(evidence.botPid).toBeNull()
    expect(evidence.envScanPids).toEqual([500])
    expect(evidence.interpretation).toBe('orphaned')
    expect(evidence.rows).toEqual([{ pid: 500, ppid: 1, inClaudeTree: false }])
  })

  it('env-scan only matches pids whose TELEGRAM_STATE_DIR equals this chanDir', () => {
    const snapshot = '100 1 claude --channels plugin:telegram\n600 1 bun server.ts'
    const envScan = `600 s000 S+ 0:00.01 bun server.ts HOME=/x TELEGRAM_STATE_DIR=/some/other/agent/channels/telegram`
    mockPs({ snapshot, envScan })
    const evidence = collectPollerEvidence('telegram', agentDirPath, 100)
    expect(evidence.envScanPids).toEqual([])
    expect(evidence.interpretation).toBe('no-poller')
  })

  it('a failed ps scan is treated as no processes found, not a throw', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('ps unavailable') })
    expect(() => collectPollerEvidence('telegram', agentDirPath, 100)).not.toThrow()
    const evidence = collectPollerEvidence('telegram', agentDirPath, 100)
    expect(evidence.interpretation).toBe('no-poller')
  })
})

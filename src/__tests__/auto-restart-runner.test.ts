// Test suite for auto-restart-runner (#751 step 27).
// The runner drives per-agent scheduled restarts on a 60s sweep, seeded on
// first sight so a past-due slot never fires spuriously on boot. Pure due
// logic (restartDue/dailyDueAtMs/parseHHMM/mainRestartMechanism) already has
// its own coverage in auto-restart.test.ts, so this file exercises the I/O
// orchestration: idle-guard, seed-on-first-sight, main-vs-sub-agent restart
// paths, and error containment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockListAgentNames = vi.hoisted(() => vi.fn(() => [] as string[]))
const mockReadAgentRemoteHost = vi.hoisted(() => vi.fn(() => null as string | null))
const mockAgentRunState = vi.hoisted(() => vi.fn(() => 'running' as string))
const mockAgentSessionName = vi.hoisted(() => vi.fn((name: string) => `session-${name}`))
const mockRestartAgentProcess = vi.hoisted(() => vi.fn())
const mockCapturePane = vi.hoisted(() => vi.fn(() => 'pane text'))
const mockRespawnMainSessionFresh = vi.hoisted(() => vi.fn())
const mockPaneLooksIdle = vi.hoisted(() => vi.fn(() => true))
const mockReadAutoRestartConfig = vi.hoisted(() => vi.fn())
const mockExecFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn(() => false))
const mockLoggerInfo = vi.hoisted(() => vi.fn())
const mockLoggerWarn = vi.hoisted(() => vi.fn())
const mockLoggerDebug = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }))
vi.mock('node:fs', () => ({ existsSync: mockExistsSync }))
vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, debug: mockLoggerDebug },
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: mockListAgentNames,
  readAgentRemoteHost: mockReadAgentRemoteHost,
}))
vi.mock('../web/agent-process.js', () => ({
  agentRunState: mockAgentRunState,
  agentSessionName: mockAgentSessionName,
  restartAgentProcess: mockRestartAgentProcess,
  capturePane: mockCapturePane,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels-session' }))
vi.mock('../web/channel-monitor.js', () => ({ respawnMainSessionFresh: mockRespawnMainSessionFresh }))
vi.mock('../pane-state.js', () => ({ paneLooksIdle: mockPaneLooksIdle }))
vi.mock('../web/auto-restart-store.js', () => ({ readAutoRestartConfig: mockReadAutoRestartConfig }))
// ../auto-restart.js and ../config.js are pure/dependency-free -- used for real.

const DEFAULT_CFG = { enabled: true, mode: 'continue' as const, dailyTime: null, intervalHours: 1, handoff: false }

async function loadRunner() {
  const mod = await import('../web/auto-restart-runner.js')
  return mod.startAutoRestartRunner
}

describe('auto-restart-runner', () => {
  let MAIN_AGENT_ID: string

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const configMod = await import('../config.js')
    MAIN_AGENT_ID = configMod.MAIN_AGENT_ID

    mockListAgentNames.mockReturnValue([])
    mockReadAgentRemoteHost.mockReturnValue(null)
    mockAgentRunState.mockReturnValue('running')
    mockAgentSessionName.mockImplementation((name: string) => `session-${name}`)
    mockRestartAgentProcess.mockReset()
    mockCapturePane.mockReturnValue('pane text')
    mockRespawnMainSessionFresh.mockReset()
    mockPaneLooksIdle.mockReturnValue(true)
    mockReadAutoRestartConfig.mockReset()
    mockReadAutoRestartConfig.mockReturnValue(DEFAULT_CFG)
    mockExecFileSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockLoggerInfo.mockClear()
    mockLoggerWarn.mockClear()
    mockLoggerDebug.mockClear()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('seeds on first sight without restarting', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000) // initial delay -> first sweep

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('restarts a sub-agent once intervalHours elapses and the pane is idle', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockReadAutoRestartConfig.mockReturnValue({ ...DEFAULT_CFG, mode: 'fresh', intervalHours: 1 })
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000) // seed
    vi.advanceTimersByTime(3_700_000) // past +1h due, aligned to a 60s tick

    expect(mockRestartAgentProcess).toHaveBeenCalledWith('zack', { fresh: true })
  })

  it('does not restart when the pane is busy (idle guard) and logs why', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockPaneLooksIdle.mockReturnValue(false)
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { name: 'zack', session: 'session-zack' },
      'auto-restart: due but pane is busy, deferring to next tick',
    )
  })

  it('never restarts a sub-agent that is not running', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockAgentRunState.mockReturnValue('stopped')
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    // The main agent (always eligible) still runs its own idle check each
    // sweep -- only zack's session must never be probed.
    expect(mockPaneLooksIdle).not.toHaveBeenCalledWith('session-zack', null)
  })

  it('re-seeds cleanly when disabled and never restarts', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockReadAutoRestartConfig.mockReturnValue({ ...DEFAULT_CFG, enabled: false })
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('restarts the main channels session via launchd when launchctl is present', async () => {
    mockExistsSync.mockReturnValue(true) // /bin/launchctl present
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/bin/launchctl',
      expect.arrayContaining(['kickstart', '-k']),
      expect.objectContaining({ timeout: 10_000 }),
    )
    const [, args] = mockExecFileSync.mock.calls[0]
    expect(args[2]).toMatch(/^gui\/.*\/com\..+\.channels$/)
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
  })

  it('restarts the main channels session via tmux respawn when launchctl is absent', async () => {
    mockExistsSync.mockReturnValue(false)
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockRespawnMainSessionFresh).toHaveBeenCalledTimes(1)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('never checks agentRunState for the main agent (always eligible)', async () => {
    mockAgentRunState.mockReturnValue('stopped')
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockRespawnMainSessionFresh).toHaveBeenCalledTimes(1)
  })

  it('logs a warning and keeps the agent due (retries) when the restart throws', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockRestartAgentProcess.mockImplementation(() => {
      throw new Error('boom')
    })
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_700_000)

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { err: expect.any(Error), name: 'zack' },
      'auto-restart: restart failed',
    )

    // lastRestart was never updated on failure, so the next elapsed interval
    // is due again immediately (no need to wait another full hour).
    mockRestartAgentProcess.mockReset()
    vi.advanceTimersByTime(60_000)
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('zack', { fresh: false })
  })

  it('fires a daily-time restart once the wall-clock crosses the scheduled slot', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockReadAutoRestartConfig.mockReturnValue({ ...DEFAULT_CFG, dailyTime: '00:00', intervalHours: null })
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000) // seed
    vi.advanceTimersByTime(24 * 3_600_000 + 60_000) // cross into the next day

    expect(mockRestartAgentProcess).toHaveBeenCalledWith('zack', { fresh: false })
  })

  it('never restarts when dailyTime is malformed', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    mockReadAutoRestartConfig.mockReturnValue({ ...DEFAULT_CFG, dailyTime: 'not-a-time', intervalHours: null })
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(24 * 3_600_000 + 60_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('catches a per-agent check error without aborting the sweep for other agents', async () => {
    mockListAgentNames.mockReturnValue(['broken', 'zack'])
    mockReadAutoRestartConfig.mockImplementation((name: string) => {
      if (name === 'broken') throw new Error('config read failed')
      return DEFAULT_CFG
    })
    const start = await loadRunner()

    expect(() => {
      start()
      vi.advanceTimersByTime(40_000)
    }).not.toThrow()

    expect(mockLoggerDebug).toHaveBeenCalledWith(
      { err: expect.any(Error), agent: 'broken' },
      'auto-restart: agent check error',
    )
    // The main-agent check error path uses its own message shape.
    vi.advanceTimersByTime(3_700_000)
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('zack', { fresh: false })
  })

  it('sweeps the main agent and every name from listAgentNames on each tick', async () => {
    mockListAgentNames.mockReturnValue(['zack', 'jarvis'])
    mockReadAutoRestartConfig.mockReturnValue({ ...DEFAULT_CFG, enabled: false })
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(40_000)

    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith(MAIN_AGENT_ID)
    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith('zack')
    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith('jarvis')
  })

  it('does not sweep before the initial 40s delay elapses', async () => {
    mockListAgentNames.mockReturnValue(['zack'])
    const start = await loadRunner()
    start()

    vi.advanceTimersByTime(39_999)

    expect(mockReadAutoRestartConfig).not.toHaveBeenCalled()
  })
})

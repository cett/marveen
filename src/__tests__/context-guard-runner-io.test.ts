// Test suite for context-guard-runner (coverage series, context-guard-runner
// layer 2). Scope: the I/O orchestration left uncovered by layer 1
// (context-guard-runner.test.ts) -- checkAgent, performRestart and
// startContextGuardRunner. All three are module-private, so they are driven
// exclusively through the module's exported surface: startContextGuardRunner()
// (fake timers trigger its sweep -> checkAgent), and getHardGuardPhase() /
// getContextGuardStatus() to observe the resulting guardStates transitions.
//
// The runner keeps its guard state (guardStates / remoteSkipLogged /
// lastDailyHandoffAt) in module-level Maps keyed by agent name, and
// MAIN_AGENT_ID is the same constant across every test -- so, mirroring
// auto-restart-runner.test.ts (the sibling runner this module was modeled
// on), each test calls vi.resetModules() and re-imports the runner fresh,
// giving every test its own guardStates map instead of leaking phase
// transitions between tests that both touch the main agent. All mock
// functions are created via vi.hoisted() so the SAME instances survive the
// module-cache reset (a plain vi.fn() inside a vi.mock() factory would be
// re-created on every re-import, silently detaching the test's assertions
// from the calls the fresh module instance actually makes).
//
// Probes that layer 1 stubbed with one fixed return value are here keyed by
// the argument the mock actually receives (dir/name/session/pane text) so
// multiple agents in the same sweep can be driven independently without
// relying on call order.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  DEFAULT_CFG,
  cfgByAgent,
  remoteHostByAgent,
  runStateByAgent,
  paneBySession,
  paneStateByPane,
  paneSaturatedByPane,
  sessionReadyBySession,
  contextTokensByDir,
  transcriptMtimeByDir,
  handoffMtimeByAgent,
  mockListAgentNames,
  mockAgentRunState,
  mockAgentSessionName,
  mockRestartAgentProcess,
  mockCapturePane,
  mockSendPromptToSession,
  mockIsSessionReadyForPrompt,
  mockReadAgentRemoteHost,
  mockDetectPaneState,
  mockPaneShowsContextSaturation,
  mockReadContextTokensFromProjectDir,
  mockReadTranscriptMtimeFromProjectDir,
  mockReadContextGuardConfig,
  mockCreateAgentMessage,
  mockGetWorkspaceDocUpdatedAtMs,
  mockAppendActivePlanMarkerToHandoff,
  mockHardRestartMarveenChannels,
  mockLastMainRespawnAt,
  mockShouldDeferForRecentRespawn,
  mockWriteFileSync,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerDebug,
} = vi.hoisted(() => {
  const DEFAULT_CFG = {
    enabled: false,
    saturationRestart: false,
    actPct: 0.9,
    hardPct: 0.97,
    limitTokens: null as number | null,
    cooldownMinutes: 15,
    handoffTimeoutMinutes: 20,
    idleFlushEnabled: false,
    idleFlushTokens: 400_000,
    idleMinutes: 20,
    dailyHandoffEnabled: false,
    dailyHandoffTime: null as string | null,
  }
  const cfgByAgent = new Map<string, typeof DEFAULT_CFG>()
  const remoteHostByAgent = new Map<string, string | null>()
  const runStateByAgent = new Map<string, string>()
  const paneBySession = new Map<string, string | null>()
  const paneStateByPane = new Map<string, 'idle' | 'busy' | 'unknown'>()
  const paneSaturatedByPane = new Map<string, boolean>()
  const sessionReadyBySession = new Map<string, boolean>()
  const contextTokensByDir = new Map<string, number | null>()
  const transcriptMtimeByDir = new Map<string, number | null>()
  const handoffMtimeByAgent = new Map<string, number | null>()

  return {
    DEFAULT_CFG,
    cfgByAgent,
    remoteHostByAgent,
    runStateByAgent,
    paneBySession,
    paneStateByPane,
    paneSaturatedByPane,
    sessionReadyBySession,
    contextTokensByDir,
    transcriptMtimeByDir,
    handoffMtimeByAgent,
    mockListAgentNames: vi.fn(() => [] as string[]),
    mockAgentRunState: vi.fn((name: string) => runStateByAgent.get(name) ?? 'running'),
    mockAgentSessionName: vi.fn((name: string) => `session-${name}`),
    mockRestartAgentProcess: vi.fn(),
    mockCapturePane: vi.fn((session: string) => (paneBySession.has(session) ? paneBySession.get(session)! : `PANE:${session}`)),
    mockSendPromptToSession: vi.fn(async (_session: string, _prompt: string) => {}),
    mockIsSessionReadyForPrompt: vi.fn(async (session: string) => sessionReadyBySession.get(session) ?? false),
    mockReadAgentRemoteHost: vi.fn((name: string) => remoteHostByAgent.get(name) ?? null),
    mockDetectPaneState: vi.fn((pane: string) => paneStateByPane.get(pane) ?? 'unknown'),
    mockPaneShowsContextSaturation: vi.fn((pane: string) => paneSaturatedByPane.get(pane) ?? false),
    mockReadContextTokensFromProjectDir: vi.fn((dir: string) => contextTokensByDir.get(dir) ?? null),
    mockReadTranscriptMtimeFromProjectDir: vi.fn((dir: string) => transcriptMtimeByDir.get(dir) ?? null),
    mockReadContextGuardConfig: vi.fn((name: string) => cfgByAgent.get(name) ?? DEFAULT_CFG),
    mockCreateAgentMessage: vi.fn(),
    mockGetWorkspaceDocUpdatedAtMs: vi.fn((name: string) => handoffMtimeByAgent.get(name) ?? null),
    mockAppendActivePlanMarkerToHandoff: vi.fn(),
    mockHardRestartMarveenChannels: vi.fn(() => ({ ok: true }) as { ok: boolean; error?: string }),
    mockLastMainRespawnAt: vi.fn(() => null as number | null),
    mockShouldDeferForRecentRespawn: vi.fn(() => false),
    mockWriteFileSync: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerDebug: vi.fn(),
  }
})

vi.mock('node:fs', () => ({
  statSync: vi.fn(() => { throw new Error('ENOENT (test fixture: no real file)') }),
  readFileSync: vi.fn(() => { throw new Error('ENOENT (test fixture: no real file)') }),
  writeFileSync: mockWriteFileSync,
}))

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, debug: mockLoggerDebug },
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: mockHardRestartMarveenChannels,
  lastMainRespawnAt: mockLastMainRespawnAt,
  MARVEEN_POST_RESPAWN_GRACE_MS: 60_000,
}))

vi.mock('../web/stuck-tool-call-watcher.js', () => ({
  shouldDeferForRecentRespawn: mockShouldDeferForRecentRespawn,
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: mockListAgentNames,
  listAllAgentNames: vi.fn(() => []),
  agentDir: vi.fn((name: string) => `/agents/${name}`),
  readAgentModel: vi.fn(() => 'claude-opus-5'),
  readAgentClaudeConfigDir: vi.fn(() => null),
  readAgentRemoteHost: mockReadAgentRemoteHost,
}))

vi.mock('../web/agent-process.js', () => ({
  agentRunState: mockAgentRunState,
  agentSessionName: mockAgentSessionName,
  restartAgentProcess: mockRestartAgentProcess,
  capturePane: mockCapturePane,
  sendPromptToSession: mockSendPromptToSession,
  isSessionReadyForPrompt: mockIsSessionReadyForPrompt,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'main-channels-session',
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: mockDetectPaneState,
  paneShowsContextSaturation: mockPaneShowsContextSaturation,
}))

vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: mockReadContextTokensFromProjectDir,
  readActiveModelFromProjectDir: vi.fn(() => null),
  readTranscriptMtimeFromProjectDir: mockReadTranscriptMtimeFromProjectDir,
}))

vi.mock('../web/context-guard-store.js', () => ({
  readContextGuardConfig: mockReadContextGuardConfig,
}))

vi.mock('../db.js', () => ({
  createAgentMessage: mockCreateAgentMessage,
}))

vi.mock('../workspace-store.js', () => ({
  getWorkspaceDocUpdatedAtMs: mockGetWorkspaceDocUpdatedAtMs,
}))

vi.mock('../web/claude-plan-handoff-marker.js', () => ({
  appendActivePlanMarkerToHandoff: mockAppendActivePlanMarkerToHandoff,
}))

// ../auto-restart.js and ../context-guard.js are pure/dependency-free, and
// ../config.js only reads env constants -- all three used for real (same
// rationale as layer 1).

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000

function setCfg(name: string, overrides: Partial<typeof DEFAULT_CFG>): void {
  cfgByAgent.set(name, { ...DEFAULT_CFG, ...overrides })
}

function mainSession(): string {
  return 'main-channels-session'
}

function subSession(name: string): string {
  return `session-${name}`
}

function subDir(name: string): string {
  return `/agents/${name}`
}

/** Arrange a session's pane as running + idle + not saturated, unless overridden. */
function armSession(session: string, opts: { paneState?: 'idle' | 'busy' | 'unknown'; saturated?: boolean; running?: boolean } = {}): void {
  if (opts.running === false) {
    paneBySession.set(session, null)
    return
  }
  const pane = `PANE:${session}`
  paneBySession.set(session, pane)
  paneStateByPane.set(pane, opts.paneState ?? 'idle')
  paneSaturatedByPane.set(pane, opts.saturated ?? false)
}

async function loadRunner() {
  const mod = await import('../web/context-guard-runner.js')
  return mod
}

// startContextGuardRunner() schedules TWO independent timers: a one-shot
// setTimeout for the first sweep (INITIAL_DELAY_MS) and a setInterval for
// every sweep after (INTERVAL_MS), both counted from t=0 (runner start).
// Because INITIAL_DELAY_MS < INTERVAL_MS, they are NOT evenly spaced: sweep 0
// fires at INITIAL_DELAY_MS, sweep 1 at INTERVAL_MS (a much shorter gap after
// sweep 0 than a full interval), sweep 2 at 2*INTERVAL_MS, and so on. Tests
// must advance to these exact ticks -- checkAgent() is async (real awaits on
// sendPromptToSession/isSessionReadyForPrompt), so vi.advanceTimersByTimeAsync
// is required too: the plain sync version does not flush the microtasks
// between one `await checkAgent(...)` and the next, so a second sweep in the
// same synchronous advance silently never executes its own body.
let elapsedMs = 0
let sweepIndex = 0

/** The nowMs the NEXT call to runNextSweep() will fire at, without advancing
 *  anything -- lets a test set up mocks (e.g. a transcript mtime) relative to
 *  that exact timestamp before the sweep that reads them actually runs. */
function peekNextSweepMs(): number {
  return sweepIndex === 0 ? INITIAL_DELAY_MS : sweepIndex * INTERVAL_MS
}

/** Advance the fake clock to the next scheduled sweep and return the nowMs
 *  checkAgent() sees for it. */
async function runNextSweep(): Promise<number> {
  const tickMs = peekNextSweepMs()
  sweepIndex += 1
  const delta = tickMs + 1 - elapsedMs
  elapsedMs = tickMs + 1
  await vi.advanceTimersByTimeAsync(delta)
  return tickMs
}

let MAIN_AGENT_ID: string
let handle: NodeJS.Timeout | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  elapsedMs = 0
  sweepIndex = 0
  const configMod = await import('../config.js')
  MAIN_AGENT_ID = configMod.MAIN_AGENT_ID

  cfgByAgent.clear()
  remoteHostByAgent.clear()
  runStateByAgent.clear()
  paneBySession.clear()
  paneStateByPane.clear()
  paneSaturatedByPane.clear()
  sessionReadyBySession.clear()
  contextTokensByDir.clear()
  transcriptMtimeByDir.clear()
  handoffMtimeByAgent.clear()

  mockListAgentNames.mockReset().mockReturnValue([])
  mockAgentRunState.mockImplementation((name: string) => runStateByAgent.get(name) ?? 'running')
  mockAgentSessionName.mockImplementation((name: string) => `session-${name}`)
  mockRestartAgentProcess.mockReset()
  mockCapturePane.mockImplementation((session: string) => (paneBySession.has(session) ? paneBySession.get(session)! : `PANE:${session}`))
  mockSendPromptToSession.mockReset().mockResolvedValue(undefined)
  mockIsSessionReadyForPrompt.mockImplementation(async (session: string) => sessionReadyBySession.get(session) ?? false)
  mockReadAgentRemoteHost.mockImplementation((name: string) => remoteHostByAgent.get(name) ?? null)
  mockDetectPaneState.mockImplementation((pane: string) => paneStateByPane.get(pane) ?? 'unknown')
  mockPaneShowsContextSaturation.mockImplementation((pane: string) => paneSaturatedByPane.get(pane) ?? false)
  mockReadContextTokensFromProjectDir.mockImplementation((dir: string) => contextTokensByDir.get(dir) ?? null)
  mockReadTranscriptMtimeFromProjectDir.mockImplementation((dir: string) => transcriptMtimeByDir.get(dir) ?? null)
  mockReadContextGuardConfig.mockImplementation((name: string) => cfgByAgent.get(name) ?? DEFAULT_CFG)
  mockCreateAgentMessage.mockReset()
  mockGetWorkspaceDocUpdatedAtMs.mockImplementation((name: string) => handoffMtimeByAgent.get(name) ?? null)
  mockAppendActivePlanMarkerToHandoff.mockReset()
  mockHardRestartMarveenChannels.mockReset().mockReturnValue({ ok: true })
  mockLastMainRespawnAt.mockReset().mockReturnValue(null)
  mockShouldDeferForRecentRespawn.mockReset().mockReturnValue(false)
  mockWriteFileSync.mockReset()
  mockLoggerInfo.mockReset()
  mockLoggerWarn.mockReset()
  mockLoggerDebug.mockReset()

  // Main is armed running+idle by default; tests that need otherwise override it.
  armSession(mainSession())
})

afterEach(() => {
  if (handle) clearInterval(handle)
  handle = undefined
  vi.useRealTimers()
})

describe('startContextGuardRunner: sweep scheduling', () => {
  it('does not check any agent before the initial delay elapses', async () => {
    setCfg(MAIN_AGENT_ID, { saturationRestart: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1)
    expect(mockCapturePane).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(getHardGuardPhase(MAIN_AGENT_ID)).toBe('idle')
  })

  it('runs the first sweep once the initial delay elapses, checking the main agent', async () => {
    setCfg(MAIN_AGENT_ID, { saturationRestart: true })
    armSession(mainSession(), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockCapturePane).toHaveBeenCalledWith(mainSession())
    // Saturation is a 2-sweep confirm; one sweep alone must not have restarted yet.
    expect(getHardGuardPhase(MAIN_AGENT_ID)).toBe('idle')
    expect(mockHardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('also checks every agent returned by listAgentNames() on the same sweep', async () => {
    mockListAgentNames.mockReturnValue(['agent-a', 'agent-b'])
    setCfg('agent-a', { saturationRestart: true })
    setCfg('agent-b', { saturationRestart: true })
    armSession(subSession('agent-a'), { saturated: true })
    armSession(subSession('agent-b'), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep() // second sweep confirms the saturation streak
    expect(getHardGuardPhase('agent-a')).toBe('await-ready')
    expect(getHardGuardPhase('agent-b')).toBe('await-ready')
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('agent-a', { fresh: true })
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('agent-b', { fresh: true })
  })

  it('runs subsequent sweeps on the interval cadence', async () => {
    mockListAgentNames.mockReturnValue(['agent-c'])
    setCfg('agent-c', { saturationRestart: true })
    armSession(subSession('agent-c'), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(getHardGuardPhase('agent-c')).toBe('idle') // sweep 1: streak 1, not yet confirmed
    await runNextSweep()
    expect(getHardGuardPhase('agent-c')).toBe('await-ready') // sweep 2: confirmed, restarted
  })

  it('an error thrown while gathering inputs for one agent does not stop the sweep from checking the others', async () => {
    mockListAgentNames.mockReturnValue(['agent-broken', 'agent-fine'])
    setCfg('agent-broken', { saturationRestart: true })
    setCfg('agent-fine', { saturationRestart: true })
    armSession(subSession('agent-fine'), { saturated: true })
    // Throw from the FIRST probe checkAgent calls for a sub-agent, well before
    // its own internal try/catch (which only wraps the action switch) -- this
    // is the only way to exercise the sweep loop's OWN per-agent try/catch.
    mockAgentRunState.mockImplementation((name: string) => {
      if (name === 'agent-broken') throw new Error('boom')
      return runStateByAgent.get(name) ?? 'running'
    })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(getHardGuardPhase('agent-fine')).toBe('await-ready')
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'agent-broken' }),
      'context-guard: agent check error',
    )
  })

  it('an error thrown while checking the main agent does not stop the interval from firing again', async () => {
    mockListAgentNames.mockReturnValue(['agent-d'])
    setCfg(MAIN_AGENT_ID, { saturationRestart: true })
    setCfg('agent-d', { saturationRestart: true })
    armSession(subSession('agent-d'), { saturated: true })
    mockCapturePane.mockImplementationOnce(() => { throw new Error('main pane capture exploded') })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep() // main's first probe throws; agent-d must still be checked
    expect(mockLoggerDebug).toHaveBeenCalledWith(expect.anything(), 'context-guard: main check error')
    expect(getHardGuardPhase('agent-d')).toBe('idle') // streak 1, not yet confirmed

    // A second sweep still fires despite the earlier throw (setInterval untouched).
    armSession(mainSession()) // clear the saturated state so main behaves normally now
    await runNextSweep()
    expect(getHardGuardPhase('agent-d')).toBe('await-ready')
  })
})

describe('checkAgent: gating', () => {
  it('fully-disabled config (all three toggles off) tears down any existing guard state', async () => {
    mockListAgentNames.mockReturnValue(['agent-e'])
    setCfg('agent-e', { saturationRestart: true })
    armSession(subSession('agent-e'), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(getHardGuardPhase('agent-e')).toBe('await-ready') // confirmed non-idle state exists

    setCfg('agent-e', { enabled: false, saturationRestart: false, idleFlushEnabled: false })
    await runNextSweep()
    expect(getHardGuardPhase('agent-e')).toBe('idle') // state deleted, default reported
  })

  it('skips a remote-host sub-agent entirely (no restart, no prompt)', async () => {
    mockListAgentNames.mockReturnValue(['agent-remote'])
    setCfg('agent-remote', { saturationRestart: true })
    remoteHostByAgent.set('agent-remote', '10.0.0.5')
    armSession(subSession('agent-remote'), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(mockRestartAgentProcess).not.toHaveBeenCalledWith('agent-remote', expect.anything())
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(getHardGuardPhase('agent-remote')).toBe('idle')
  })

  it('logs the remote-host skip only once across repeated sweeps', async () => {
    mockListAgentNames.mockReturnValue(['agent-remote-2'])
    setCfg('agent-remote-2', { saturationRestart: true })
    remoteHostByAgent.set('agent-remote-2', '10.0.0.6')
    const { startContextGuardRunner } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    await runNextSweep()
    const skipCalls = mockLoggerInfo.mock.calls.filter(
      (c: unknown[]) => c[1] === 'context-guard: remote-host agent, skipping (transcripts not local)',
    )
    expect(skipCalls).toHaveLength(1)
  })
})

describe('checkAgent: saturation net restart (sub-agent)', () => {
  it('requires two consecutive saturated sweeps before restarting', async () => {
    mockListAgentNames.mockReturnValue(['agent-f'])
    setCfg('agent-f', { saturationRestart: true })
    armSession(subSession('agent-f'), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(getHardGuardPhase('agent-f')).toBe('idle')
    await runNextSweep()
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('agent-f', { fresh: true })
    expect(getHardGuardPhase('agent-f')).toBe('await-ready')
  })

  it('snapshots the pane to STORE_DIR before restarting', async () => {
    mockListAgentNames.mockReturnValue(['agent-g'])
    setCfg('agent-g', { saturationRestart: true })
    armSession(subSession('agent-g'), { saturated: true })
    const { startContextGuardRunner } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('context-guard-last-pane-agent-g.txt'),
      `PANE:${subSession('agent-g')}`,
    )
  })

  it('posts a restart notice via createAgentMessage naming the agent and reason', async () => {
    mockListAgentNames.mockReturnValue(['agent-h'])
    setCfg('agent-h', { saturationRestart: true })
    armSession(subSession('agent-h'), { saturated: true })
    const { startContextGuardRunner } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(mockCreateAgentMessage).toHaveBeenCalledWith(
      'agent-h',
      MAIN_AGENT_ID,
      expect.stringContaining('agent-h'),
      'context-guard restart notice',
    )
  })

  it('a createAgentMessage failure is caught and logged without blocking the restart', async () => {
    mockListAgentNames.mockReturnValue(['agent-i'])
    setCfg('agent-i', { saturationRestart: true })
    armSession(subSession('agent-i'), { saturated: true })
    mockCreateAgentMessage.mockImplementationOnce(() => { throw new Error('db down') })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('agent-i', { fresh: true })
    expect(getHardGuardPhase('agent-i')).toBe('await-ready')
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-i' }),
      'context-guard: restart notice message failed',
    )
  })
})

describe('checkAgent: main-agent restart path', () => {
  it('restarts main via hardRestartMarveenChannels, never restartAgentProcess', async () => {
    setCfg(MAIN_AGENT_ID, { saturationRestart: true })
    armSession(mainSession(), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(getHardGuardPhase(MAIN_AGENT_ID)).toBe('await-ready')
  })

  it('a failed hard restart (ok:false) is caught, logged, and never reaches the restart-notice message', async () => {
    setCfg(MAIN_AGENT_ID, { saturationRestart: true })
    armSession(mainSession(), { saturated: true })
    mockHardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'launchctl missing' })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep()
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ name: MAIN_AGENT_ID, action: 'restart' }),
      'context-guard: action failed',
    )
    // Guard state still advanced to await-ready even though the I/O failed --
    // decideGuard's nextState is committed before the action is attempted.
    expect(getHardGuardPhase(MAIN_AGENT_ID)).toBe('await-ready')
  })

  it('defers the restart within the post-respawn grace window, leaving the previous state intact', async () => {
    setCfg(MAIN_AGENT_ID, { saturationRestart: true })
    armSession(mainSession(), { saturated: true })
    mockShouldDeferForRecentRespawn.mockReturnValue(true)
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep() // would confirm+restart, but grace defers it
    expect(mockHardRestartMarveenChannels).not.toHaveBeenCalled()
    // Deferring keeps the PREVIOUS state (idle, streak carried forward from
    // sweep 1), not decideGuard's computed await-ready -- the next sweep must
    // re-decide rather than believe a restart already happened.
    expect(getHardGuardPhase(MAIN_AGENT_ID)).toBe('idle')

    // Once the grace window passes, the deferred restart proceeds.
    mockShouldDeferForRecentRespawn.mockReturnValue(false)
    await runNextSweep()
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
    expect(getHardGuardPhase(MAIN_AGENT_ID)).toBe('await-ready')
  })
})

describe('checkAgent: request-handoff prompt selection', () => {
  it('act threshold sends the critical handoffPrompt', async () => {
    mockListAgentNames.mockReturnValue(['agent-act'])
    setCfg('agent-act', { enabled: true, actPct: 0.5, hardPct: 0.97, limitTokens: 100_000 })
    armSession(subSession('agent-act'))
    contextTokensByDir.set(subDir('agent-act'), 60_000) // pct = 0.6, >= actPct, < hardPct
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [, prompt] = mockSendPromptToSession.mock.calls[0]
    expect(prompt).toContain('kritikus')
    expect(prompt).toContain('~60%')
    expect(getHardGuardPhase('agent-act')).toBe('await-handoff')
  })

  it('idle-flush tier sends the routine idleFlushHandoffPrompt', async () => {
    mockListAgentNames.mockReturnValue(['agent-idle'])
    setCfg('agent-idle', { idleFlushEnabled: true, idleFlushTokens: 400_000, idleMinutes: 20 })
    armSession(subSession('agent-idle'))
    contextTokensByDir.set(subDir('agent-idle'), 450_000)
    transcriptMtimeByDir.set(subDir('agent-idle'), 0) // idleMs = nowMs - 0, comfortably >= 20m
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [, prompt] = mockSendPromptToSession.mock.calls[0]
    expect(prompt).toContain('Rutin karbantart')
    expect(prompt).toContain('nem vészhelyzet')
    expect(getHardGuardPhase('agent-idle')).toBe('await-handoff')
  })

  it('daily-handoff tier sends the scheduled dailyHandoffPrompt', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 50, 0))
    mockListAgentNames.mockReturnValue(['agent-daily'])
    setCfg('agent-daily', { saturationRestart: true, dailyHandoffEnabled: true, dailyHandoffTime: '00:00' })
    armSession(subSession('agent-daily'), { paneState: 'idle' })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [, prompt] = mockSendPromptToSession.mock.calls[0]
    expect(prompt).toContain('Napi rutin')
    expect(prompt).toContain('00:00')
    expect(getHardGuardPhase('agent-daily')).toBe('await-handoff')
  })

  it('daily-handoff tier alone (no saturation net, no other tier) still runs the sweep and fires (regression: checkAgent\'s top gate must count dailyHandoffEnabled)', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 50, 0))
    mockListAgentNames.mockReturnValue(['agent-daily-only'])
    setCfg('agent-daily-only', { dailyHandoffEnabled: true, dailyHandoffTime: '00:00' })
    armSession(subSession('agent-daily-only'), { paneState: 'idle' })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [, prompt] = mockSendPromptToSession.mock.calls[0]
    expect(prompt).toContain('Napi rutin')
    expect(getHardGuardPhase('agent-daily-only')).toBe('await-handoff')
  })

  it('daily-handoff tier defers instead of firing while the pane is not idle', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 50, 0))
    mockListAgentNames.mockReturnValue(['agent-daily-busy'])
    setCfg('agent-daily-busy', { saturationRestart: true, dailyHandoffEnabled: true, dailyHandoffTime: '00:00' })
    armSession(subSession('agent-daily-busy'), { paneState: 'busy' })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(getHardGuardPhase('agent-daily-busy')).toBe('idle')
  })

  it('a handoff that went stale while awaiting an idle pane gets a refresh request, not a first write', async () => {
    mockListAgentNames.mockReturnValue(['agent-stale'])
    setCfg('agent-stale', { enabled: true, actPct: 0.5, hardPct: 0.97, limitTokens: 100_000, handoffTimeoutMinutes: 20 })
    armSession(subSession('agent-stale'))
    contextTokensByDir.set(subDir('agent-stale'), 60_000)

    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep() // sweep 1: act threshold -> request-handoff, await-handoff
    expect(getHardGuardPhase('agent-stale')).toBe('await-handoff')
    mockSendPromptToSession.mockClear()

    // Sweep 2 (+5m): the agent wrote a handoff, but kept working for 10 more
    // minutes afterwards, so the artifact is already stale by the time the
    // pane goes idle. idleMs must reflect "quiet since just now" so
    // handoffStaleMinutes sees a real gap.
    const now2 = peekNextSweepMs()
    handoffMtimeByAgent.set('agent-stale', now2 - 10 * 60_000)
    transcriptMtimeByDir.set(subDir('agent-stale'), now2) // last activity = now (idleMs = 0)
    await runNextSweep()

    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [, prompt] = mockSendPromptToSession.mock.calls[0]
    expect(prompt).toContain('frissítsd')
    expect(prompt).not.toContain('írj HANDOFF')
    expect(getHardGuardPhase('agent-stale')).toBe('await-handoff') // still waiting, not restarted yet
  })
})

describe('checkAgent: inject-resume after restart', () => {
  it('injects the resume prompt once the restarted session reports ready, then cools down', async () => {
    mockListAgentNames.mockReturnValue(['agent-resume'])
    setCfg('agent-resume', { saturationRestart: true })
    armSession(subSession('agent-resume'), { saturated: true })
    const { startContextGuardRunner, getHardGuardPhase } = await loadRunner()
    handle = startContextGuardRunner()
    await runNextSweep()
    await runNextSweep() // confirms + restarts -> await-ready
    expect(getHardGuardPhase('agent-resume')).toBe('await-ready')
    mockSendPromptToSession.mockClear()

    sessionReadyBySession.set(subSession('agent-resume'), true)
    await runNextSweep()

    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [, prompt] = mockSendPromptToSession.mock.calls[0]
    expect(prompt).toContain('FOLYTASD')
    expect(prompt).toContain('assignee=agent-resume')
    expect(getHardGuardPhase('agent-resume')).toBe('cooldown')
  })
})

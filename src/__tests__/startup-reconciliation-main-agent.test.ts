import { describe, it, expect, vi, beforeEach } from 'vitest'

// Startup reconciliation must never launch, restart or record the main agent ('boss' here): its lifecycle is
// service-managed. The desired set is mocked to hold it, the second layer after the filter in agent-desired-state.

const mockSessionExistsOnHost = vi.fn<(host: string | null, session: string) => boolean>()
const mockStartAgentProcess = vi.fn<(name: string) => { ok: boolean; error?: string }>()
const mockRestartAgentProcess = vi.fn<(name: string) => { ok: boolean; error?: string }>()
const mockCapturePane = vi.fn<(session: string) => string | null>()
const mockGetDesiredAgents = vi.fn<() => Set<string>>()
const mockAddDesiredAgent = vi.fn<(name: string) => void>()
const mockReadAllAutoRestartConfigs = vi.fn<() => Record<string, { enabled: boolean }>>()
const mockListAgentNames = vi.fn<() => string[]>()

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  sessionExistsOnHost: (...args: [string | null, string]) => mockSessionExistsOnHost(...args),
  startAgentProcess: (name: string) => mockStartAgentProcess(name),
  restartAgentProcess: (name: string) => mockRestartAgentProcess(name),
  capturePane: (session: string) => mockCapturePane(session),
}))
vi.mock('../web/agent-desired-state.js', () => ({
  getDesiredAgents: () => mockGetDesiredAgents(),
  addDesiredAgent: (name: string) => mockAddDesiredAgent(name),
}))
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: (name: string) => name === 'boss',
}))
vi.mock('../web/auto-restart-store.js', () => ({
  readAllAutoRestartConfigs: () => mockReadAllAutoRestartConfigs(),
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockListAgentNames(),
}))
vi.mock('../pane-state.js', () => ({
  detectPaneState: () => 'idle',
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { reconcileAgentsOnStartup, flushRunningStateToDesired } from '../web/startup-reconciliation.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetDesiredAgents.mockReturnValue(new Set())
  mockReadAllAutoRestartConfigs.mockReturnValue({})
  mockListAgentNames.mockReturnValue([])
  mockSessionExistsOnHost.mockReturnValue(false)
  mockCapturePane.mockReturnValue(null)
  mockStartAgentProcess.mockReturnValue({ ok: true })
  mockRestartAgentProcess.mockReturnValue({ ok: true })
})

// Every assertion on the main agent is paired with a positive control: two sub-agents ('worker-a', 'worker-b') must
// really be launched, restarted or recorded. 'worker-b' is handled only after the first awaited call of the loop, so
// a test that forgets the `await` on the function under test sees a half-finished run and fails on the positive
// control (a bare `not.toHaveBeenCalledWith('boss')` is green on a run that has not got that far).
const calledWith = (fn: { mock: { calls: unknown[][] } }): unknown[] => fn.mock.calls.map((call) => call[0])

describe('reconcileAgentsOnStartup: the main agent', () => {
  it('does not launch the main agent when it is in the desired set and has no agent-<id> session', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-a', 'worker-b']))
    await reconcileAgentsOnStartup()
    expect(calledWith(mockStartAgentProcess)).toEqual(['worker-a', 'worker-b'])
  })

  it('does not launch the main agent when its autoRestart is enabled', async () => {
    mockReadAllAutoRestartConfigs.mockReturnValue({
      boss: { enabled: true },
      'worker-a': { enabled: true },
      'worker-b': { enabled: true },
    })
    await reconcileAgentsOnStartup()
    expect(calledWith(mockStartAgentProcess)).toEqual(['worker-a', 'worker-b'])
  })

  it('does not restart the main agent when a stale agent-<id> session exists', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-a', 'worker-b']))
    mockSessionExistsOnHost.mockReturnValue(true)
    mockCapturePane.mockReturnValue('')
    await reconcileAgentsOnStartup()
    expect(calledWith(mockRestartAgentProcess)).toEqual(['worker-a', 'worker-b'])
    expect(mockStartAgentProcess).not.toHaveBeenCalled()
    expect(mockAddDesiredAgent).not.toHaveBeenCalled()
  })

  it('does not record the main agent when a live agent-<id> session exists', async () => {
    // autoRestart makes all three candidates without putting them into the desired set, so each live session that
    // is reconnected gets recorded there (for the main agent that would be the bug)
    mockReadAllAutoRestartConfigs.mockReturnValue({
      boss: { enabled: true },
      'worker-a': { enabled: true },
      'worker-b': { enabled: true },
    })
    mockSessionExistsOnHost.mockReturnValue(true)
    mockCapturePane.mockReturnValue('live pane')
    await reconcileAgentsOnStartup()
    expect(calledWith(mockAddDesiredAgent)).toEqual(['worker-a', 'worker-b'])
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockStartAgentProcess).not.toHaveBeenCalled()
  })

  it('still launches a desired sub-agent whose session is gone', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-a', 'worker-b']))
    await reconcileAgentsOnStartup()
    expect(mockStartAgentProcess).toHaveBeenCalledTimes(2)
    expect(mockStartAgentProcess).toHaveBeenCalledWith('worker-a')
    expect(mockStartAgentProcess).toHaveBeenCalledWith('worker-b')
  })
})

describe('flushRunningStateToDesired: the main agent', () => {
  it('does not add the main agent even though an agent-<id> session exists', async () => {
    mockListAgentNames.mockReturnValue(['boss', 'worker-a', 'worker-b'])
    mockSessionExistsOnHost.mockReturnValue(true)
    await flushRunningStateToDesired()
    expect(calledWith(mockAddDesiredAgent)).toEqual(['worker-a', 'worker-b'])
  })
})

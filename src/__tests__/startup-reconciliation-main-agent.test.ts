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

describe('reconcileAgentsOnStartup: the main agent', () => {
  it('does not launch the main agent when it is in the desired set and has no agent-<id> session', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-a']))
    await reconcileAgentsOnStartup()
    expect(mockStartAgentProcess).not.toHaveBeenCalledWith('boss')
  })

  it('does not launch the main agent when its autoRestart is enabled', async () => {
    mockReadAllAutoRestartConfigs.mockReturnValue({ boss: { enabled: true }, 'worker-a': { enabled: true } })
    await reconcileAgentsOnStartup()
    expect(mockStartAgentProcess).not.toHaveBeenCalledWith('boss')
  })

  it('does not restart or record the main agent when a stale or live agent-<id> session exists', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss']))
    mockSessionExistsOnHost.mockReturnValue(true)
    mockCapturePane.mockReturnValue('')
    await reconcileAgentsOnStartup()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockAddDesiredAgent).not.toHaveBeenCalled()
  })

  it('still launches a desired sub-agent whose session is gone', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-a']))
    await reconcileAgentsOnStartup()
    expect(mockStartAgentProcess).toHaveBeenCalledTimes(1)
    expect(mockStartAgentProcess).toHaveBeenCalledWith('worker-a')
  })
})

describe('flushRunningStateToDesired: the main agent', () => {
  it('does not add the main agent even though an agent-<id> session exists', () => {
    mockListAgentNames.mockReturnValue(['boss', 'worker-a'])
    mockSessionExistsOnHost.mockReturnValue(true)
    flushRunningStateToDesired()
    expect(mockAddDesiredAgent).not.toHaveBeenCalledWith('boss')
    expect(mockAddDesiredAgent).toHaveBeenCalledWith('worker-a')
  })
})

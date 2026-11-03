import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// reconcileDesiredAgents() (the periodic desired-state reconcile of the channel monitor) must never start the
// main agent: its lifecycle is service-managed, a start here would open a second, unused `agent-<id>` session.
// Everything the function talks to is mocked; the main agent id is the literal 'boss'.

const mockGetDesiredAgents = vi.fn<() => Set<string>>()
const mockIsAgentRunning = vi.fn<(name: string) => boolean>()
const mockStartAgentProcess = vi.fn<(name: string) => { ok: boolean; error?: string }>()

vi.mock('../web/agent-desired-state.js', () => ({
  getDesiredAgents: () => mockGetDesiredAgents(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'boss-channels',
  MAIN_CHANNELS_PLIST: '/nonexistent/boss.plist',
  isMainChannelsAgent: (name: string) => name === 'boss',
}))

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    isAgentRunning: (name: string) => mockIsAgentRunning(name),
    startAgentProcess: (name: string) => mockStartAgentProcess(name),
  }
})

import { reconcileDesiredAgents } from '../web/channel-monitor.js'

beforeEach(() => {
  // The start is gated by scripts/fleet-memory-gate.sh, which reads the host's free memory; its kill-switch makes the
  // test independent of the machine it runs on.
  vi.stubEnv('MARVEEN_MEM_GATE_DISABLE', '1')
  vi.useFakeTimers()
  vi.clearAllMocks()
  mockIsAgentRunning.mockReturnValue(false)
  mockStartAgentProcess.mockReturnValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function reconcile(): Promise<void> {
  const done = reconcileDesiredAgents()
  await vi.runAllTimersAsync()
  await done
}

describe('reconcileDesiredAgents: the main agent', () => {
  it('does not start the main agent when it is in the desired set and not running', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-a']))
    await reconcile()
    expect(mockStartAgentProcess).not.toHaveBeenCalledWith('boss')
  })

  // A started agent is remembered by the module (restart grace), so every test uses its own sub-agent name.
  it('still starts a desired sub-agent that is not running', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss', 'worker-b']))
    await reconcile()
    expect(mockStartAgentProcess).toHaveBeenCalledWith('worker-b')
    expect(mockStartAgentProcess).toHaveBeenCalledTimes(1)
  })

  it('starts nothing when the main agent is the only desired entry', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['boss']))
    await reconcile()
    expect(mockStartAgentProcess).not.toHaveBeenCalled()
  })
})

// The router side of the sender routing wiring: runMessageRouterTick passes the messages it is about to
// deliver through gateDeliveryBatch before anything else looks at them (so a refused message never reaches the
// session lookup or the tmux injection), and so does the reconnect-backlog read. The gate itself, with a real
// database, is covered in sender-routing-wire-in.test.ts; here it is a spy, so what is pinned is the call site.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockGetPendingForAgent = vi.fn()
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => false)
const mockGate = vi.fn((batch: readonly { to_agent: string }[]) => Promise.resolve(batch.filter((m) => m.to_agent !== 'refused-agent')))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))
vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? Promise.resolve(mockGetPendingForAgent(toAgent)) : Promise.resolve(mockGetPendingMessages())),
  markMessageDelivered: () => Promise.resolve(true),
  markMessageFailed: () => Promise.resolve(true),
  markMessageDone: () => Promise.resolve(true),
  markMessageNoSession: () => Promise.resolve(true),
  createAgentMessage: () => Promise.resolve({ id: 999 }),
  stampMessageTrace: () => Promise.resolve(false),
  upsertOtelSpan: () => undefined,
  closeOtelSpan: () => false,
}))
vi.mock('../web/sender-routing-wire.js', () => ({
  gateDeliveryBatch: (batch: readonly { to_agent: string }[]) => mockGate(batch),
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))
vi.mock('../web/agent-config.js', () => ({ readAgentRemoteHost: () => null, readAgentVoiceConfig: () => ({ responseMode: 'text' }) }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => false),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const msg = (id: number, to: string, ageSec = 0) => ({ id, from_agent: 'orin', to_agent: to, content: 'ping', created_at: nowSec() - ageSec })

describe('the router passes what it delivers through the sender routing gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(false)
    mockGetPendingForAgent.mockReturnValue([])
  })

  it('a refused message never reaches the session lookup: only the kept receivers are looked at', async () => {
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex'), msg(2, 'refused-agent')])
    await runMessageRouterTick()
    expect(mockGate).toHaveBeenCalledTimes(1)
    expect(mockGate.mock.calls[0][0].map((m) => m.to_agent)).toEqual(['dex', 'refused-agent'])
    const looked = mockSessionExistsOnHost.mock.calls.map((c) => c[1])
    expect(looked).toEqual(['agent-dex'])
  })

  it('the reconnect-backlog read goes through the gate too', async () => {
    const old = 3 * 24 * 3600
    const backlog = Array.from({ length: 60 }, (_, i) => msg(100 + i, 'dex', old))
    mockGetPendingForAgent.mockImplementation((agent: string) => (agent === 'dex' ? backlog : []))
    // tick 1: dex is absent; tick 2: dex is back, with an old backlog above the batching threshold
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex')])
    mockSessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockGate.mockClear()
    await runMessageRouterTick()
    const gated = mockGate.mock.calls.map((c) => c[0].length)
    expect(gated).toContain(60)
  })
})

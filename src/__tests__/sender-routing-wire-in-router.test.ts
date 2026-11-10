// The router side of the sender routing wiring: runMessageRouterTick opens the delivery gate ONCE and passes the
// messages it is about to deliver through it before anything else looks at them (so a refused message never reaches
// the session lookup or the tmux injection), and so does the reconnect-backlog read. The framing of each delivered
// message gets the tenant predicate of that same gate. The gate itself, with a real database, is covered in
// sender-routing-wire-in.test.ts and sender-routing-tenant-trust.test.ts, and the real router + real gate + real
// framing in tenant-trust-framing-parity.test.ts; here the gate is a spy, so what is pinned is the call site.

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
// The delivery gate: one openDeliveryGate() per tick. `judge` is the spy that drops `refused-agent`; `tenantPeer` is a
// distinct function so a test can tell that the framing was handed THIS gate's predicate, not another one.
const gateTenantPeer = (a: string, b: string) => a === 'tenant-main' && b === 'tenant-agent'
const mockOpenGate = vi.fn((): Promise<unknown> => Promise.resolve({ open: true, judge: (batch: readonly { to_agent: string }[]) => mockGate(batch), tenantPeer: gateTenantPeer }))
const mockClassify = vi.fn((..._a: unknown[]) => ({ category: 'trusted-peer', safeFrom: 'orin' }))
vi.mock('../web/sender-routing-wire.js', () => ({
  openDeliveryGate: () => mockOpenGate(),
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
  classifyAgentMessage: (...a: unknown[]) => mockClassify(...a),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'
import { isSessionReadyForPrompt } from '../web/agent-process.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const msg = (id: number, to: string, ageSec = 0) => ({ id, from_agent: 'orin', to_agent: to, content: 'ping', created_at: nowSec() - ageSec })

describe('the router passes what it delivers through the sender routing gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(false)
    mockGetPendingForAgent.mockReturnValue([])
    vi.mocked(isSessionReadyForPrompt).mockResolvedValue(false)
  })

  it('a refused message never reaches the session lookup: only the kept receivers are looked at', async () => {
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex'), msg(2, 'refused-agent')])
    await runMessageRouterTick()
    expect(mockGate).toHaveBeenCalledTimes(1)
    expect(mockGate.mock.calls[0][0].map((m) => m.to_agent)).toEqual(['dex', 'refused-agent'])
    const looked = mockSessionExistsOnHost.mock.calls.map((c) => c[1])
    expect(looked).toEqual(['agent-dex'])
  })

  it('the gate is opened once per tick, and not at all when there is nothing to judge', async () => {
    mockGetPendingMessages.mockReturnValue([])
    await runMessageRouterTick()
    expect(mockOpenGate).not.toHaveBeenCalled()
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex'), msg(2, 'dex'), msg(3, 'other-agent')])
    await runMessageRouterTick()
    expect(mockOpenGate).toHaveBeenCalledTimes(1)
  })

  it('a tick that also reads a reconnect backlog still opens the gate once (one snapshot for the verdicts and the framing)', async () => {
    const old = 3 * 24 * 3600
    const backlog = Array.from({ length: 60 }, (_, i) => msg(100 + i, 'dex', old))
    mockGetPendingForAgent.mockImplementation((agent: string) => (agent === 'dex' ? backlog : []))
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex')])
    mockSessionExistsOnHost.mockReturnValue(false)
    await runMessageRouterTick()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockOpenGate.mockClear()
    mockGate.mockClear()
    await runMessageRouterTick()
    expect(mockGate.mock.calls.map((c) => c[0].length)).toContain(60)
    expect(mockOpenGate).toHaveBeenCalledTimes(1)
  })

  it('a closed gate (enforce mode, tables unreadable) judges and delivers nothing and looks at no session', async () => {
    mockOpenGate.mockResolvedValueOnce({ open: false })
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex'), msg(2, 'other-agent')])
    await runMessageRouterTick()
    expect(mockGate).not.toHaveBeenCalled()
    expect(mockSessionExistsOnHost).not.toHaveBeenCalled()
    expect(mockClassify).not.toHaveBeenCalled()
  })

  it('the framing gets the tenant predicate of the gate that judged the batch', async () => {
    mockSessionExistsOnHost.mockReturnValue(true)
    vi.mocked(isSessionReadyForPrompt).mockResolvedValue(true)
    mockGetPendingMessages.mockReturnValue([msg(1, 'dex')])
    await runMessageRouterTick()
    expect(mockClassify).toHaveBeenCalled()
    for (const call of mockClassify.mock.calls) expect(call[2]).toBe(gateTenantPeer)
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

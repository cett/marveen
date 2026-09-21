// stampTraceOnMessage must fill otel_spans.attributes
// with { msg_id, from, to } (the InterAgentSpanAttributes shape) instead of
// leaving every inter-agent span's attributes null, so the Grafana/Tempo
// export (spansToOtelJson -> parseAttributes) can tell spans apart by the
// message that produced them.
//
// Full successful-delivery scaffold (sessionExists + ready + inject succeeds),
// unlike message-router-tick-cap.test.ts which only exercises the
// session-absent/busy retry branches.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockUpsertOtelSpan = vi.fn()
const mockStampMessageTrace = vi.fn((..._a: unknown[]) => true)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query for reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (..._a: unknown[]) => true,
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markMessageNoSession: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (...a: unknown[]) => mockStampMessageTrace(...a),
  upsertOtelSpan: (...a: unknown[]) => mockUpsertOtelSpan(...a),
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => true),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(async () => undefined),
  sessionExistsOnHost: vi.fn(() => true),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

vi.mock('../web/delivery-intent.js', () => ({
  recordDelivery: vi.fn(),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function makePending() {
  const nowSec = Math.floor(Date.now() / 1000)
  return [{
    id: 42,
    from_agent: 'orin',
    to_agent: 'dex',
    content: 'ping',
    created_at: nowSec,
    trace_id: null,
    span_id: null,
  }]
}

describe('message-router: inter-agent span attributes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStampMessageTrace.mockReturnValue(true)
  })

  it('fills upsertOtelSpan attributes with msg_id/from/to as JSON', async () => {
    mockGetPendingMessages.mockReturnValue(makePending())

    await runMessageRouterTick()

    expect(mockUpsertOtelSpan).toHaveBeenCalledTimes(1)
    const [span] = mockUpsertOtelSpan.mock.calls[0]
    expect(span.attributes).not.toBeNull()
    expect(JSON.parse(span.attributes)).toEqual({ msg_id: 42, from: 'orin', to: 'dex' })
  })

  it('does not call upsertOtelSpan when stampMessageTrace reports already-stamped', async () => {
    mockStampMessageTrace.mockReturnValue(false)
    mockGetPendingMessages.mockReturnValue(makePending())

    await runMessageRouterTick()

    expect(mockUpsertOtelSpan).not.toHaveBeenCalled()
  })
})

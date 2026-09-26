// Backend coverage batch-55: the three DB-write notification wrappers in
// message-router.ts (notifyOrchestratorOfStuckSession,
// notifyOrchestratorOfFailedHandoff, notifyDelegationFailed) were previously
// unexported and 0%-exercised per coverage-final.json for this file -- only
// the pure decision functions they sit next to (formatStuckSessionAlert,
// shouldEscalateStuckSession, shouldAbandon) had direct tests. Each wraps a
// createAgentMessage call in try/catch; this covers both the happy path and
// the catch-and-log-only failure path (a failed notification must never
// throw back into the caller's tick loop).
//
// Mock scaffold mirrors message-router-trace-attributes.test.ts (the other
// direct importer of message-router.ts) since importing the module pulls in
// its full dependency graph (agent-process.js, federation/bridge.js, etc).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreateAgentMessage = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerInfo = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: (...a: unknown[]) => mockLoggerInfo(...a), warn: (...a: unknown[]) => mockLoggerWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (..._a: unknown[]) => [],
  markMessageDelivered: (..._a: unknown[]) => true,
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markMessageNoSession: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
  stampMessageTrace: (..._a: unknown[]) => true,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
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
  capturePane: vi.fn(() => ''),
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

import {
  notifyOrchestratorOfStuckSession,
  notifyOrchestratorOfFailedHandoff,
  notifyDelegationFailed,
} from '../web/message-router.js'
import type { AgentMessage } from '../db/agents.js'

function makeMsg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 42,
    from_agent: 'atlas',
    to_agent: 'prisma',
    content: 'do the thing',
    status: 'pending',
    result: null,
    created_at: 0,
    delivered_at: null,
    completed_at: null,
    origin_note: null,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    tenant_id: null,
    refused_reason: null,
    no_session_at: null,
    ...overrides,
  } as AgentMessage
}

beforeEach(() => {
  mockCreateAgentMessage.mockReset()
  mockLoggerWarn.mockReset()
  mockLoggerInfo.mockReset()
})

describe('notifyOrchestratorOfStuckSession', () => {
  it('enqueues a system message and logs info when an alert is produced', () => {
    notifyOrchestratorOfStuckSession('prisma', 'agent-prisma', 15 * 60_000, 3, 'busy')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, content] = mockCreateAgentMessage.mock.calls[0] as [string, string, string]
    expect(from).toBe('system')
    expect(to).toBe('orin')
    expect(content).toContain('BUSY')
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the agent is the main agent itself (no self-alert)', () => {
    notifyOrchestratorOfStuckSession('orin', 'orin-channels', 15 * 60_000, 1, null)
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalled()
  })

  it('swallows a createAgentMessage failure and logs a warning instead of throwing', () => {
    mockCreateAgentMessage.mockImplementation(() => { throw new Error('db locked') })
    expect(() => notifyOrchestratorOfStuckSession('prisma', 'agent-prisma', 60_000, 1, null)).not.toThrow()
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
  })
})

describe('notifyOrchestratorOfFailedHandoff', () => {
  it('enqueues a handoff-failure notice with a truncated content preview', () => {
    const msg = makeMsg({ content: 'x'.repeat(300) })
    notifyOrchestratorOfFailedHandoff(msg, 'target session was absent for the entire retry window')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, content] = mockCreateAgentMessage.mock.calls[0] as [string, string, string]
    expect(from).toBe('system')
    expect(to).toBe('orin')
    expect(content).toContain('handoff-failure')
    expect(content).toContain('(id 42)')
    expect(content).toContain('atlas -> prisma')
    // preview is msg.content.slice(0, 220) -- the 300-char body must be cut down.
    expect(content).not.toContain('x'.repeat(221))
  })

  it('never loops a self-targeted failure notice back onto the main agent', () => {
    const msg = makeMsg({ to_agent: 'orin' })
    notifyOrchestratorOfFailedHandoff(msg, 'unreachable')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })

  it('swallows a createAgentMessage failure and logs a warning instead of throwing', () => {
    mockCreateAgentMessage.mockImplementation(() => { throw new Error('db locked') })
    const msg = makeMsg()
    expect(() => notifyOrchestratorOfFailedHandoff(msg, 'unreachable')).not.toThrow()
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
  })
})

describe('notifyDelegationFailed', () => {
  it('bounces a terminal federated-delivery failure back to the SENDER inbox, truncating the error', () => {
    const msg = makeMsg({ from_agent: 'atlas', to_agent: 'peer/agent' })
    notifyDelegationFailed(msg, 'x'.repeat(300))
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, content] = mockCreateAgentMessage.mock.calls[0] as [string, string, string]
    expect(from).toBe('system')
    expect(to).toBe('atlas')
    expect(content).toContain('#42')
    expect(content).toContain('peer/agent')
    expect(content).not.toContain('x'.repeat(201))
  })

  it('swallows a createAgentMessage failure and logs a warning instead of throwing', () => {
    mockCreateAgentMessage.mockImplementation(() => { throw new Error('db locked') })
    const msg = makeMsg()
    expect(() => notifyDelegationFailed(msg, 'unreachable')).not.toThrow()
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
  })
})

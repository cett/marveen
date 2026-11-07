import { describe, it, expect, vi, beforeEach } from 'vitest'

// sendPromptToSession reports 'sent' | 'aborted-busy' | 'skipped-locked'. The router used to ignore it and mark
// the message delivered whatever happened: a prompt the pane refused (it sits on the external CLAUDE.md imports
// dialog, which swallows the text) was lost with the row saying "delivered". A refused send now takes the same path
// as an inject throw: retried on the next tick, failed and reported after MAX_INJECT_FAILURES (3).

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => Promise.resolve(true))
const mockMarkFailed = vi.fn((..._a: unknown[]) => Promise.resolve(true))
const mockCreateAgentMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ id: 999 }))
const mockSendPrompt = vi.fn((..._a: unknown[]): unknown => 'sent')
const mockRecordDelivery = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-main',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))
vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? Promise.resolve([]) : Promise.resolve(mockGetPendingMessages())),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: () => Promise.resolve(true),
  markMessageNoSession: () => Promise.resolve(true),
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
  stampMessageTrace: () => Promise.resolve(true),
  upsertOtelSpan: () => Promise.resolve(),
  closeOtelSpan: () => false,
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/nonexistent-dir' }))
vi.mock('../web/agent-config.js', () => ({ readAgentRemoteHost: () => null, readAgentVoiceConfig: () => ({ responseMode: 'text' }) }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => true),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: vi.fn(() => true),
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'agent-main-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'agent-a' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))
vi.mock('../web/delivery-intent.js', () => ({ recordDelivery: (...a: unknown[]) => mockRecordDelivery(...a) }))

import { runMessageRouterTick } from '../web/message-router.js'
import { runAs } from '../db/context.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const row = (id: number) => ({ id, from_agent: 'agent-a', to_agent: 'agent-b', content: 'ping', created_at: nowSec(), trace_id: null, span_id: null })
const tick = () => runAs.system('message-router', () => runMessageRouterTick())

// A fresh id per test: the router keeps its failure counters per message id in module state, so a reused id
// would inherit the failures of the previous test.
let msgId = 800

beforeEach(() => {
  vi.clearAllMocks()
  mockSendPrompt.mockReset()
  mockSendPrompt.mockReturnValue('sent')
  msgId += 1
  mockGetPendingMessages.mockReturnValue([row(msgId)])
})

describe('message router: a refused send is not a delivered message', () => {
  it.each(['aborted-busy', 'skipped-locked'])('%s: not marked delivered, no ledger row, not failed on the first try', async (result) => {
    mockSendPrompt.mockReturnValue(result)
    await tick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockRecordDelivery).not.toHaveBeenCalled()
    // Retried next tick, not given up yet.
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('refused three ticks in a row: the message is failed and the orchestrator is told', async () => {
    mockSendPrompt.mockReturnValue('aborted-busy')
    for (let i = 0; i < 3; i++) await tick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(3)
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed.mock.calls[0][0]).toBe(msgId)
    expect(String(mockMarkFailed.mock.calls[0][1])).toMatch(/after 3 attempts/)
    expect(mockCreateAgentMessage).toHaveBeenCalled()
  })

  it('refused once, then sent: delivered on the retry, and the failure counter does not carry over', async () => {
    mockSendPrompt.mockReturnValueOnce('aborted-busy')
    await tick()
    expect(mockMarkDelivered).not.toHaveBeenCalled()

    await tick()
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
    expect(mockMarkDelivered.mock.calls[0][0]).toBe(msgId)
    expect(mockRecordDelivery).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()

    // The counter was cleared by the delivery: the same id refused again needs three NEW failures to give up.
    mockSendPrompt.mockReturnValue('aborted-busy')
    await tick()
    await tick()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('control: a sent prompt is delivered on the first tick', async () => {
    await tick()

    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
    expect(mockRecordDelivery).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('a sender that returns nothing (older or mocked) is delivered, exactly as before', async () => {
    mockSendPrompt.mockReturnValue(undefined)
    await tick()

    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })
})

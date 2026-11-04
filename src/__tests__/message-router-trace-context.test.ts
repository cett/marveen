// The router tick runs in its own system context with no trace. The writes it makes for ONE message (the failure
// record, the orchestrator notice) must run in the trace of THAT message: the trace its row carries (the only source
// after a restart, when the in-memory delivered-trace map is empty) or the one stamped on it this tick. A channel-inbound
// message has no trace and its writes carry none.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockStampMessageTrace = vi.fn((..._a: unknown[]) => Promise.resolve(true))
const failedTraces: Array<{ id: number; trace: unknown }> = []
const noticeTraces: unknown[] = []
let category: 'trusted-peer' | 'channel-inbound' = 'trusted-peer'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-main',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', async () => {
  const { currentTrace } = await import('../db/context.js')
  return {
    getPendingMessages: (toAgent?: string) => (toAgent ? Promise.resolve([]) : Promise.resolve(mockGetPendingMessages())),
    markMessageDelivered: (..._a: unknown[]) => Promise.resolve(true),
    markMessageFailed: (id: number) => { failedTraces.push({ id, trace: currentTrace() }); return Promise.resolve(true) },
    markMessageDone: (..._a: unknown[]) => Promise.resolve(true),
    markMessageNoSession: (..._a: unknown[]) => Promise.resolve(true),
    createAgentMessage: (..._a: unknown[]) => { noticeTraces.push(currentTrace()); return Promise.resolve({ id: 999 }) },
    stampMessageTrace: (...a: unknown[]) => mockStampMessageTrace(...a),
    upsertOtelSpan: (..._a: unknown[]) => Promise.resolve(),
    closeOtelSpan: (..._a: unknown[]) => false,
  }
})

vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/nonexistent-dir' }))
vi.mock('../web/agent-config.js', () => ({ readAgentRemoteHost: () => null, readAgentVoiceConfig: () => ({ responseMode: 'text' }) }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => true),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(() => Promise.reject(new Error('pane gone'))),
  sessionExistsOnHost: vi.fn(() => true),
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'agent-main-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category, safeFrom: 'agent-a' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))
vi.mock('../web/delivery-intent.js', () => ({ recordDelivery: vi.fn() }))

import { runMessageRouterTick, withMessageTrace } from '../web/message-router.js'
import { runAs, currentTrace } from '../db/context.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const row = (id: number, trace: { trace_id: string | null; span_id: string | null }) => ({
  id, from_agent: 'agent-a', to_agent: 'agent-b', content: 'ping', created_at: nowSec(), ...trace,
})
// The dashboard starts the router tick in its own system context (systemJob('message-router')); so does the test.
const tick = () => runAs.system('message-router', () => runMessageRouterTick())
// Three consecutive inject failures make the router give up on the message and write the failure records.
const giveUp = async () => { for (let i = 0; i < 3; i++) await tick() }

beforeEach(() => {
  vi.clearAllMocks()
  failedTraces.length = 0
  noticeTraces.length = 0
  category = 'trusted-peer'
  mockStampMessageTrace.mockResolvedValue(true)
})

describe('message router: the failure writes of a message run in its trace', () => {
  it('after a restart the trace comes from the row (the in-memory map is empty)', async () => {
    mockGetPendingMessages.mockReturnValue([row(701, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    await giveUp()
    expect(failedTraces).toEqual([{ id: 701, trace: { traceId: 'trace-from-row', spanId: 'span-from-row' } }])
    expect(noticeTraces).toEqual([{ traceId: 'trace-from-row', spanId: 'span-from-row' }])
    expect(mockStampMessageTrace).not.toHaveBeenCalled()
  })

  it('a message stamped in this very tick uses the stamped ids', async () => {
    mockGetPendingMessages.mockReturnValue([row(702, { trace_id: null, span_id: null })])
    await giveUp()
    // the mock queue never keeps the stamp, so every tick stamps again: the failure belongs to the last stamp
    const [, stampedTrace, stampedSpan] = mockStampMessageTrace.mock.calls.at(-1) as [number, string, string]
    expect(failedTraces).toEqual([{ id: 702, trace: { traceId: stampedTrace, spanId: stampedSpan } }])
    expect(noticeTraces).toEqual([{ traceId: stampedTrace, spanId: stampedSpan }])
  })

  it('two messages in one tick each write in their own trace', async () => {
    mockGetPendingMessages.mockReturnValue([
      row(703, { trace_id: 'trace-one', span_id: 'span-one' }),
      row(704, { trace_id: 'trace-two', span_id: 'span-two' }),
    ])
    await giveUp()
    expect(failedTraces).toEqual([
      { id: 703, trace: { traceId: 'trace-one', spanId: 'span-one' } },
      { id: 704, trace: { traceId: 'trace-two', spanId: 'span-two' } },
    ])
  })

  it('a channel-inbound message has no trace: its writes carry none', async () => {
    category = 'channel-inbound'
    mockGetPendingMessages.mockReturnValue([row(705, { trace_id: null, span_id: null })])
    await giveUp()
    expect(failedTraces).toEqual([{ id: 705, trace: undefined }])
    expect(mockStampMessageTrace).not.toHaveBeenCalled()
  })

  it('the tick itself carries no trace after a message (the trace is scoped to the writes)', async () => {
    mockGetPendingMessages.mockReturnValue([row(706, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    let after: unknown = 'unset'
    await runAs.system('message-router', async () => {
      await giveUp()
      after = currentTrace()
    })
    expect(after).toBeUndefined()
  })
})

describe('withMessageTrace', () => {
  it('runs in the trace of a stamped message and untouched for an unstamped or half-stamped one', () => {
    runAs.system('job-a', () => {
      expect(withMessageTrace({ trace_id: 't', span_id: 's' }, () => currentTrace())).toEqual({ traceId: 't', spanId: 's' })
      expect(withMessageTrace({ trace_id: null, span_id: null }, () => currentTrace())).toBeUndefined()
      expect(withMessageTrace({ trace_id: 't', span_id: null }, () => currentTrace())).toBeUndefined()
      expect(withMessageTrace({ trace_id: null, span_id: 's' }, () => currentTrace())).toBeUndefined()
    })
  })
})

// The router tick runs in its own system context with no trace. The writes it makes for ONE message (the failure
// record, the orchestrator notice) must run in the trace of THAT message: the trace its row carries (the only source
// after a restart, when the in-memory delivered-trace map is empty) or the one stamped on it this tick. A channel-inbound
// message has no trace and its writes carry none.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockStampMessageTrace = vi.fn((..._a: unknown[]) => Promise.resolve(true))
const failedTraces: Array<{ id: number; trace: unknown }> = []
const noticeTraces: unknown[] = []
const closedTraces: Array<{ traceId: string; trace: unknown }> = []
let category: 'trusted-peer' | 'channel-inbound' = 'trusted-peer'
let classifyThrows = false
let classifyNull = false
let markThrowsOnce = false

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
    markMessageFailed: (id: number) => {
      failedTraces.push({ id, trace: currentTrace() })
      if (markThrowsOnce) { markThrowsOnce = false; return Promise.reject(new Error('mark boom')) }
      return Promise.resolve(true)
    },
    markMessageDone: (..._a: unknown[]) => Promise.resolve(true),
    markMessageNoSession: (..._a: unknown[]) => Promise.resolve(true),
    createAgentMessage: (..._a: unknown[]) => { noticeTraces.push(currentTrace()); return Promise.resolve({ id: 999 }) },
    stampMessageTrace: (...a: unknown[]) => mockStampMessageTrace(...a),
    upsertOtelSpan: (..._a: unknown[]) => Promise.resolve(),
    closeOtelSpan: (traceId: string) => { closedTraces.push({ traceId, trace: currentTrace() }); return false },
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
  classifyAgentMessage: () => { if (classifyThrows) throw new Error('classify boom'); if (classifyNull) return null; return { category, safeFrom: 'agent-a' } },
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
  closedTraces.length = 0
  classifyThrows = false
  classifyNull = false
  markThrowsOnce = false
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

// The span of a failed message is closed by recordMessageFailure (closeOtelSpan, called with the ids of the ROW): the close
// has to run in the trace of that message too, on every path that fails it.
describe('message router: the span close of a failed message runs in its trace', () => {
  it('inject_failed: the span is closed in the trace of the row', async () => {
    mockGetPendingMessages.mockReturnValue([row(710, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    await giveUp()
    expect(closedTraces).toEqual([{ traceId: 'trace-from-row', trace: { traceId: 'trace-from-row', spanId: 'span-from-row' } }])
  })

  // The give-up path of an inject failure writes the failure records itself; when the first of them throws, the outer catch
  // writes them again, and those writes have to run in the trace of the message as well.
  it('the outer catch after a stamp: the failure mark runs in the trace stamped this tick', async () => {
    markThrowsOnce = true
    mockGetPendingMessages.mockReturnValue([row(711, { trace_id: null, span_id: null })])
    await giveUp()
    const [, stampedTrace, stampedSpan] = mockStampMessageTrace.mock.calls.at(-1) as [number, string, string]
    expect(failedTraces).toHaveLength(2) // the one that threw, then the outer catch's
    expect(failedTraces[1]).toEqual({ id: 711, trace: { traceId: stampedTrace, spanId: stampedSpan } })
  })

  it('the outer catch: the failure mark runs in the trace of the row', async () => {
    markThrowsOnce = true
    mockGetPendingMessages.mockReturnValue([row(715, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    await giveUp()
    expect(failedTraces).toHaveLength(2)
    expect(failedTraces[1]).toEqual({ id: 715, trace: { traceId: 'trace-from-row', spanId: 'span-from-row' } })
  })

  it('the outer catch: the span of the row is closed in the trace of the row', async () => {
    markThrowsOnce = true
    mockGetPendingMessages.mockReturnValue([row(712, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    await giveUp()
    // the inner path threw before its own close, so the only close is the outer catch's
    expect(closedTraces).toEqual([{ traceId: 'trace-from-row', trace: { traceId: 'trace-from-row', spanId: 'span-from-row' } }])
  })

  it('a throw BEFORE the stamp: the failure of a row that already carries a trace still runs in that trace', async () => {
    classifyThrows = true
    mockGetPendingMessages.mockReturnValue([row(713, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    await tick()
    const expected = { traceId: 'trace-from-row', spanId: 'span-from-row' }
    expect(failedTraces).toEqual([{ id: 713, trace: expected }])
    expect(closedTraces).toEqual([{ traceId: 'trace-from-row', trace: expected }])
    expect(mockStampMessageTrace).not.toHaveBeenCalled()
  })

  it('a sender that does not classify (invalid_sender): the failure mark and the span close run in the trace of the row', async () => {
    classifyNull = true
    mockGetPendingMessages.mockReturnValue([row(716, { trace_id: 'trace-from-row', span_id: 'span-from-row' })])
    await tick()
    const expected = { traceId: 'trace-from-row', spanId: 'span-from-row' }
    expect(failedTraces).toEqual([{ id: 716, trace: expected }])
    expect(closedTraces).toEqual([{ traceId: 'trace-from-row', trace: expected }])
  })

  it('a throw before the stamp on a row without a trace: nothing to run in', async () => {
    classifyThrows = true
    mockGetPendingMessages.mockReturnValue([row(714, { trace_id: null, span_id: null })])
    await tick()
    expect(failedTraces).toEqual([{ id: 714, trace: undefined }])
    expect(closedTraces).toEqual([])
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

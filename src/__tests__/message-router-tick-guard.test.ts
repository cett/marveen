// The router tick awaits the db between its statements, so a tick can now take longer than the 5 s timer. The
// process-local state of the router (the per-tick sets, the failure counters) is only safe because one tick runs at
// a time: a timer that fires while the previous tick is still waiting must skip, and the next one runs after it ends.
// A failing tick is logged and does not stop the timer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({ pending: vi.fn(), error: vi.fn() }))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: mocks.error },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (...a: unknown[]) => mocks.pending(...a),
  markMessageDelivered: () => Promise.resolve(true),
  markMessageFailed: () => Promise.resolve(true),
  markMessageDone: () => Promise.resolve(true),
  markMessageNoSession: () => Promise.resolve(true),
  markPendingFederatedFailed: () => Promise.resolve(true),
  setMessageResult: () => Promise.resolve(true),
  createAgentMessage: () => Promise.resolve({ id: 999 }),
  stampMessageTrace: () => Promise.resolve(false),
  upsertOtelSpan: () => undefined,
  closeOtelSpan: () => false,
}))

vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))
vi.mock('../web/agent-config.js', () => ({ readAgentRemoteHost: () => null, readAgentVoiceConfig: () => ({ responseMode: 'text' }) }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => false),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: () => false,
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { startMessageRouter } from '../web/message-router.js'

let timer: NodeJS.Timeout | undefined

beforeEach(() => {
  vi.useFakeTimers()
  mocks.pending.mockReset()
  mocks.error.mockReset()
})
afterEach(() => {
  if (timer) clearInterval(timer)
  timer = undefined
  vi.useRealTimers()
})

describe('startMessageRouter re-entrancy guard', () => {
  it('a timer that fires during a slow tick skips; the first timer after the tick has ended runs', async () => {
    let release: (rows: unknown[]) => void = () => undefined
    mocks.pending.mockReturnValueOnce(new Promise<unknown[]>((resolve) => { release = resolve }))
    mocks.pending.mockResolvedValue([])
    timer = startMessageRouter()

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.pending).toHaveBeenCalledTimes(1)
    // two more timer firings while the first tick still waits for its read
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.pending).toHaveBeenCalledTimes(1)

    release([])
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.pending).toHaveBeenCalledTimes(2)
  })

  it('a failing tick is logged, releases the guard and the next timer runs', async () => {
    mocks.pending.mockRejectedValueOnce(new Error('db closed'))
    mocks.pending.mockResolvedValue([])
    timer = startMessageRouter()

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'message-router: tick failed')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.pending).toHaveBeenCalledTimes(2)
  })
})

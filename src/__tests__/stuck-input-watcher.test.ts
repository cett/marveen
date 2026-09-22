// Unit tests for the stuck-input-watcher backstop (src/web/stuck-input-watcher.ts).
//
// The module wires together tmux I/O (agent-process), the pure pane-state
// decision function, the delivery-intent gate and the channel-monitor local
// re-inject path. Everything at that boundary is mocked so these tests
// exercise the watcher's OWN branching: the delivery-intent gate on a bare
// recovery Enter, the one-shot give-up log, and the sweep() orchestration
// (isAgentRunning gating, local vs remote dispatch, the give-up alert).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const mockLoggerWarn = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'marveen' }))

const mockListAgentNames = vi.fn<() => string[]>()
const mockReadAgentRemoteHost = vi.fn<(name: string) => string | null>()
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: (...a: unknown[]) => mockListAgentNames(...(a as [])),
  readAgentRemoteHost: (...a: unknown[]) => mockReadAgentRemoteHost(...(a as [string])),
}))

const mockIsAgentRunning = vi.fn<(name: string) => boolean>()
const mockCaptureParkedInputView = vi.fn<(session: string, host: string | null) => string | null>()
const mockSendEnterToSession = vi.fn<(session: string, host: string | null) => boolean>()
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (...a: unknown[]) => mockIsAgentRunning(...(a as [string])),
  captureParkedInputView: (...a: unknown[]) => mockCaptureParkedInputView(...(a as [string, string | null])),
  sendEnterToSession: (...a: unknown[]) => mockSendEnterToSession(...(a as [string, string | null])),
}))

const mockResolveAgentSession = vi.fn<(name: string) => string>()
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  resolveAgentSession: (...a: unknown[]) => mockResolveAgentSession(...(a as [string])),
}))

vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))

const mockRecoverStuckInputForSession = vi.fn()
const mockSendAlert = vi.fn()
vi.mock('../web/channel-monitor.js', () => ({
  recoverStuckInputForSession: (...a: unknown[]) => mockRecoverStuckInputForSession(...a),
  sendAlert: (...a: unknown[]) => mockSendAlert(...a),
}))

const mockStuckInputSignature = vi.fn<(pane: string) => string | null>()
const mockParkedPasteSignature = vi.fn<(pane: string) => string | null>()
const mockParkedChannelInput = vi.fn()
const mockParkedInputText = vi.fn<(pane: string) => string | null>()
const mockDecideStuckInputRecovery = vi.fn()
vi.mock('../pane-state.js', () => ({
  stuckInputSignature: (...a: unknown[]) => mockStuckInputSignature(...(a as [string])),
  parkedPasteSignature: (...a: unknown[]) => mockParkedPasteSignature(...(a as [string])),
  parkedChannelInput: (...a: unknown[]) => mockParkedChannelInput(...a),
  parkedInputText: (...a: unknown[]) => mockParkedInputText(...(a as [string])),
  decideStuckInputRecovery: (...a: unknown[]) => mockDecideStuckInputRecovery(...a),
}))

const mockMatchDelivery = vi.fn<(session: string, text: string) => boolean>()
vi.mock('../web/delivery-intent.js', () => ({
  matchDelivery: (...a: unknown[]) => mockMatchDelivery(...(a as [string, string])),
}))

import { _bareEnterRecovery, startStuckInputWatcher } from '../web/stuck-input-watcher.js'

const NO_STATE = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

describe('_bareEnterRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('nothing parked: does not read a signature or send an Enter', () => {
    mockCaptureParkedInputView.mockReturnValue(null)
    mockDecideStuckInputRecovery.mockReturnValue({ recover: false, next: { ...NO_STATE } })

    _bareEnterRecovery('agentX', 'session-1', null)

    expect(mockStuckInputSignature).not.toHaveBeenCalled()
    expect(mockDecideStuckInputRecovery).toHaveBeenCalledWith(null, expect.objectContaining({ parkedSig: null }), expect.any(Number), expect.objectContaining({ maxAttempts: 3 }))
    expect(mockSendEnterToSession).not.toHaveBeenCalled()
  })

  it('recovers via a complete <channel> block without consulting the delivery gate', () => {
    mockCaptureParkedInputView.mockReturnValue('pane-text')
    mockStuckInputSignature.mockReturnValue('sig-1')
    mockDecideStuckInputRecovery.mockReturnValue({ recover: true, next: { parkedSig: 'sig-1', firstSeenAt: 1, lastRecoverAt: null, attempts: 1 } })
    mockParkedChannelInput.mockReturnValue({ complete: true, block: '<channel>hi</channel>' })

    _bareEnterRecovery('agentX', 'session-2', 'remote-host')

    expect(mockParkedInputText).not.toHaveBeenCalled()
    expect(mockMatchDelivery).not.toHaveBeenCalled()
    expect(mockSendEnterToSession).toHaveBeenCalledWith('session-2', 'remote-host')
  })

  it('holds a plain-text recovery that is not attributed to a known delivery', () => {
    mockCaptureParkedInputView.mockReturnValue('pane-text')
    mockStuckInputSignature.mockReturnValue('sig-2')
    mockDecideStuckInputRecovery.mockReturnValue({ recover: true, next: { parkedSig: 'sig-2', firstSeenAt: 1, lastRecoverAt: null, attempts: 1 } })
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue('stray input')
    mockMatchDelivery.mockReturnValue(false)

    _bareEnterRecovery('agentX', 'session-3', null)

    expect(mockMatchDelivery).toHaveBeenCalledWith('session-3', 'stray input')
    expect(mockSendEnterToSession).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ session: 'session-3' }), expect.stringContaining('held'))
  })

  it('recovers a plain-text recovery that IS attributed to a genuine delivery', () => {
    mockCaptureParkedInputView.mockReturnValue('pane-text')
    mockStuckInputSignature.mockReturnValue('sig-3')
    mockDecideStuckInputRecovery.mockReturnValue({ recover: true, next: { parkedSig: 'sig-3', firstSeenAt: 1, lastRecoverAt: null, attempts: 1 } })
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue('a real inter-agent message')
    mockMatchDelivery.mockReturnValue(true)

    _bareEnterRecovery('agentX', 'session-4', null)

    expect(mockSendEnterToSession).toHaveBeenCalledWith('session-4', null)
  })

  it('does not send an Enter when a signature is read but the pane capture is missing at decision time', () => {
    // Guards the `recover && pane != null` condition: decideStuckInputRecovery
    // could say recover=true from stale state even if this tick's capture failed.
    mockCaptureParkedInputView.mockReturnValue(null)
    mockDecideStuckInputRecovery.mockReturnValue({ recover: true, next: { parkedSig: 'sig-x', firstSeenAt: 1, lastRecoverAt: null, attempts: 1 } })

    _bareEnterRecovery('agentX', 'session-4b', null)

    expect(mockSendEnterToSession).not.toHaveBeenCalled()
  })

  it('logs a one-shot give-up at max attempts and does not repeat it on the next tick', () => {
    mockCaptureParkedInputView.mockReturnValue('pane-text')
    mockStuckInputSignature.mockReturnValue('sig-4')
    mockDecideStuckInputRecovery.mockReturnValue({ recover: false, next: { parkedSig: 'sig-4', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 } })

    _bareEnterRecovery('agentX', 'session-5', null)
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ session: 'session-5' }), expect.stringContaining('giving up'))

    // Second tick: state now persisted with attempts already at the cap, so
    // the give-up must not be logged again for the same spell.
    _bareEnterRecovery('agentX', 'session-5', null)
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
  })
})

describe('startStuckInputWatcher: sweep orchestration', () => {
  afterAll(() => {
    vi.useRealTimers()
  })

  it('dispatches MAIN + per-agent recovery on each tick: skips non-running agents, alerts a stuck local sub-agent, bare-recovers a remote one', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockCaptureParkedInputView.mockImplementation((session: string) => {
      if (session === 'marveen-channels') return 'pane-main'
      if (session === 'agent-sub-b') return 'pane-b'
      if (session === 'agent-sub-c') return 'pane-c'
      return null
    })
    mockParkedPasteSignature.mockReturnValue(null) // no paste placeholders this tick

    mockRecoverStuckInputForSession.mockImplementation((session: string) => {
      if (session === 'agent-sub-b') return Promise.resolve({ parkedSig: 'sig-b', firstSeenAt: 1, lastRecoverAt: 1, attempts: 5 })
      return Promise.resolve({ ...NO_STATE })
    })

    mockListAgentNames.mockReturnValue(['sub-a', 'sub-b', 'sub-c'])
    mockIsAgentRunning.mockImplementation((name: string) => name !== 'sub-a')
    mockReadAgentRemoteHost.mockImplementation((name: string) => name === 'sub-c' ? 'remote-host' : null)
    mockResolveAgentSession.mockImplementation((name: string) => {
      if (name === 'sub-b') return 'agent-sub-b'
      if (name === 'sub-c') return 'agent-sub-c'
      return `agent-${name}`
    })

    mockStuckInputSignature.mockImplementation((pane: string) => pane === 'pane-c' ? 'sig-c' : null)
    mockDecideStuckInputRecovery.mockImplementation((sig: string | null) => {
      if (sig === 'sig-c') return { recover: true, next: { parkedSig: 'sig-c', firstSeenAt: 1, lastRecoverAt: null, attempts: 1 } }
      return { recover: false, next: { ...NO_STATE } }
    })
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue('remote stray text')
    mockMatchDelivery.mockReturnValue(true)

    const watcher = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000) // INITIAL_DELAY_MS

    // MAIN: normal (non-paste) path runs through recoverStuckInputForSession
    // with alertOnGiveUp=false and allowPlainReinject=false.
    expect(mockRecoverStuckInputForSession).toHaveBeenCalledWith('marveen-channels', expect.anything(), expect.objectContaining({ maxAttempts: 5 }), false)

    // sub-a is not running: its state is cleared and it is skipped entirely.
    expect(mockResolveAgentSession).toHaveBeenCalledWith('sub-a')
    expect(mockCaptureParkedInputView).not.toHaveBeenCalledWith('agent-sub-a', null)

    // sub-b: local sub-agent maxed out its recovery attempts -> one-shot alert.
    expect(mockRecoverStuckInputForSession).toHaveBeenCalledWith('agent-sub-b', expect.anything(), expect.objectContaining({ maxAttempts: 5 }), true)
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(mockSendAlert.mock.calls[0][0]).toContain('sub-b')

    // sub-c: remote sub-agent, no local tmux re-inject -> bare Enter recovery,
    // gated by (and passing) the delivery-intent match.
    expect(mockMatchDelivery).toHaveBeenCalledWith('agent-sub-c', 'remote stray text')
    expect(mockSendEnterToSession).toHaveBeenCalledWith('agent-sub-c', 'remote-host')

    clearInterval(watcher)
  })

  it('swallows a per-agent check error and keeps logging it at debug level', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockCaptureParkedInputView.mockImplementation((session: string) => {
      if (session === 'agent-boom') throw new Error('tmux capture blew up')
      return null
    })
    mockParkedPasteSignature.mockReturnValue(null)
    mockRecoverStuckInputForSession.mockResolvedValue({ ...NO_STATE })

    mockListAgentNames.mockReturnValue(['boom-agent'])
    mockIsAgentRunning.mockReturnValue(true)
    mockReadAgentRemoteHost.mockReturnValue(null)
    mockResolveAgentSession.mockReturnValue('agent-boom')

    const watcher = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(mockLoggerDebug).toHaveBeenCalledWith(expect.objectContaining({ agent: 'boom-agent' }), expect.stringContaining('agent check error'))

    clearInterval(watcher)
  })
})

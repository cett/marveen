import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// tick() is the thin I/O shell around the pure decideNudgePreflight/recordNudge
// (already unit-tested in inbox-nudge-watcher.test.ts). These tests exercise
// the actual wiring: session-existence, busy-gate, the send outcome switch
// (sent / aborted-busy / skipped-locked / throw), and the outer error fence.

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../db.js', () => ({
  getPendingMessages: vi.fn(),
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn(() => 'hu'),
}))
vi.mock('../web/agent-process.js', () => ({
  isSessionReadyForPrompt: vi.fn(async () => true),
  sendPromptToSession: vi.fn(async () => 'sent' as const),
  sessionExistsOnHost: vi.fn(() => true),
}))
vi.mock('../web/channel-monitor.js', () => ({
  sendAlert: vi.fn(),
}))

import { logger } from '../logger.js'
import { getPendingMessages } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { isSessionReadyForPrompt, sendPromptToSession, sessionExistsOnHost } from '../web/agent-process.js'
import {
  tick,
  _resetNudgeStateForTest,
  nudgeText,
  MIN_PENDING_AGE_MS,
  BUSY_WAIT_LOG_INTERVAL_MS,
} from '../web/inbox-nudge-watcher.js'

const mGetPending = vi.mocked(getPendingMessages)
const mIsReady = vi.mocked(isSessionReadyForPrompt)
const mSend = vi.mocked(sendPromptToSession)
const mSessionExists = vi.mocked(sessionExistsOnHost)
const mGetSetting = vi.mocked(getEffectiveSettingValue)
const mLoggerInfo = vi.mocked(logger.info)
const mLoggerWarn = vi.mocked(logger.warn)

const T0 = 1_800_000_000_000
const AGED_MSG = { id: 1, created_at: Math.floor((T0 - MIN_PENDING_AGE_MS - 5000) / 1000) }

describe('inbox-nudge-watcher tick()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    _resetNudgeStateForTest()
    vi.clearAllMocks()
    mGetPending.mockReturnValue([AGED_MSG] as any)
    mSessionExists.mockReturnValue(true)
    mIsReady.mockResolvedValue(true)
    mSend.mockResolvedValue('sent')
    mGetSetting.mockReturnValue('hu')
  })

  afterEach(() => { vi.useRealTimers() })

  it('empty inbox: no session/send calls at all', async () => {
    mGetPending.mockReturnValue([])
    await tick()
    expect(mSessionExists).not.toHaveBeenCalled()
    expect(mSend).not.toHaveBeenCalled()
  })

  it('happy path: session ready, sends the nudge, logs success', async () => {
    await tick()
    expect(mSend).toHaveBeenCalledTimes(1)
    expect(mSend.mock.calls[0][1]).toBe(nudgeText('hu'))
    expect(mLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudge: true }),
      expect.stringContaining('prompted the main agent'),
    )
  })

  it('resolveLang falls back to hu when the setting lookup throws', async () => {
    mGetSetting.mockImplementation(() => { throw new Error('settings store down') })
    await tick()
    expect(mSend.mock.calls[0][1]).toBe(nudgeText('hu'))
  })

  it('channels session absent: logs once per absence spell, never sends', async () => {
    mSessionExists.mockReturnValue(false)
    await tick()
    await tick()
    expect(mSend).not.toHaveBeenCalled()
    const absenceLogs = mLoggerInfo.mock.calls.filter((c) => String(c[1]).includes('channels session absent'))
    expect(absenceLogs).toHaveLength(1) // logged once, not per tick
  })

  it('session busy (not ready): skips the send, throttles the busy-wait log', async () => {
    mIsReady.mockResolvedValue(false)
    await tick()
    await tick() // immediately again: within the throttle window, no 2nd log
    expect(mSend).not.toHaveBeenCalled()
    const busyLogs = mLoggerInfo.mock.calls.filter((c) => String(c[1]).includes('main session busy'))
    expect(busyLogs).toHaveLength(1)

    vi.setSystemTime(T0 + BUSY_WAIT_LOG_INTERVAL_MS + 1)
    await tick()
    const busyLogsAfter = mLoggerInfo.mock.calls.filter((c) => String(c[1]).includes('main session busy'))
    expect(busyLogsAfter).toHaveLength(2) // throttle window elapsed -> logs again
  })

  it('aborted-busy: nothing typed, debounce is undone so the very next tick can retry', async () => {
    mSend.mockResolvedValueOnce('aborted-busy')
    await tick()
    expect(mSend).toHaveBeenCalledTimes(1)
    // Same instant (no time advance): if the debounce had been consumed this
    // would be skipped. It is not -- proving the state was rolled back.
    mSend.mockResolvedValueOnce('sent')
    await tick()
    expect(mSend).toHaveBeenCalledTimes(2)
  })

  it('skipped-locked: nothing typed, debounce is undone the same way', async () => {
    mSend.mockResolvedValueOnce('skipped-locked')
    await tick()
    mSend.mockResolvedValueOnce('sent')
    await tick()
    expect(mSend).toHaveBeenCalledTimes(2)
  })

  it('send throws: state is restored (no debounce consumed), warning logged', async () => {
    mSend.mockRejectedValueOnce(new Error('tmux ECONNRESET'))
    await tick()
    expect(mLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('send threw'),
    )
    mSend.mockResolvedValueOnce('sent')
    await tick()
    expect(mSend).toHaveBeenCalledTimes(2)
  })

  it('a synchronous failure anywhere in the tick is caught, never rejects', async () => {
    mGetPending.mockImplementation(() => { throw new Error('db unavailable') })
    await expect(tick()).resolves.toBeUndefined()
    expect(mLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'inbox nudge: tick error')
  })
})

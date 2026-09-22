import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  execFileSyncMock, capturePaneMock, resumeMarveenSessionMock, sendAlertMock, lastMainRespawnAtMock,
  stuckToolCallSignatureMock, decideStuckToolCallRecoveryMock, detectPaneStateMock,
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  capturePaneMock: vi.fn(),
  resumeMarveenSessionMock: vi.fn(),
  sendAlertMock: vi.fn(),
  lastMainRespawnAtMock: vi.fn(),
  stuckToolCallSignatureMock: vi.fn(),
  decideStuckToolCallRecoveryMock: vi.fn(),
  detectPaneStateMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/local/bin/tmux' }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-process.js', () => ({ capturePane: capturePaneMock }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels' }))
vi.mock('../web/channel-monitor.js', () => ({
  resumeMarveenSession: resumeMarveenSessionMock,
  sendAlert: sendAlertMock,
  lastMainRespawnAt: lastMainRespawnAtMock,
  MARVEEN_POST_RESPAWN_GRACE_MS: 5 * 60_000,
}))
vi.mock('../pane-state.js', () => ({
  stuckToolCallSignature: stuckToolCallSignatureMock,
  decideStuckToolCallRecovery: decideStuckToolCallRecoveryMock,
  detectPaneState: detectPaneStateMock,
}))

import {
  confirmsWedgeProfile,
  shouldDeferForRecentRespawn,
  startStuckToolCallWatcher,
} from '../web/stuck-tool-call-watcher.js'

const NO_STATE_RESULT = {
  recover: false,
  next: { tag: null, spellStartSeconds: null, spellPeakSeconds: null, firstSeenAt: null, lastSeconds: null, stagnantPolls: 0, stagnantSince: null, attempts: 0 },
}

beforeEach(() => {
  vi.useFakeTimers()
  execFileSyncMock.mockReset().mockReturnValue('42')
  capturePaneMock.mockReset().mockReturnValue('some pane text')
  resumeMarveenSessionMock.mockReset().mockResolvedValue(true)
  sendAlertMock.mockReset()
  lastMainRespawnAtMock.mockReset().mockReturnValue(0)
  stuckToolCallSignatureMock.mockReset().mockReturnValue(null)
  decideStuckToolCallRecoveryMock.mockReset().mockReturnValue(NO_STATE_RESULT)
  detectPaneStateMock.mockReset().mockReturnValue('busy')
})

afterEach(() => vi.useRealTimers())

describe('confirmsWedgeProfile', () => {
  it('fails open (true) on a null CPU sample', () => {
    expect(confirmsWedgeProfile(null, 30)).toBe(true)
  })

  it('is true when CPU is at or below the threshold', () => {
    expect(confirmsWedgeProfile(30, 30)).toBe(true)
    expect(confirmsWedgeProfile(5, 30)).toBe(true)
  })

  it('is false when CPU exceeds the threshold (actively burning CPU, not a wedge)', () => {
    expect(confirmsWedgeProfile(31, 30)).toBe(false)
  })
})

describe('shouldDeferForRecentRespawn', () => {
  it('is false when no respawn was ever recorded (lastRespawnMs=0)', () => {
    expect(shouldDeferForRecentRespawn(0, 100_000, 60_000)).toBe(false)
  })

  it('is true within the grace window', () => {
    expect(shouldDeferForRecentRespawn(1000, 1000 + 30_000, 60_000)).toBe(true)
  })

  it('is false once the grace window has elapsed', () => {
    expect(shouldDeferForRecentRespawn(1000, 1000 + 60_001, 60_000)).toBe(false)
  })
})

describe('startStuckToolCallWatcher -- sweep behavior', () => {
  it('does nothing before the initial delay', async () => {
    startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(1000)
    expect(capturePaneMock).not.toHaveBeenCalled()
  })

  it('takes no action when the decision says no recovery is needed', async () => {
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(capturePaneMock).toHaveBeenCalledWith('main-channels')
    expect(resumeMarveenSessionMock).not.toHaveBeenCalled()
    clearInterval(handle)
  })

  it('skips recovery when the pane is idle (residual footer, not a real wedge)', async () => {
    decideStuckToolCallRecoveryMock.mockReturnValue({ recover: true, next: { ...NO_STATE_RESULT.next, tag: 'Worked', lastSeconds: 45 } })
    detectPaneStateMock.mockReturnValue('idle')
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(resumeMarveenSessionMock).not.toHaveBeenCalled()
    clearInterval(handle)
  })

  it('defers recovery within the post-respawn grace window', async () => {
    decideStuckToolCallRecoveryMock.mockReturnValue({ recover: true, next: { ...NO_STATE_RESULT.next, tag: 'Worked', lastSeconds: 45 } })
    detectPaneStateMock.mockReturnValue('busy')
    lastMainRespawnAtMock.mockReturnValue(Date.now())
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(resumeMarveenSessionMock).not.toHaveBeenCalled()
    clearInterval(handle)
  })

  it('defers recovery when the process is still CPU-active (not the idle-wedge profile)', async () => {
    decideStuckToolCallRecoveryMock.mockReturnValue({ recover: true, next: { ...NO_STATE_RESULT.next, tag: 'Worked', lastSeconds: 200 } })
    detectPaneStateMock.mockReturnValue('busy')
    execFileSyncMock.mockImplementation((bin: string) =>
      bin.includes('tmux') ? '4242\n' : '75.0', // ps -o %cpu= well above the 30% ceiling
    )
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(resumeMarveenSessionMock).not.toHaveBeenCalled()
    clearInterval(handle)
  })

  it('recovers via resumeMarveenSession and sends a success alert on a confirmed wedge', async () => {
    decideStuckToolCallRecoveryMock.mockReturnValue({ recover: true, next: { ...NO_STATE_RESULT.next, tag: 'Worked', lastSeconds: 200 } })
    detectPaneStateMock.mockReturnValue('busy')
    execFileSyncMock.mockImplementation((bin: string) => (bin.includes('tmux') ? '4242\n' : '0.3'))
    resumeMarveenSessionMock.mockResolvedValue(true)
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(resumeMarveenSessionMock).toHaveBeenCalled()
    expect(sendAlertMock).toHaveBeenCalledWith(expect.stringContaining('újraindítottam'))
    clearInterval(handle)
  })

  it('sends a failure alert when the respawn-pane recovery itself fails', async () => {
    decideStuckToolCallRecoveryMock.mockReturnValue({ recover: true, next: { ...NO_STATE_RESULT.next, tag: 'Worked', lastSeconds: 200 } })
    detectPaneStateMock.mockReturnValue('busy')
    execFileSyncMock.mockImplementation((bin: string) => (bin.includes('tmux') ? '4242\n' : '0.3'))
    resumeMarveenSessionMock.mockResolvedValue(false)
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(sendAlertMock).toHaveBeenCalledWith(expect.stringContaining('NEM sikerült'))
    clearInterval(handle)
  })

  it('swallows a thrown error from the check so the interval keeps running', async () => {
    capturePaneMock.mockImplementationOnce(() => { throw new Error('capture failed') })
    const handle = startStuckToolCallWatcher()
    await vi.advanceTimersByTimeAsync(35_000)
    const callsAfterFirstError = capturePaneMock.mock.calls.length
    expect(callsAfterFirstError).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(30_000)
    // A later tick must still run (the thrown error did not kill the interval).
    expect(capturePaneMock.mock.calls.length).toBeGreaterThan(callsAfterFirstError)
    clearInterval(handle)
  })
})

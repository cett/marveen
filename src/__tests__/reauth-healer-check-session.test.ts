import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// checkSession is the I/O-wrapped wiring around the pure decideReauthAction:
// it captures the pane, detects reauth state, drives the decision, and fires
// the side effects (send-keys / restart / escalate). Every dependency below
// is mocked so no real tmux/process/network call is ever made.

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, APP_TZ: 'UTC', RESPAWN_ENABLED: false, PROJECT_ROOT: '/tmp/marveen-test-root' }
})
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: unknown) => void) => {
    if (typeof cb === 'function') cb(null)
  }),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn(() => true),
  capturePane: vi.fn(() => 'some pane text'),
  startAgentProcess: vi.fn(() => ({ ok: true, pid: 123 })),
}))
vi.mock('../web/claude-credentials-guard.js', () => ({
  quarantineFleetTokenIfDead: vi.fn(async () => 'no-token' as const),
}))
vi.mock('../web/reauth-detect.js', () => ({
  detectReauthNeeded: vi.fn(() => ({ needsReauth: false, reason: undefined })),
}))
vi.mock('../web/session-send-lock.js', () => ({
  withSessionSendLock: vi.fn(async (_session: string, _x: unknown, _mode: string, fn: () => Promise<void>) => {
    await fn()
    return { ran: true }
  }),
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: vi.fn(() => 0),
  sendAlert: vi.fn(),
}))

import { capturePane, startAgentProcess } from '../web/agent-process.js'
import { quarantineFleetTokenIfDead } from '../web/claude-credentials-guard.js'
import { detectReauthNeeded } from '../web/reauth-detect.js'
import { hardRestartMarveenChannels } from '../web/channel-monitor.js'
import { checkSession, hostCanInteractiveLogin } from '../web/reauth-healer.js'

const mCapturePane = vi.mocked(capturePane)
const mDetectReauthNeeded = vi.mocked(detectReauthNeeded)
const mQuarantine = vi.mocked(quarantineFleetTokenIfDead)
const mHardRestart = vi.mocked(hardRestartMarveenChannels)
const mStartAgentProcess = vi.mocked(startAgentProcess)

describe('hostCanInteractiveLogin', () => {
  const origPlatform = process.platform
  const origDisplay = process.env.DISPLAY
  const origWayland = process.env.WAYLAND_DISPLAY

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
    if (origDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = origDisplay
    if (origWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = origWayland
  })

  it('darwin can always complete an interactive login', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(hostCanInteractiveLogin()).toBe(true)
  })

  it('headless linux (no DISPLAY/WAYLAND_DISPLAY) cannot', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    expect(hostCanInteractiveLogin()).toBe(false)
  })

  it('linux with a DISPLAY set can', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.DISPLAY = ':0'
    expect(hostCanInteractiveLogin()).toBe(true)
  })
})

describe('checkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mCapturePane.mockReturnValue('some pane text')
    mDetectReauthNeeded.mockReturnValue({ needsReauth: false, reason: undefined })
    mQuarantine.mockResolvedValue('no-token')
    mHardRestart.mockReturnValue({ ok: true })
  })

  it('clean token: no side effects fire', () => {
    checkSession('agent-a', 'session-agent-a', false, false)
    expect(mQuarantine).not.toHaveBeenCalled()
  })

  it('session gone (capturePane null): treated as not-applicable, no escalation', () => {
    mCapturePane.mockReturnValue(null)
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'Invalid authentication credentials (401)' })
    checkSession('agent-a', 'session-agent-a', false, false)
    expect(mQuarantine).not.toHaveBeenCalled()
  })

  it('dead token below threshold: tracked but no escalation/send-keys yet', () => {
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'Invalid authentication credentials (401)' })
    checkSession('agent-a', 'session-agent-a-below', false, false)
    expect(mQuarantine).not.toHaveBeenCalled()
  })

  it('dead token at threshold (sub-agent, non-first-run): escalates + quarantine probe fires', async () => {
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'Invalid authentication credentials (401)' })
    const session = 'session-agent-a-threshold'
    for (let i = 0; i < 3; i++) checkSession('agent-a', session, false, false)
    await vi.waitFor(() => expect(mQuarantine).toHaveBeenCalled())
  })

  it('first-run gate on a sub-agent: restarts instead of send-keys, still quarantine-skipped', async () => {
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'First-run onboarding picker (Select login method)' })
    const session = 'session-firstrun'
    for (let i = 0; i < 3; i++) checkSession('agent-b', session, false, false)
    await vi.waitFor(() => expect(mStartAgentProcess).toHaveBeenCalledWith('agent-b'), { timeout: 3000 })
    // The escalate branch skips the fleet-token quarantine probe for the first-run gate.
    expect(mQuarantine).not.toHaveBeenCalled()
  })

  it('main agent at threshold: restartMain path checks the respawn grace via channel-monitor', async () => {
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'Invalid authentication credentials (401)' })
    const session = 'session-main-threshold'
    for (let i = 0; i < 3; i++) checkSession('main-agent', session, true, false)
    await vi.waitFor(() => expect(mQuarantine).toHaveBeenCalled())
    await vi.waitFor(() => expect(mHardRestart).toHaveBeenCalled())
  })

  it('a heal (needsReauth flips false) resets the streak so the next spell starts fresh', async () => {
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'Invalid authentication credentials (401)' })
    const session = 'session-heal-reset'
    checkSession('agent-a', session, false, false)
    checkSession('agent-a', session, false, false)
    mDetectReauthNeeded.mockReturnValue({ needsReauth: false, reason: undefined })
    checkSession('agent-a', session, false, false) // healed: resets consecutiveDead to 0
    mDetectReauthNeeded.mockReturnValue({ needsReauth: true, reason: 'Invalid authentication credentials (401)' })
    // Two more dead probes only reach consecutiveDead=2 (reset happened), not 5 -- no escalation yet.
    checkSession('agent-a', session, false, false)
    checkSession('agent-a', session, false, false)
    await Promise.resolve()
    expect(mQuarantine).not.toHaveBeenCalled()
  })
})

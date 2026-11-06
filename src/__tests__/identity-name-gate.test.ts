// The post-spawn `/name` is no longer a blind `send-keys <cmd> Enter`. It goes out only into a pane that reads as a
// ready prompt, is re-probed a bounded number of times otherwise, and is SKIPPED (no keystrokes) when the budget runs
// out. The "Allow external CLAUDE.md file imports?" dialog is never answered: no key at all, one operator alert.
//
// Pane I/O is faked with a frame sequence: the pane the gate sees advances only when the gate waits between probes
// (the mocked delay), so a test states "first probe sees X, the retry sees Y" literally. pane-state and the send lane
// are the REAL modules; only tmux, the logger and the operator notifier are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    debug: vi.fn(),
  },
}))

const mockNotifyChannel = vi.fn<(text: string) => Promise<void>>()
vi.mock('../notify.js', () => ({
  notifyChannel: (...a: unknown[]) => mockNotifyChannel(...(a as [string])),
}))

vi.mock('../web/agent-process-config.js', () => ({ stampFableOverageConsent: vi.fn() }))
vi.mock('../web/agent-process-spawn.js', () => ({ startAgentProcess: vi.fn() }))

import { NAME_GATE_RETRIES, NAME_GATE_RETRY_DELAY_MS } from '../web/agent-process-identity.js'
import { detectPaneState, decideSubmitFollowup } from '../pane-state.js'

// The fake pane. `frames[min(frameIdx, last)]` is what capturePane returns; the gate's retry wait advances it.
let frames: string[] = []
let frameIdx = 0
const currentFrame = (): string => frames[Math.min(frameIdx, frames.length - 1)]

const mockRunTmux = vi.fn<(host: string | null, args: string[], opts?: unknown) => void>()
const mockDelay = vi.fn<(ms: number) => Promise<void>>()
vi.mock('../web/agent-process-session.js', () => ({
  capturePane: () => currentFrame(),
  captureTmux: () => currentFrame(),
  runTmux: (...a: unknown[]) => mockRunTmux(...(a as [string | null, string[], unknown])),
  delay: (...a: unknown[]) => mockDelay(...(a as [number])),
  // The REAL readiness rule is idle-by-detectPaneState (+ a dim-ghost carve-out that does not matter for these frames);
  // mirror just that so the gate is exercised against real pane classification.
  isSessionReadyForPrompt: () => Promise.resolve(detectPaneState(currentFrame()) === 'idle'),
  sendPromptToSession: vi.fn(),
}))

import {
  alertExternalImportsDialogOnce,
  resetImportsDialogAlerts,
  scheduleIdentitySetup,
  sendIdentityCommandGuarded,
} from '../web/agent-process-identity.js'
import { __resetSessionSendLocks, tryAcquireSessionSendLane } from '../web/session-send-lock.js'

const CH = (code: number, n = 1): string => String.fromCharCode(code).repeat(n)
const RULE = (n: number): string => CH(0x2500, n)
const CURSOR = CH(0x276f)
const DOT = CH(0x00b7)
const ELLIPSIS = CH(0x2026)

// Verbatim shape of the dialog frame (80 columns, trailing empty rows from a tall pane); path neutralized.
const IMPORTS_DIALOG = [
  RULE(80),
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files outside the current",
  '  working directory. Never allow this for third-party repositories.',
  '',
  '  External imports:',
  `    /private/tmp/sandbox/-home-user${ELLIPSIS}hpad/imports-probe/outside-persona.md`,
  '',
  '  Important: Only use Claude Code with files you trust. Accessing untrusted',
  '  files may pose security risks https://code.claude.com/docs/en/security',
  '',
  `  ${CURSOR} No, disable external imports`,
  '    Yes, allow external imports',
  '',
  `  Enter to confirm ${DOT} Esc to cancel`,
].join('\n') + '\n'.repeat(8)

const IDLE_PANE = [RULE(80), `${CURSOR} `, RULE(80), '  ? for shortcuts'].join('\n')
const BUSY_PANE = [`${CH(0x2736)} Working${ELLIPSIS} (12s ${DOT} ${CH(0x2193)} 1.2k tokens)`, '  esc to interrupt'].join('\n')
// A modal the gate does not know: not idle, not the imports dialog.
const UNKNOWN_MODAL = ['  Some brand new consent screen', '', '  1. Yes', '  2. No', '', `  Enter to confirm ${DOT} Esc to cancel`].join('\n')

const SESSION = 'agent-a'
const NAME_CMD = '/name Agent A'

function useFrames(...f: string[]): void {
  frames = f
  frameIdx = 0
}

const sentKeys = (): string[][] => mockRunTmux.mock.calls.map(c => c[1])

beforeEach(() => {
  vi.clearAllMocks()
  mockRunTmux.mockReset()
  mockDelay.mockReset()
  mockDelay.mockImplementation((ms: number) => {
    // Only the gate's retry wait moves the pane on; other delays (post-send settle) do not.
    if (ms === NAME_GATE_RETRY_DELAY_MS) frameIdx++
    return Promise.resolve()
  })
  mockNotifyChannel.mockReset()
  mockNotifyChannel.mockResolvedValue(undefined)
  __resetSessionSendLocks()
  resetImportsDialogAlerts()
  useFrames(IDLE_PANE)
})

describe('fixture sanity (a wrong fixture must fail here, not pass silently below)', () => {
  it('the idle frame is idle, the busy frame is busy, the modal frame is neither', () => {
    expect(detectPaneState(IDLE_PANE)).toBe('idle')
    expect(detectPaneState(BUSY_PANE)).toBe('busy')
    expect(detectPaneState(UNKNOWN_MODAL)).not.toBe('idle')
    expect(detectPaneState(IMPORTS_DIALOG)).not.toBe('idle')
  })
})

describe('sendIdentityCommandGuarded: the /name gate', () => {
  it('(a) an idle pane gets the /name exactly once, in one send-keys call, with no wait', async () => {
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('sent')
    expect(sentKeys()).toEqual([['send-keys', '-t', SESSION, NAME_CMD, 'Enter']])
    expect(mockDelay).not.toHaveBeenCalled()
    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })

  it('(b) the imports dialog: no keystroke at all, one operator alert, no retry wait', async () => {
    useFrames(IMPORTS_DIALOG)
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('skipped-imports-dialog')
    expect(mockRunTmux).not.toHaveBeenCalled() // in particular never '1', 'Enter' or 'Escape'
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(mockDelay).not.toHaveBeenCalled()
  })

  it('(b2) the alert text names the session and the dialog but carries no pane contents', async () => {
    useFrames(IMPORTS_DIALOG)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    const text = mockNotifyChannel.mock.calls[0][0]
    expect(text).toContain(SESSION)
    expect(text).toContain('Allow external CLAUDE.md file imports?')
    expect(text).not.toContain('outside-persona.md')
    expect(text).not.toContain('Never allow this')
  })

  it('(b3) a respawn loop on the same stuck dialog alerts once, not once per spawn', async () => {
    useFrames(IMPORTS_DIALOG)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('(b4) another session on the same dialog gets its own alert', async () => {
    useFrames(IMPORTS_DIALOG)
    await sendIdentityCommandGuarded('agent-a', NAME_CMD, null)
    await sendIdentityCommandGuarded('agent-b', NAME_CMD, null)
    expect(mockNotifyChannel).toHaveBeenCalledTimes(2)
  })

  it('(b5) once a /name lands on the session the alert re-arms for a later recurrence', async () => {
    useFrames(IMPORTS_DIALOG)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    useFrames(IDLE_PANE)
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('sent')
    useFrames(IMPORTS_DIALOG)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    expect(mockNotifyChannel).toHaveBeenCalledTimes(2)
  })

  it('(b6) the dialog appearing on a LATER probe is still never answered', async () => {
    useFrames(UNKNOWN_MODAL, IMPORTS_DIALOG)
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('skipped-imports-dialog')
    expect(mockRunTmux).not.toHaveBeenCalled()
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(mockDelay).toHaveBeenCalledTimes(1) // one retry wait, then stop
  })

  it('(c) not ready on the first probe, idle on the retry: sent on the retry, exactly once', async () => {
    useFrames('', IDLE_PANE) // an empty capture reads as unknown
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('sent')
    expect(mockDelay).toHaveBeenCalledTimes(1)
    expect(mockDelay).toHaveBeenCalledWith(NAME_GATE_RETRY_DELAY_MS)
    expect(sentKeys()).toEqual([['send-keys', '-t', SESSION, NAME_CMD, 'Enter']])
  })

  it('(c2) a busy pane is not a ready prompt: waits, then sends once it idles', async () => {
    useFrames(BUSY_PANE, BUSY_PANE, IDLE_PANE)
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('sent')
    expect(mockDelay).toHaveBeenCalledTimes(2)
    expect(mockRunTmux).toHaveBeenCalledTimes(1)
  })

  it('(d) never ready within the budget: no keystroke, exactly the budgeted probes, one warn with the state name only', async () => {
    useFrames(UNKNOWN_MODAL)
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('skipped-not-ready')
    expect(mockRunTmux).not.toHaveBeenCalled()
    expect(mockDelay).toHaveBeenCalledTimes(NAME_GATE_RETRIES)
    for (const call of mockDelay.mock.calls) expect(call[0]).toBe(NAME_GATE_RETRY_DELAY_MS)
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
    const [fields, message] = mockLoggerWarn.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields).toEqual({ session: SESSION, paneState: detectPaneState(UNKNOWN_MODAL), attempts: NAME_GATE_RETRIES + 1 })
    expect(message).toContain('/name skipped')
    // The pane text must not leak into the log line.
    expect(JSON.stringify(mockLoggerWarn.mock.calls[0])).not.toContain('brand new consent')
    expect(mockNotifyChannel).not.toHaveBeenCalled() // an unknown modal is a log, not an imports alert
  })

  it('(d2) a capture that always fails is not ready either and is named as such', async () => {
    frames = [null as unknown as string]
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('skipped-not-ready')
    expect(mockRunTmux).not.toHaveBeenCalled()
    expect((mockLoggerWarn.mock.calls[0][0] as Record<string, unknown>).paneState).toBe('capture-failed')
  })

  it('(e) a busy send lane: the /name does not wait on it, does not send, and does not steal it', async () => {
    const release = tryAcquireSessionSendLane(SESSION, null)
    expect(release).not.toBeNull()
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('skipped-not-ready')
    expect(mockRunTmux).not.toHaveBeenCalled()
    expect((mockLoggerWarn.mock.calls[0][0] as Record<string, unknown>).paneState).toBe('send-lane-busy')
    // Still held by the original owner: the gate neither released nor took it.
    expect(tryAcquireSessionSendLane(SESSION, null)).toBeNull()
    release!()
  })

  it('(e2) the lane frees up mid-budget: the next probe sends', async () => {
    const release = tryAcquireSessionSendLane(SESSION, null)!
    mockDelay.mockImplementation((ms: number) => {
      if (ms === NAME_GATE_RETRY_DELAY_MS) release()
      return Promise.resolve()
    })
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('sent')
    expect(mockRunTmux).toHaveBeenCalledTimes(1)
  })

  it('(e3) the lane is released after a send, after a skip and after a tmux error', async () => {
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    const afterSend = tryAcquireSessionSendLane(SESSION, null)
    expect(afterSend).not.toBeNull()
    afterSend!()

    useFrames(UNKNOWN_MODAL)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    const afterSkip = tryAcquireSessionSendLane(SESSION, null)
    expect(afterSkip).not.toBeNull()
    afterSkip!()

    useFrames(IDLE_PANE)
    mockRunTmux.mockImplementation(() => { throw new Error('session gone') })
    await expect(sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).rejects.toThrow('session gone')
    const afterError = tryAcquireSessionSendLane(SESSION, null)
    expect(afterError).not.toBeNull()
    afterError!()
  })

  it('(e4) the lane is held only while probing, never across the retry wait', async () => {
    useFrames(UNKNOWN_MODAL, IDLE_PANE)
    let laneFreeDuringWait: boolean | null = null
    mockDelay.mockImplementation((ms: number) => {
      if (ms === NAME_GATE_RETRY_DELAY_MS) {
        const r = tryAcquireSessionSendLane(SESSION, null)
        laneFreeDuringWait = r != null
        r?.()
        frameIdx++
      }
      return Promise.resolve()
    })
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    expect(laneFreeDuringWait).toBe(true)
  })

  it('an unrelated unknown modal is skipped silently-by-keystroke: it is not mistaken for the imports dialog', async () => {
    useFrames(UNKNOWN_MODAL)
    await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)
    expect(mockNotifyChannel).not.toHaveBeenCalled()
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('a message that merely QUOTES the dialog above a live idle prompt does not trip the alert and still gets the /name', async () => {
    useFrames(IMPORTS_DIALOG.replace(/\s+$/, '') + '\n' + IDLE_PANE)
    expect(await sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).toBe('sent')
    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })

  it('the operator alert is a no-throw fire-and-forget: a failing notifier does not break the gate', async () => {
    mockNotifyChannel.mockRejectedValue(new Error('telegram down'))
    useFrames(IMPORTS_DIALOG)
    await expect(sendIdentityCommandGuarded(SESSION, NAME_CMD, null)).resolves.toBe('skipped-imports-dialog')
  })

  it('alertExternalImportsDialogOnce is idempotent per session', () => {
    alertExternalImportsDialogOnce(SESSION)
    alertExternalImportsDialogOnce(SESSION)
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
  })
})

describe('scheduleIdentitySetup wiring', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('a healthy fresh session still gets its /name inside the original 8s + 5s window (regression)', async () => {
    void scheduleIdentitySetup(SESSION, 'Agent A', null)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(sentKeys()).toEqual([['send-keys', '-t', SESSION, '/name Agent A', 'Enter']])
    expect(mockLoggerInfo).toHaveBeenCalledWith({ session: SESSION, displayName: 'Agent A' }, 'Set session /name')
  })

  it('a skipped /name is not reported as set', async () => {
    useFrames(UNKNOWN_MODAL)
    void scheduleIdentitySetup(SESSION, 'Agent A', null)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(mockRunTmux).not.toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(expect.anything(), 'Set session /name')
  })

  it('the imports dialog through the scheduler: no keys, one alert, not reported as set', async () => {
    useFrames(IMPORTS_DIALOG)
    void scheduleIdentitySetup(SESSION, 'Agent A', null)
    await vi.advanceTimersByTimeAsync(13_000)
    expect(mockRunTmux).not.toHaveBeenCalled()
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(expect.anything(), 'Set session /name')
  })
})

describe('retry-Enter of sendPromptToSession is already pane-gated (inventory pin)', () => {
  it('the imports dialog (no idle footer, no placeholder) never yields a retry-Enter or a resend', () => {
    expect(decideSubmitFollowup(IMPORTS_DIALOG, '[inbox-wakeup: pending inter-agent messages]', 0, 4)).toBe('done')
  })
})

describe('source pins', () => {
  const webDir = join(__dirname, '..', 'web')
  const identitySrc = readFileSync(join(webDir, 'agent-process-identity.ts'), 'utf8')

  it('the only identity send-keys call sits in the gated probe, after the dialog check and the readiness check', () => {
    const calls = identitySrc.match(/\['send-keys', '-t', session, cmd, 'Enter'\]/g) ?? []
    expect(calls).toHaveLength(1)
    const at = identitySrc.indexOf("['send-keys', '-t', session, cmd, 'Enter']")
    const fnStart = identitySrc.indexOf('async function probeAndSendIdentityCommand')
    expect(fnStart).toBeGreaterThan(-1)
    const dialogCheck = identitySrc.indexOf('detectsExternalImportsDialog(pane)', fnStart)
    const readyCheck = identitySrc.indexOf('isSessionReadyForPrompt(session, host)', fnStart)
    const laneTake = identitySrc.indexOf('tryAcquireSessionSendLane(session, host)', fnStart)
    expect(laneTake).toBeGreaterThan(fnStart)
    expect(dialogCheck).toBeGreaterThan(laneTake)
    expect(readyCheck).toBeGreaterThan(dialogCheck)
    expect(at).toBeGreaterThan(readyCheck)
  })

  it('scheduleIdentitySetup does not send keys itself: it goes through the gate', () => {
    const start = identitySrc.indexOf('export function scheduleIdentitySetup')
    const body = identitySrc.slice(start)
    expect(body).not.toMatch(/'send-keys'/)
    expect(body).toContain('sendIdentityCommandGuarded(session, cmd, host)')
  })

  it('no other non-test src/web writer sends an identity slash command blindly', () => {
    for (const f of readdirSync(webDir).filter(n => n.endsWith('.ts'))) {
      const src = readFileSync(join(webDir, f), 'utf8')
      // A /name literal fed straight to send-keys outside the gated helper.
      expect(src, f).not.toMatch(/send-keys[^\n]*'\/name[ '`]/)
    }
  })

  it('the imports-dialog branch never answers: no digit, Escape or Yes key in the gate', () => {
    const start = identitySrc.indexOf('export function alertExternalImportsDialogOnce')
    const end = identitySrc.indexOf('export function scheduleIdentitySetup')
    const gate = identitySrc.slice(start, end)
    expect(gate).not.toMatch(/'Escape'|'C-c'|'1'|'2'|'Down'|'Up'/)
    expect(gate.match(/'send-keys'/g) ?? []).toHaveLength(1)
  })
})

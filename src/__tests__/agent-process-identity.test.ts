// Unit tests for src/web/agent-process-identity.ts: the post-(re)spawn modal
// dismissal helpers, the first-run gate walker, and the identity-setup
// scheduler. All tmux I/O (captureTmux/runTmux/capturePane/delay) and the
// pane-state detectors are mocked so these tests exercise the module's own
// branching (which keystrokes go out, in what order, and the error/give-up
// paths) without a real terminal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { info: (...a: unknown[]) => mockLoggerInfo(...a), warn: (...a: unknown[]) => mockLoggerWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

const mockDetectsFirstRunGate = vi.fn()
const mockDetectsModelConsentDialog = vi.fn()
vi.mock('../pane-state.js', () => ({
  detectPaneState: vi.fn(),
  detectsFirstRunGate: (...a: unknown[]) => mockDetectsFirstRunGate(...(a as [string])),
  detectsModelConsentDialog: (...a: unknown[]) => mockDetectsModelConsentDialog(...(a as [string])),
}))

vi.mock('../web/agent-process-config.js', () => ({
  stampFableOverageConsent: vi.fn(),
}))

const mockCapturePane = vi.fn<(session: string, host: string | null) => string | null>()
const mockCaptureTmux = vi.fn<(host: string | null, args: string[]) => string>()
const mockRunTmux = vi.fn<(host: string | null, args: string[], opts?: unknown) => void>()
const mockDelay = vi.fn<(ms: number) => Promise<void>>()
vi.mock('../web/agent-process-session.js', () => ({
  capturePane: (...a: unknown[]) => mockCapturePane(...(a as [string, string | null])),
  captureTmux: (...a: unknown[]) => mockCaptureTmux(...(a as [string | null, string[]])),
  runTmux: (...a: unknown[]) => mockRunTmux(...(a as [string | null, string[], unknown])),
  delay: (...a: unknown[]) => mockDelay(...(a as [number])),
  isSessionReadyForPrompt: vi.fn(),
  sendPromptToSession: vi.fn(),
}))

vi.mock('../web/agent-process-spawn.js', () => ({
  startAgentProcess: vi.fn(),
}))

import {
  dismissSurveyModalIfPresent,
  dismissResumeSummaryModalIfPresent,
  dismissModelConsentDialogIfPresent,
  answerFirstRunGates,
  identitySlashCommands,
  scheduleIdentitySetup,
} from '../web/agent-process-identity.js'

beforeEach(() => {
  vi.resetAllMocks() // clearAllMocks alone leaves stale mockReturnValue()s from earlier tests in place
  mockDelay.mockResolvedValue(undefined)
})

describe('dismissSurveyModalIfPresent', () => {
  it('does nothing when the survey modal is not on screen', async () => {
    mockCaptureTmux.mockReturnValue('normal prompt, nothing special')
    await dismissSurveyModalIfPresent('sess-1', null)
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('answers "0" and logs when the survey modal is showing', async () => {
    mockCaptureTmux.mockReturnValue('How is Claude doing this session?')
    await dismissSurveyModalIfPresent('sess-1', 'host-a')
    expect(mockRunTmux).toHaveBeenCalledWith('host-a', ['send-keys', '-t', 'sess-1', '0'], expect.anything())
    expect(mockLoggerInfo).toHaveBeenCalledWith({ session: 'sess-1' }, expect.stringContaining('rating modal'))
  })

  it('swallows a tmux capture failure and logs a warning', async () => {
    mockCaptureTmux.mockImplementation(() => { throw new Error('no such session') })
    await expect(dismissSurveyModalIfPresent('sess-1', null)).resolves.toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ session: 'sess-1' }), expect.stringContaining('Failed to probe/dismiss session-rating modal'))
  })
})

describe('dismissResumeSummaryModalIfPresent', () => {
  it('does nothing when the resume-from-summary modal is not showing', async () => {
    mockCaptureTmux.mockReturnValue('nothing here')
    await dismissResumeSummaryModalIfPresent('sess-2', null)
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('picks option 1 and confirms with Enter when the modal is showing', async () => {
    mockCaptureTmux.mockReturnValue('Resume from summary (recommended)')
    await dismissResumeSummaryModalIfPresent('sess-2', null)
    expect(mockRunTmux).toHaveBeenNthCalledWith(1, null, ['send-keys', '-t', 'sess-2', '1'], expect.anything())
    expect(mockRunTmux).toHaveBeenNthCalledWith(2, null, ['send-keys', '-t', 'sess-2', 'Enter'], expect.anything())
  })
})

describe('dismissModelConsentDialogIfPresent', () => {
  it('does nothing when the consent dialog is not detected', async () => {
    mockCaptureTmux.mockReturnValue('some pane text')
    mockDetectsModelConsentDialog.mockReturnValue(false)
    await dismissModelConsentDialogIfPresent('sess-3', null)
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('actively selects option 1 (never the switch-model default) when the dialog is detected', async () => {
    mockCaptureTmux.mockReturnValue('Fable 5 now uses usage credits')
    mockDetectsModelConsentDialog.mockReturnValue(true)
    await dismissModelConsentDialogIfPresent('sess-3', null)
    expect(mockRunTmux).toHaveBeenNthCalledWith(1, null, ['send-keys', '-t', 'sess-3', '1'], expect.anything())
    expect(mockRunTmux).toHaveBeenNthCalledWith(2, null, ['send-keys', '-t', 'sess-3', 'Enter'], expect.anything())
  })
})

describe('identitySlashCommands', () => {
  it('returns a single /name command for the given display name', () => {
    expect(identitySlashCommands('TestAgent')).toEqual(['/name TestAgent'])
  })
})

describe('answerFirstRunGates', () => {
  it('returns "unchanged" when there is no gate at all', async () => {
    mockCapturePane.mockReturnValue('normal ready prompt')
    mockDetectsFirstRunGate.mockReturnValue(null)
    const result = await answerFirstRunGates('sess-4', null)
    expect(result).toBe('unchanged')
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('returns "login" immediately without answering anything', async () => {
    mockCapturePane.mockReturnValue('pick an account to log in')
    mockDetectsFirstRunGate.mockReturnValue('login')
    const result = await answerFirstRunGates('sess-4', null)
    expect(result).toBe('login')
    expect(mockRunTmux).not.toHaveBeenCalled()
  })

  it('answers a trust dialog with 1+Enter then clears once the gate disappears', async () => {
    mockCapturePane
      .mockReturnValueOnce('Do you trust the files in this folder?')
      .mockReturnValueOnce('ready prompt')
    mockDetectsFirstRunGate
      .mockReturnValueOnce('trust')
      .mockReturnValueOnce(null)

    const result = await answerFirstRunGates('sess-4', null)

    expect(result).toBe('cleared')
    expect(mockRunTmux).toHaveBeenNthCalledWith(1, null, ['send-keys', '-t', 'sess-4', '1'], expect.anything())
    expect(mockRunTmux).toHaveBeenNthCalledWith(2, null, ['send-keys', '-t', 'sess-4', 'Enter'], expect.anything())
  })

  it('answers a bypass-permissions dialog with 2+Enter', async () => {
    mockCapturePane
      .mockReturnValueOnce('Yes, I accept -- bypass permissions mode')
      .mockReturnValueOnce('ready prompt')
    mockDetectsFirstRunGate
      .mockReturnValueOnce('bypass-permissions')
      .mockReturnValueOnce(null)

    const result = await answerFirstRunGates('sess-4', null)

    expect(result).toBe('cleared')
    expect(mockRunTmux).toHaveBeenNthCalledWith(1, null, ['send-keys', '-t', 'sess-4', '2'], expect.anything())
    expect(mockRunTmux).toHaveBeenNthCalledWith(2, null, ['send-keys', '-t', 'sess-4', 'Enter'], expect.anything())
  })

  it('answers theme/welcome dialogs with a bare Enter', async () => {
    mockCapturePane
      .mockReturnValueOnce('Choose your theme')
      .mockReturnValueOnce('ready prompt')
    mockDetectsFirstRunGate
      .mockReturnValueOnce('theme')
      .mockReturnValueOnce(null)

    const result = await answerFirstRunGates('sess-4', null)

    expect(result).toBe('cleared')
    expect(mockRunTmux).toHaveBeenCalledTimes(1)
    expect(mockRunTmux).toHaveBeenCalledWith(null, ['send-keys', '-t', 'sess-4', 'Enter'], expect.anything())
  })

  it('gives up on a keystroke failure, returning "cleared" if it had already answered something', async () => {
    mockCapturePane
      .mockReturnValueOnce('Do you trust the files in this folder?')
      .mockReturnValueOnce('Choose your theme')
    mockDetectsFirstRunGate
      .mockReturnValueOnce('trust')
      .mockReturnValueOnce('theme')
    mockRunTmux
      .mockImplementationOnce(() => {}) // trust '1' ok
      .mockImplementationOnce(() => {}) // trust Enter ok
      .mockImplementationOnce(() => { throw new Error('tmux send-keys failed') }) // theme Enter fails

    const result = await answerFirstRunGates('sess-4', null)

    expect(result).toBe('cleared')
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ session: 'sess-4', gate: 'theme' }), expect.stringContaining('answer keystroke failed'))
  })

  it('returns "unchanged" on a keystroke failure before anything was answered', async () => {
    mockCapturePane.mockReturnValue('Choose your theme')
    mockDetectsFirstRunGate.mockReturnValue('theme')
    mockRunTmux.mockImplementationOnce(() => { throw new Error('tmux send-keys failed') })

    const result = await answerFirstRunGates('sess-4', null)

    expect(result).toBe('unchanged')
  })

  it('bails out as "cleared" after the max step bound if the gate never clears', async () => {
    mockCapturePane.mockReturnValue('Choose your theme')
    mockDetectsFirstRunGate.mockReturnValue('theme') // never resolves to null

    const result = await answerFirstRunGates('sess-4', null)

    expect(result).toBe('cleared')
    expect(mockRunTmux).toHaveBeenCalledTimes(6) // FIRST_RUN_ANSWER_MAX_STEPS
  })
})

describe('scheduleIdentitySetup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('dismisses modals first, then sends /name after the identity delay', async () => {
    mockCaptureTmux.mockReturnValue('normal pane, no modal')

    void scheduleIdentitySetup('sess-5', 'TestAgent', null)

    await vi.advanceTimersByTimeAsync(8_000) // MODAL_DISMISS_DELAY_MS
    // The three dismiss helpers each probe the pane once.
    expect(mockCaptureTmux).toHaveBeenCalledTimes(3)
    expect(mockRunTmux).not.toHaveBeenCalled() // nothing to dismiss, no /name sent yet

    await vi.advanceTimersByTimeAsync(5_000) // IDENTITY_SEND_DELAY_MS
    expect(mockRunTmux).toHaveBeenCalledWith(null, ['send-keys', '-t', 'sess-5', '/name TestAgent', 'Enter'], expect.anything())
    expect(mockLoggerInfo).toHaveBeenCalledWith({ session: 'sess-5', displayName: 'TestAgent' }, 'Set session /name')
  })

  it('logs a warning instead of the success message when sending /name fails', async () => {
    mockCaptureTmux.mockReturnValue('normal pane, no modal')
    mockRunTmux.mockImplementation(() => { throw new Error('session gone') })

    void scheduleIdentitySetup('sess-6', 'TestAgent', null)

    await vi.advanceTimersByTimeAsync(13_000) // both delays combined

    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ session: 'sess-6', displayName: 'TestAgent' }), 'Failed to set session /name')
  })
})

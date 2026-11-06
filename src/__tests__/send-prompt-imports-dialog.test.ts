// sendPromptToSession and the external CLAUDE.md imports dialog.
//
// A send that goes out WITHOUT proof of an idle pane (the forceSend opt-out, the best-effort fall-through after the
// idle budget) used to type the prompt and a submitting Enter into whatever was on the pane. On the "Allow external
// CLAUDE.md file imports?" dialog that Enter confirms the highlighted "No". The send now refuses (no keystroke,
// 'aborted-busy', one operator alert per session). Sends that DO have proof of an idle pane are unchanged.
//
// tmux is faked at node:child_process level (the session module and the pane detectors are the real ones), so the
// tests see exactly the argv the module would hand to tmux.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: mockExecFileSync }
})

const mockNotifyChannel = vi.hoisted(() => vi.fn())
vi.mock('../notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notify.js')>()
  return { ...actual, notifyChannel: (...a: unknown[]) => mockNotifyChannel(...a) }
})

import { sendPromptToSession } from '../web/agent-process-session.js'
import { resetImportsDialogAlerts } from '../web/agent-process-identity.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'

const CH = (code: number, n = 1): string => String.fromCharCode(code).repeat(n)
const RULE = CH(0x2500, 80)
const CURSOR = CH(0x276f)
const DOT = CH(0x00b7)

const IMPORTS_DIALOG = [
  RULE,
  '  Allow external CLAUDE.md file imports?',
  '',
  "  This project's CLAUDE.md or .claude/rules imports files outside the current",
  '  working directory. Never allow this for third-party repositories.',
  '',
  '  External imports:',
  '    /private/tmp/sandbox/outside-persona.md',
  '',
  `  ${CURSOR} No, disable external imports`,
  '    Yes, allow external imports',
  '',
  `  Enter to confirm ${DOT} Esc to cancel`,
].join('\n') + '\n'.repeat(8)

const IDLE_PANE = ['', RULE, `${CURSOR} `, RULE, `  ${CH(0x23f5, 2)} bypass permissions on (shift+tab to cycle)`].join('\n')
const BUSY_PANE = [
  `${CH(0x2722)} Combobulating${CH(0x2026)} (52s ${DOT} ${CH(0x2193)} 2.6k tokens ${DOT} thinking some more)`,
  '',
  RULE,
  `${CURSOR} `,
  RULE,
  `  ${CH(0x23f5, 2)} bypass permissions on (shift+tab to cycle) ${DOT} esc to interrupt`,
].join('\n')

const SESSION = 'agent-a'
const PROMPT = '[inbox-wakeup: pending inter-agent messages]'

let pane = IDLE_PANE
const sentKeys = (): string[][] =>
  mockExecFileSync.mock.calls.map(c => c[1] as string[]).filter(args => args.includes('send-keys'))

beforeEach(() => {
  mockExecFileSync.mockReset()
  mockNotifyChannel.mockReset()
  mockNotifyChannel.mockResolvedValue(undefined)
  __resetSessionSendLocks()
  resetImportsDialogAlerts()
  pane = IDLE_PANE
  mockExecFileSync.mockImplementation((_file: string, args: string[]) => (args.includes('capture-pane') ? pane : ''))
})

describe('sendPromptToSession on the external imports dialog', () => {
  it('the forceSend path (no idle wait) sends nothing, returns aborted-busy and alerts once', async () => {
    pane = IMPORTS_DIALOG
    expect(await sendPromptToSession(SESSION, PROMPT, null, { waitForIdle: false })).toBe('aborted-busy')
    expect(sentKeys()).toEqual([]) // in particular no Enter, no digit, no Escape
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
  })

  it('the best-effort fall-through (idle budget spent) sends nothing either', async () => {
    pane = IMPORTS_DIALOG
    expect(await sendPromptToSession(SESSION, PROMPT, null, { idleTimeoutMs: 1 })).toBe('aborted-busy')
    expect(sentKeys()).toEqual([])
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
  })

  it('repeated sends against the same stuck dialog alert once per session, not once per message', async () => {
    pane = IMPORTS_DIALOG
    await sendPromptToSession(SESSION, PROMPT, null, { waitForIdle: false })
    await sendPromptToSession(SESSION, PROMPT, null, { waitForIdle: false })
    await sendPromptToSession(SESSION, PROMPT, null, { idleTimeoutMs: 1 })
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(sentKeys()).toEqual([])
  })

  it('the alert text carries the session name and the dialog title, not the pane', async () => {
    pane = IMPORTS_DIALOG
    await sendPromptToSession(SESSION, PROMPT, null, { waitForIdle: false })
    const text = String(mockNotifyChannel.mock.calls[0][0])
    expect(text).toContain(SESSION)
    expect(text).toContain('Allow external CLAUDE.md file imports?')
    expect(text).not.toContain('outside-persona.md')
  })

  it('the abort policy still aborts before any keystroke (unchanged)', async () => {
    pane = IMPORTS_DIALOG
    expect(await sendPromptToSession(SESSION, PROMPT, null, { onBusyTimeout: 'abort', idleTimeoutMs: 1 })).toBe('aborted-busy')
    expect(sentKeys()).toEqual([])
  })
})

describe('sendPromptToSession is unchanged for panes that are not the dialog', () => {
  it('an idle pane is sent to as before (proof of idle: no extra imports probe needed, text + Enter go out)', async () => {
    pane = IDLE_PANE
    expect(await sendPromptToSession(SESSION, PROMPT, null)).toBe('sent')
    const keys = sentKeys()
    expect(keys.length).toBeGreaterThan(1)
    expect(keys.some(a => a.includes('-l') && a.includes(PROMPT))).toBe(true)
    expect(keys.some(a => a[a.length - 1] === 'Enter')).toBe(true)
    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })

  it('a busy pane past the idle budget still gets the best-effort send (router / scheduler must-deliver contract)', async () => {
    pane = BUSY_PANE
    expect(await sendPromptToSession(SESSION, PROMPT, null, { idleTimeoutMs: 1 })).toBe('sent')
    expect(sentKeys().some(a => a.includes('-l') && a.includes(PROMPT))).toBe(true)
    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })

  it('forceSend on a busy pane still sends', async () => {
    pane = BUSY_PANE
    expect(await sendPromptToSession(SESSION, PROMPT, null, { waitForIdle: false })).toBe('sent')
    expect(sentKeys().some(a => a.includes('-l') && a.includes(PROMPT))).toBe(true)
    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })
})

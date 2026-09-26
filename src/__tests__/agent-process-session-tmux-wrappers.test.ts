/**
 * Coverage for the thin tmux-driving wrappers in
 * src/web/agent-process-session.ts that had no direct test coverage:
 * sessionExistsOnHost, getAgentRunningSince, sendEnterToSession,
 * waitForPaneIdle, isSessionReadyForPrompt, clearInputBuffer.
 *
 * All of them bottom out in execFileSync (via runTmux/captureTmux); mocking
 * node:child_process's execFileSync lets us drive their branching without a
 * real tmux server, mirroring the mock pattern in
 * agent-terminal-routes.test.ts. tmux itself resolves for real via
 * makeLazyBinResolver (tmux is present on the dev/CI machine, same as every
 * other test in this suite that imports this module) -- only the actual
 * process exec is intercepted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type ExecHandler = (file: string, args: string[]) => string

const mockExecFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: mockExecFileSync }
})

import {
  sessionExistsOnHost,
  getAgentRunningSince,
  sendEnterToSession,
  waitForPaneIdle,
  isSessionReadyForPrompt,
  clearInputBuffer,
} from '../web/agent-process-session.js'

const SEP = '─'.repeat(80)
const IDLE_PANE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

function setExecHandler(handler: ExecHandler) {
  mockExecFileSync.mockImplementation((file: string, args: string[]) => handler(file, args))
}

beforeEach(() => {
  mockExecFileSync.mockReset()
})

describe('sessionExistsOnHost', () => {
  it('true when the session appears in list-sessions output', () => {
    setExecHandler(() => 'agent-samu\nagent-boni\n')
    expect(sessionExistsOnHost(null, 'agent-boni')).toBe(true)
  })

  it('false when the session is absent from the list', () => {
    setExecHandler(() => 'agent-samu\n')
    expect(sessionExistsOnHost(null, 'agent-boni')).toBe(false)
  })

  it('false when the tmux query throws (no server running)', () => {
    setExecHandler(() => { throw new Error('no server running on /tmp/tmux-501/default') })
    expect(sessionExistsOnHost(null, 'agent-boni')).toBe(false)
  })
})

describe('getAgentRunningSince', () => {
  it('returns the parsed unix timestamp from display-message', () => {
    setExecHandler(() => '1790300000\n')
    expect(getAgentRunningSince('boni')).toBe(1790300000)
  })

  it('returns null when the output is not a finite number', () => {
    setExecHandler(() => "session not found: agent-boni\n")
    expect(getAgentRunningSince('boni')).toBeNull()
  })

  it('returns null when the tmux query throws', () => {
    setExecHandler(() => { throw new Error('no server running') })
    expect(getAgentRunningSince('boni')).toBeNull()
  })
})

describe('sendEnterToSession', () => {
  it('returns true when the send-keys call succeeds', () => {
    setExecHandler(() => '')
    expect(sendEnterToSession('agent-boni')).toBe(true)
  })

  it('returns false when the send-keys call throws', () => {
    setExecHandler(() => { throw new Error("can't find session: agent-boni") })
    expect(sendEnterToSession('agent-boni')).toBe(false)
  })
})

describe('waitForPaneIdle', () => {
  it('resolves true immediately when the pane is already idle', async () => {
    setExecHandler(() => IDLE_PANE)
    await expect(waitForPaneIdle('agent-boni', null, 1000)).resolves.toBe(true)
  })

  it('resolves false once the timeout budget elapses on a persistently busy pane', async () => {
    setExecHandler(() => BUSY_PANE)
    await expect(waitForPaneIdle('agent-boni', null, 50)).resolves.toBe(false)
  })
})

describe('isSessionReadyForPrompt', () => {
  it('true when both samples read idle', async () => {
    setExecHandler(() => IDLE_PANE)
    await expect(isSessionReadyForPrompt('agent-boni')).resolves.toBe(true)
  })

  it('false when the pane is busy (esc to interrupt visible)', async () => {
    setExecHandler(() => BUSY_PANE)
    await expect(isSessionReadyForPrompt('agent-boni')).resolves.toBe(false)
  })

  it('false when the first capture fails', async () => {
    setExecHandler(() => { throw new Error("can't find session: agent-boni") })
    await expect(isSessionReadyForPrompt('agent-boni')).resolves.toBe(false)
  })

  it('false when the pane shows context saturation', async () => {
    const SATURATED = ['', SEP, '❯ ', SEP, '  Context left until auto-compact: 0%'].join('\n')
    setExecHandler(() => SATURATED)
    await expect(isSessionReadyForPrompt('agent-boni')).resolves.toBe(false)
  })
})

describe('clearInputBuffer', () => {
  it('sends a clearing key sequence and resolves without throwing', async () => {
    setExecHandler((file, args) => (args.includes('capture-pane') ? IDLE_PANE : ''))
    await expect(clearInputBuffer('agent-boni')).resolves.toBeUndefined()
    const sendKeysCalls = mockExecFileSync.mock.calls.filter(([, args]) => (args as string[]).includes('send-keys'))
    expect(sendKeysCalls.length).toBeGreaterThan(0)
  })

  it('swallows a send-keys failure and resolves without throwing', async () => {
    setExecHandler((file, args) => {
      if (args.includes('capture-pane')) return IDLE_PANE
      throw new Error("can't find session: agent-boni")
    })
    await expect(clearInputBuffer('agent-boni')).resolves.toBeUndefined()
  })
})

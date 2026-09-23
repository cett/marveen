// Tests for the I/O wrapper in telegram-inbox-wake.ts (maybeWakeSubAgentsForTelegram).
//
// The pure gate decision (shouldWakeForTelegramInbox) and the backoff formula
// (wakeBackoffMs) are already covered exhaustively in telegram-inbox-wake.test.ts
// with no filesystem or tmux. This file covers the async I/O orchestration around
// them: the opt-in flag early-out, listAgentNames failure handling, the main-agent
// skip, the per-agent statSync-driven state machine (missing/empty/fresh/stuck
// inbox), the cheap-gates-before-tmux-I/O ordering (debounce and attempt-budget
// gates must short-circuit BEFORE sessionExistsOnHost/isSessionReadyForPrompt are
// even called), the full wake path, and per-agent error isolation.
//
// node:fs, ../logger.js, ../config.js, ./voice-directive.js, ./agent-config.js and
// ./agent-process.js are all mocked. SUBAGENT_TELEGRAM_WAKE_ENABLED is a plain
// const export read at call time by the SUT, so the mock exposes it via a getter
// backed by a hoisted mutable ref -- flipping the ref before a call changes what
// the SUT sees without needing vi.resetModules()/re-import per test.
//
// The module under test keeps its wake state in a module-scoped Map
// (_subWakeState), and exports _resetSubWakeStateForTest() precisely so tests
// don't need vi.resetModules() gymnastics -- one static import, reset the state
// map in beforeEach.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  mockStatSync,
  mockLoggerWarn,
  mockLoggerInfo,
  mockListAgentNames,
  mockReadAgentRemoteHost,
  mockResolveAgentChannelStateDir,
  mockAgentSessionName,
  mockSessionExistsOnHost,
  mockIsSessionReadyForPrompt,
  mockSendPromptToSession,
  wakeEnabledRef,
} = vi.hoisted(() => ({
  mockStatSync: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockListAgentNames: vi.fn(),
  mockReadAgentRemoteHost: vi.fn(),
  mockResolveAgentChannelStateDir: vi.fn(),
  mockAgentSessionName: vi.fn(),
  mockSessionExistsOnHost: vi.fn(),
  mockIsSessionReadyForPrompt: vi.fn(),
  mockSendPromptToSession: vi.fn(),
  wakeEnabledRef: { value: true },
}))

vi.mock('node:fs', () => ({
  statSync: mockStatSync,
}))

vi.mock('../logger.js', () => ({
  logger: { warn: mockLoggerWarn, info: mockLoggerInfo },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'main-test-agent',
  get SUBAGENT_TELEGRAM_WAKE_ENABLED() {
    return wakeEnabledRef.value
  },
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: mockResolveAgentChannelStateDir,
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: mockListAgentNames,
  readAgentRemoteHost: mockReadAgentRemoteHost,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: mockAgentSessionName,
  sessionExistsOnHost: mockSessionExistsOnHost,
  isSessionReadyForPrompt: mockIsSessionReadyForPrompt,
  sendPromptToSession: mockSendPromptToSession,
}))

import { maybeWakeSubAgentsForTelegram, _resetSubWakeStateForTest, wakeBackoffMs } from '../web/telegram-inbox-wake.js'

const MIN_AGE_MS = 25_000
const DEBOUNCE_MS = 60_000
const MAX_DEBOUNCE_MS = 30 * 60_000
const MAX_ATTEMPTS = 5

// name -> stub inbox file ({size, mtimeMs}) or undefined (statSync throws ENOENT)
const inboxByAgent = new Map<string, { size: number; mtimeMs: number }>()
// name -> tmux session state
const sessionExistsByAgent = new Map<string, boolean>()
const sessionIdleByAgent = new Map<string, boolean>()
const hostByAgent = new Map<string, string | null>()

function statePath(name: string): string {
  return `/state/${name}/inbox-pending.jsonl`
}

function agentFromSessionName(session: string): string {
  return session.replace(/^session-/, '')
}

function setInbox(name: string, opts: { size: number; mtimeMs: number }): void {
  inboxByAgent.set(name, opts)
}

function clearInbox(name: string): void {
  inboxByAgent.delete(name)
}

function armSession(name: string, opts: { exists?: boolean; idle?: boolean; host?: string | null } = {}): void {
  sessionExistsByAgent.set(name, opts.exists ?? true)
  sessionIdleByAgent.set(name, opts.idle ?? true)
  hostByAgent.set(name, opts.host ?? null)
}

beforeEach(() => {
  vi.clearAllMocks()
  inboxByAgent.clear()
  sessionExistsByAgent.clear()
  sessionIdleByAgent.clear()
  hostByAgent.clear()
  wakeEnabledRef.value = true
  _resetSubWakeStateForTest()

  mockListAgentNames.mockImplementation(() => [])
  mockResolveAgentChannelStateDir.mockImplementation((name: string) => `/state/${name}`)
  mockStatSync.mockImplementation((p: string) => {
    const name = p.replace('/state/', '').replace('/inbox-pending.jsonl', '')
    const rec = inboxByAgent.get(name)
    if (!rec) {
      const err = new Error('ENOENT (test fixture: no inbox file)') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return rec
  })
  mockAgentSessionName.mockImplementation((name: string) => `session-${name}`)
  mockReadAgentRemoteHost.mockImplementation((name: string) => hostByAgent.get(name) ?? null)
  mockSessionExistsOnHost.mockImplementation((_host: string | null, session: string) => sessionExistsByAgent.get(agentFromSessionName(session)) ?? false)
  mockIsSessionReadyForPrompt.mockImplementation(async (session: string) => sessionIdleByAgent.get(agentFromSessionName(session)) ?? false)
  mockSendPromptToSession.mockResolvedValue(undefined)
})

describe('maybeWakeSubAgentsForTelegram: opt-in gate and listAgentNames failure', () => {
  it('is a no-op (no fs/tmux I/O) when SUBAGENT_TELEGRAM_WAKE_ENABLED is off', async () => {
    wakeEnabledRef.value = false
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    setInbox('agent-a', { size: 10, mtimeMs: 1_000 })

    await maybeWakeSubAgentsForTelegram(2_000_000)

    expect(mockListAgentNames).not.toHaveBeenCalled()
    expect(mockStatSync).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('logs and returns without crashing when listAgentNames throws', async () => {
    mockListAgentNames.mockImplementation(() => {
      throw new Error('agent registry unreadable')
    })

    await expect(maybeWakeSubAgentsForTelegram(1_000_000)).resolves.toBeUndefined()

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
    expect(mockStatSync).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })
})

describe('maybeWakeSubAgentsForTelegram: main-agent skip and inbox state machine', () => {
  it('skips the main agent entirely (no statSync for it)', async () => {
    mockListAgentNames.mockImplementation(() => ['main-test-agent'])

    await maybeWakeSubAgentsForTelegram(1_000_000)

    expect(mockStatSync).not.toHaveBeenCalled()
    expect(mockResolveAgentChannelStateDir).not.toHaveBeenCalled()
  })

  it('drops stale state and sends no wake when the inbox file is missing', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    clearInbox('agent-a')
    armSession('agent-a')

    await maybeWakeSubAgentsForTelegram(1_000_000)

    expect(mockSessionExistsOnHost).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('drops stale state and sends no wake when the inbox is empty (drained)', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    setInbox('agent-a', { size: 0, mtimeMs: 1_000 })
    armSession('agent-a')

    await maybeWakeSubAgentsForTelegram(1_000_000)

    expect(mockSessionExistsOnHost).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('does not probe the session for a too-fresh inbox (cheap gate before tmux I/O)', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    const now = 1_000_000
    setInbox('agent-a', { size: 10, mtimeMs: now - MIN_AGE_MS }) // exactly at threshold: not old enough
    armSession('agent-a')

    await maybeWakeSubAgentsForTelegram(now)

    expect(mockSessionExistsOnHost).not.toHaveBeenCalled()
    expect(mockIsSessionReadyForPrompt).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })
})

describe('maybeWakeSubAgentsForTelegram: full wake path', () => {
  it('sends the wake nudge and updates state when every gate passes', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    const now = 1_000_000
    setInbox('agent-a', { size: 10, mtimeMs: now - MIN_AGE_MS - 1 })
    armSession('agent-a', { exists: true, idle: true, host: 'remote-host-1' })

    await maybeWakeSubAgentsForTelegram(now)

    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    const [session, text, host] = mockSendPromptToSession.mock.calls[0]
    expect(session).toBe('session-agent-a')
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
    expect(host).toBe('remote-host-1')
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1)

    // A second call at the same instant, same backlog, is blocked by the
    // debounce window that state update just armed.
    mockSendPromptToSession.mockClear()
    await maybeWakeSubAgentsForTelegram(now)
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('does not probe isSessionReadyForPrompt when the session does not exist (short-circuit)', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    const now = 1_000_000
    setInbox('agent-a', { size: 10, mtimeMs: now - MIN_AGE_MS - 1 })
    armSession('agent-a', { exists: false })

    await maybeWakeSubAgentsForTelegram(now)

    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(1)
    expect(mockIsSessionReadyForPrompt).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('does not wake when the session exists but is busy/mid-turn', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    const now = 1_000_000
    setInbox('agent-a', { size: 10, mtimeMs: now - MIN_AGE_MS - 1 })
    armSession('agent-a', { exists: true, idle: false })

    await maybeWakeSubAgentsForTelegram(now)

    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })
})

describe('maybeWakeSubAgentsForTelegram: debounce/budget gates run before tmux I/O', () => {
  it('does not call sessionExistsOnHost while the debounce window has not elapsed', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    const mtimeMs = 0
    setInbox('agent-a', { size: 10, mtimeMs })
    armSession('agent-a')

    // First call: the state starts with lastWakeAt=0, so the very first possible
    // wake is gated by the debounce base (DEBOUNCE_MS), not just minAge (which is
    // smaller) -- now1 must clear both.
    const now1 = DEBOUNCE_MS + 1
    await maybeWakeSubAgentsForTelegram(now1)
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    mockSendPromptToSession.mockClear()
    mockSessionExistsOnHost.mockClear()

    // Second call soon after (same mtime => same backlog => attempts=1, debounce
    // gap = wakeBackoffMs(1, DEBOUNCE_MS, MAX_DEBOUNCE_MS) = 120_000): well inside
    // the window, so the debounce gate must reject before any tmux I/O happens.
    const now2 = now1 + 5_000
    await maybeWakeSubAgentsForTelegram(now2)

    expect(mockSessionExistsOnHost).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('stops probing once the per-agent attempt budget is exhausted, until a new backlog (mtime change) resets it', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a'])
    armSession('agent-a')
    const mtimeMs = 0
    setInbox('agent-a', { size: 10, mtimeMs })

    // Drive the attempt counter from 0 up to MAX_ATTEMPTS by calling once per
    // required backoff gap, each call landing exactly on (or past) the boundary
    // computed by the real (unmocked) wakeBackoffMs. The state starts with
    // lastWakeAt=0, so the first gap (DEBOUNCE_MS) also gates the very first wake.
    let now = 0
    let lastWakeAt = 0
    for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
      const gap = wakeBackoffMs(attempts, DEBOUNCE_MS, MAX_DEBOUNCE_MS)
      now = lastWakeAt + gap
      mockSendPromptToSession.mockClear()
      await maybeWakeSubAgentsForTelegram(now)
      expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
      lastWakeAt = now
    }

    // Budget now exhausted (attempts === MAX_ATTEMPTS). Even far in the future,
    // with the SAME backlog (mtime unchanged), no probe and no wake.
    mockSendPromptToSession.mockClear()
    mockSessionExistsOnHost.mockClear()
    const farFuture = lastWakeAt + MAX_DEBOUNCE_MS * 10
    await maybeWakeSubAgentsForTelegram(farFuture)
    expect(mockSessionExistsOnHost).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()

    // A NEW inbound (mtime advances) is a distinct backlog: the attempt budget
    // resets to 0, BUT lastWakeAt carries over from the exhausted backlog (the
    // source only resets attempts/inboxMtimeMs on a mtime change, not lastWakeAt),
    // so the reset (attempts=0) debounce gap is measured from that carried-over
    // lastWakeAt, not from "now". Pick resumeNow that clears both that debounce
    // and the inbox min-age gate against the new mtime.
    const newMtimeMs = mtimeMs + 500_000
    setInbox('agent-a', { size: 20, mtimeMs: newMtimeMs })
    const resumeNow = Math.max(newMtimeMs + MIN_AGE_MS + 1, lastWakeAt + DEBOUNCE_MS + 1)
    await maybeWakeSubAgentsForTelegram(resumeNow)
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
  })
})

describe('maybeWakeSubAgentsForTelegram: per-agent error isolation', () => {
  it('logs and continues to the next agent when one agent throws mid-loop', async () => {
    mockListAgentNames.mockImplementation(() => ['agent-a', 'agent-b'])
    const now = 1_000_000
    mockResolveAgentChannelStateDir.mockImplementation((name: string) => {
      if (name === 'agent-a') throw new Error('state dir resolution blew up')
      return `/state/${name}`
    })
    setInbox('agent-b', { size: 10, mtimeMs: now - MIN_AGE_MS - 1 })
    armSession('agent-b', { exists: true, idle: true })

    await maybeWakeSubAgentsForTelegram(now)

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToSession.mock.calls[0][0]).toBe('session-agent-b')
  })
})

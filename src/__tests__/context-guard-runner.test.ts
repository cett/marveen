// Test suite for context-guard-runner (coverage series, context-guard-runner
// layer 1). Scope: the 5 prompt-builder exports (pure string templates) and
// guardSweepAgentNames (dedup + main-first). The I/O orchestration
// (checkAgent/performRestart/startContextGuardRunner) is layer 2 and is
// deliberately NOT covered here.
//
// Every non-pure transitive dependency of context-guard-runner.ts is mocked
// so importing the module never touches a real DB, tmux session, or the
// filesystem -- mirroring the model-fallback-runner.test.ts pattern for the
// sibling runner this module was modeled on.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: vi.fn(() => null),
  MARVEEN_POST_RESPAWN_GRACE_MS: 60_000,
}))

vi.mock('../web/stuck-tool-call-watcher.js', () => ({
  shouldDeferForRecentRespawn: vi.fn(() => false),
}))

const mockListAllAgentNames = vi.hoisted(() => vi.fn(() => [] as string[]))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn(() => []),
  listAllAgentNames: mockListAllAgentNames,
  agentDir: vi.fn((name: string) => `/agents/${name}`),
  readAgentModel: vi.fn(() => 'claude-opus-5'),
  readAgentClaudeConfigDir: vi.fn(() => null),
  readAgentRemoteHost: vi.fn(() => null),
}))

vi.mock('../web/agent-process.js', () => ({
  agentRunState: vi.fn(() => 'running'),
  agentSessionName: vi.fn((name: string) => `session-${name}`),
  restartAgentProcess: vi.fn(),
  capturePane: vi.fn(() => null),
  sendPromptToSession: vi.fn(),
  isSessionReadyForPrompt: vi.fn(async () => false),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'main-channels-session',
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: vi.fn(() => 'unknown'),
  paneShowsContextSaturation: vi.fn(() => false),
}))

vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: vi.fn(() => null),
  readActiveModelFromProjectDir: vi.fn(() => null),
  readTranscriptMtimeFromProjectDir: vi.fn(() => null),
}))

vi.mock('../web/context-guard-store.js', () => ({
  readContextGuardConfig: vi.fn(() => ({})),
}))

vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(),
}))

vi.mock('../workspace-store.js', () => ({
  getWorkspaceDocUpdatedAtMs: vi.fn(() => null),
}))

vi.mock('../web/claude-plan-handoff-marker.js', () => ({
  appendActivePlanMarkerToHandoff: vi.fn(),
}))

// ../auto-restart.js and ../context-guard.js are pure/dependency-free, and
// ../config.js only reads env constants -- all three used for real.

import { MAIN_AGENT_ID } from '../config.js'
import {
  handoffPrompt,
  idleFlushHandoffPrompt,
  staleRefreshHandoffPrompt,
  dailyHandoffPrompt,
  resumePrompt,
  guardSweepAgentNames,
} from '../web/context-guard-runner.js'

describe('handoffPrompt', () => {
  it('includes the rounded percentage and the handoff path', () => {
    const prompt = handoffPrompt(92, '/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('~92%')
    expect(prompt).toContain('/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('HANDOFF.md')
  })

  it('always reads as critical, unlike the idle/daily/stale variants', () => {
    const prompt = handoffPrompt(90, '/x/HANDOFF.md')
    expect(prompt).toContain('kritikus')
    expect(prompt).toContain('NE folytasd')
  })
})

describe('idleFlushHandoffPrompt', () => {
  it('reports tokens rounded to the nearest thousand and the idle minutes', () => {
    const prompt = idleFlushHandoffPrompt(45_600, 30, '/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('~46k token')
    expect(prompt).toContain('30 perce')
    expect(prompt).toContain('/agents/agent-a/HANDOFF.md')
  })

  it('reads as routine maintenance, not an emergency', () => {
    const prompt = idleFlushHandoffPrompt(1000, 20, '/x/HANDOFF.md')
    expect(prompt).toContain('Rutin karbantart')
    expect(prompt).toContain('nem vészhelyzet')
    expect(prompt).not.toContain('kritikus')
  })

  it('rounds a token count under 500 down to 0k', () => {
    const prompt = idleFlushHandoffPrompt(400, 20, '/x/HANDOFF.md')
    expect(prompt).toContain('~0k token')
  })
})

describe('staleRefreshHandoffPrompt', () => {
  it('asks for a refresh, not a first write, and reports the staleness', () => {
    const prompt = staleRefreshHandoffPrompt(17, '/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('~17 perc')
    expect(prompt).toContain('/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('frissítsd')
    expect(prompt).not.toContain('írj HANDOFF')
  })
})

describe('dailyHandoffPrompt', () => {
  it('includes the configured daily time and the handoff path', () => {
    const prompt = dailyHandoffPrompt('04:30', '/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('04:30')
    expect(prompt).toContain('/agents/agent-a/HANDOFF.md')
    expect(prompt).toContain('Napi rutin')
    expect(prompt).toContain('Nincs vészhelyzet')
  })
})

describe('resumePrompt', () => {
  const NAME = 'agent-a'
  const PATH = '/agents/agent-a/HANDOFF.md'

  it('routes to live sources when no handoff was written in time', () => {
    const prompt = resumePrompt(NAME, PATH, false)
    expect(prompt).toContain('nem készült el időben')
    expect(prompt).not.toContain(PATH)
  })

  it('flags freshness as unmeasurable when staleMinutes is "unknown"', () => {
    const prompt = resumePrompt(NAME, PATH, true, 'unknown')
    expect(prompt).toContain(PATH)
    expect(prompt).toContain('NEM TUDTAM MEGMÉRNI')
  })

  it('states the uncovered gap when staleMinutes is a number', () => {
    const prompt = resumePrompt(NAME, PATH, true, 23)
    expect(prompt).toContain('~23 perc')
    expect(prompt).toContain('ELAVULT')
  })

  it('treats the handoff as current when staleMinutes is null', () => {
    const prompt = resumePrompt(NAME, PATH, true, null)
    expect(prompt).toContain(PATH)
    expect(prompt).not.toContain('ELAVULT')
    expect(prompt).not.toContain('NEM TUDTAM MEGMÉRNI')
  })

  it('always points at the agent\'s own in_progress kanban cards', () => {
    const prompt = resumePrompt(NAME, PATH, true, null)
    expect(prompt).toContain(`assignee=${NAME}`)
  })
})

describe('guardSweepAgentNames', () => {
  beforeEach(() => {
    mockListAllAgentNames.mockReset()
  })

  it('lists the main agent first, followed by every other agent directory', () => {
    mockListAllAgentNames.mockReturnValue(['agent-a', 'agent-b'])
    expect(guardSweepAgentNames()).toEqual([MAIN_AGENT_ID, 'agent-a', 'agent-b'])
  })

  it('deduplicates when the main agent also has its own agent directory', () => {
    mockListAllAgentNames.mockReturnValue([MAIN_AGENT_ID, 'agent-a'])
    const names = guardSweepAgentNames()
    expect(names).toEqual([MAIN_AGENT_ID, 'agent-a'])
    expect(names.filter((n) => n === MAIN_AGENT_ID)).toHaveLength(1)
  })

  it('returns just the main agent when there are no other agent directories', () => {
    mockListAllAgentNames.mockReturnValue([])
    expect(guardSweepAgentNames()).toEqual([MAIN_AGENT_ID])
  })
})

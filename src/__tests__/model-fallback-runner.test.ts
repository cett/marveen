import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// All external dependencies of model-fallback-runner.ts are mocked so the
// test drives checkAgent() in isolation via startModelFallbackRunner().

vi.mock('../web/agent-process.js', () => ({
  capturePane: vi.fn(),
  agentRunState: vi.fn(() => 'running'),
  agentSessionName: vi.fn((name: string) => `${name}-session`),
  restartAgentProcess: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn(() => []),
  readAgentRemoteHost: vi.fn(() => null),
  readAgentModel: vi.fn(() => 'claude-opus-5'),
  writeAgentModel: vi.fn(),
  resolveModelId: vi.fn((m: string) => m),
  DEFAULT_MODEL: 'claude-opus-5',
  // Empty by default (no .env / no settings.json main model configured) --
  // readMainModel() then falls back to DEFAULT_MODEL, same as the old
  // settings.json-read-fails path this replaces.
  readMainModelRaw: vi.fn(() => ''),
}))

// fix/main-model-single-source: writeMainModel() now writes ONLY .env, via
// this module's updateEnvFile() -- no more direct settings.json I/O here.
vi.mock('../env.js', () => ({
  updateEnvFile: vi.fn(),
  readEnvFile: vi.fn(() => ({})),
}))

vi.mock('../web/model-fallback-store.js', () => ({
  readModelFallbackConfig: vi.fn(() => ({
    enabled: true,
    revertAfterMinutes: 60,
    chain: ['claude-opus-5', 'claude-sonnet-5'],
  })),
}))

vi.mock('../model-fallback.js', () => ({
  detectsUsageLimit: vi.fn(() => false),
  detectsModelUnavailable: vi.fn(() => false),
  decideModelAction: vi.fn(() => ({ kind: 'none' })),
}))

vi.mock('../pane-state.js', () => ({
  paneLooksIdle: vi.fn(() => true),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'main-channels',
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

// MAIN_AGENT_ID matches the mocked value so that checkAgent() identifies the
// main session correctly without reading the real environment.
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'agent-a',
  PROJECT_ROOT: '/nonexistent-test-root',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../model-id.js', () => ({
  isValidModelId: vi.fn(() => true),
  InvalidModelIdError: class extends Error {},
}))

import { capturePane } from '../web/agent-process.js'
import { detectsModelUnavailable } from '../model-fallback.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { updateEnvFile } from '../env.js'
import { isValidModelId } from '../model-id.js'
import { startModelFallbackRunner, modelUnavailableStreakFor, writeMainModel } from '../web/model-fallback-runner.js'

// MAIN_AGENT_ID as defined in the config mock above.
const AGENT = 'agent-a'

// Sweep timing constants mirrored from model-fallback-runner.ts (private):
//   INITIAL_DELAY_MS = 50_000   first sweep via setTimeout
//   INTERVAL_MS      = 60_000   subsequent sweeps via setInterval
const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000

describe('modelUnavailableStreak: null pane resets streak between detections', () => {
  let handle: NodeJS.Timeout

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clearInterval(handle)
    vi.useRealTimers()
  })

  // Regression guard for the bug where a null pane froze the streak counter
  // instead of resetting it. The requirement is two *consecutive* captures
  // detecting model-unavailable before a fallback switch is triggered.
  //
  // Scenario:
  //   Sweep 1: detects model-unavailable  -> streak = 1
  //   Sweep 2: pane unreadable (null)     -> streak reset to 0  [the fix]
  //   Sweep 3: detects model-unavailable  -> streak = 1 (not 2)
  //
  // Old behaviour (before the fix): the null pane returned early without
  // resetting, leaving streak=1 frozen. Sweep 3 then reached streak=2 and
  // would have triggered a switch. That is the mutation that this test MUST
  // catch: revert `modelUnavailableStreak.delete(name)` and the assertion
  // `expect(modelUnavailableStreakFor(AGENT)).toBe(1)` fails because streak
  // ends at 2 instead.
  it('streak stays at 1 after detect → null pane → detect (no switch triggered)', () => {
    // Sweep 1: valid pane, model-unavailable detected.
    vi.mocked(capturePane).mockReturnValueOnce('> There\'s an issue with the selected model')
    vi.mocked(detectsModelUnavailable).mockReturnValueOnce(true)

    handle = startModelFallbackRunner()
    vi.advanceTimersByTime(INITIAL_DELAY_MS + 1)  // fires first sweep

    expect(modelUnavailableStreakFor(AGENT)).toBe(1)

    // Sweep 2: pane unreadable — streak must be reset.
    vi.mocked(capturePane).mockReturnValueOnce(null)

    vi.advanceTimersByTime(INTERVAL_MS)  // fires second sweep

    expect(modelUnavailableStreakFor(AGENT)).toBe(0)

    // Sweep 3: model-unavailable detected again — streak must restart at 1,
    // never reaching the threshold of 2 needed to trigger a switch.
    vi.mocked(capturePane).mockReturnValueOnce('> There\'s an issue with the selected model')
    vi.mocked(detectsModelUnavailable).mockReturnValueOnce(true)

    vi.advanceTimersByTime(INTERVAL_MS)  // fires third sweep

    expect(modelUnavailableStreakFor(AGENT)).toBe(1)

    // Streak reached 1, never 2 — no model file was written.
    expect(vi.mocked(atomicWriteFileSync)).not.toHaveBeenCalled()
  })
})

// fix/main-model-single-source: writeMainModel() now writes ONLY .env
// (MAIN_AGENT_MODEL), never .claude/settings.json -- that file is tracked
// (part of the repo), and the old dual-write is what caused the bug this fix
// closes: a plain .env edit (no settings.json write) left readMainModel()/
// readConfiguredMainModel() -- both settings.json-only readers at the time --
// pointed at the stale value. Both readers now resolve through
// readMainModelRaw() (agent-config.ts), which already prefers .env, so a
// single .env write here is sufficient and correct.
describe('writeMainModel', () => {
  beforeEach(() => {
    vi.mocked(updateEnvFile).mockClear()
    vi.mocked(atomicWriteFileSync).mockClear()
    vi.mocked(isValidModelId).mockReturnValue(true)
  })

  it('writes MAIN_AGENT_MODEL to .env via updateEnvFile', () => {
    writeMainModel('claude-sonnet-5')
    expect(vi.mocked(updateEnvFile)).toHaveBeenCalledWith({ MAIN_AGENT_MODEL: 'claude-sonnet-5' })
  })

  it('never touches .claude/settings.json', () => {
    writeMainModel('claude-sonnet-5')
    expect(vi.mocked(atomicWriteFileSync)).not.toHaveBeenCalled()
  })

  it('throws InvalidModelIdError and never writes for an invalid model id', () => {
    vi.mocked(isValidModelId).mockReturnValue(false)
    expect(() => writeMainModel('not-a-real-model')).toThrow()
    expect(vi.mocked(updateEnvFile)).not.toHaveBeenCalled()
  })
})

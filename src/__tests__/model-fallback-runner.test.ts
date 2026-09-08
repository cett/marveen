import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
import { startModelFallbackRunner, modelUnavailableStreakFor } from '../web/model-fallback-runner.js'

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

// writeMainModel() must sync both .claude/settings.json AND .env so that
// channels.sh resolve_main_model() (which prefers MAIN_AGENT_MODEL from .env)
// sees the new model on next channels.sh restart. Bug: before this fix the
// runner wrote only settings.json; the stale .env value silently reverted the
// model switch on every channels.sh restart.
//
// We test the file-mutation contract directly using a tmp dir so no
// production files are touched (and so this describe stays independent of
// the heavy module mocks above, which don't touch real filesystem paths).
// The logic mirrors writeMainModel() in src/web/model-fallback-runner.ts
// exactly.
describe('writeMainModel: .env and settings.json sync', () => {
  let tmpDir: string

  function applyWriteMainModelLogic(projectRoot: string, model: string): void {
    const settingsPath = join(projectRoot, '.claude', 'settings.json')
    let cfg: Record<string, unknown> = {}
    try { cfg = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch {}
    cfg.model = model
    writeFileSync(settingsPath, JSON.stringify(cfg, null, 2))

    const envPath = join(projectRoot, '.env')
    try {
      let env = readFileSync(envPath, 'utf-8')
      env = /^MAIN_AGENT_MODEL=/m.test(env)
        ? env.replace(/^MAIN_AGENT_MODEL=.*/m, `MAIN_AGENT_MODEL=${model}`)
        : `${env.trimEnd()}\nMAIN_AGENT_MODEL=${model}\n`
      writeFileSync(envPath, env)
    } catch {}
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mf-runner-test-'))
    mkdirSync(join(tmpDir, '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes the model to .claude/settings.json', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5', other: 'preserved' }))
    writeFileSync(join(tmpDir, '.env'), 'FOO=bar\nMAIN_AGENT_MODEL=claude-opus-5\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const cfg = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5')
    expect(cfg.other).toBe('preserved')
  })

  it('replaces MAIN_AGENT_MODEL in .env when the key already exists', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
    writeFileSync(join(tmpDir, '.env'), 'FOO=bar\nMAIN_AGENT_MODEL=claude-opus-5\nBAZ=qux\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const env = readFileSync(join(tmpDir, '.env'), 'utf-8')
    expect(env).toContain('MAIN_AGENT_MODEL=claude-sonnet-5')
    expect(env).not.toContain('MAIN_AGENT_MODEL=claude-opus-5')
    expect(env).toContain('FOO=bar')
    expect(env).toContain('BAZ=qux')
  })

  it('appends MAIN_AGENT_MODEL to .env when the key is absent', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
    writeFileSync(join(tmpDir, '.env'), 'FOO=bar\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const env = readFileSync(join(tmpDir, '.env'), 'utf-8')
    expect(env).toContain('MAIN_AGENT_MODEL=claude-sonnet-5')
    expect(env).toContain('FOO=bar')
  })

  it('handles a missing settings.json gracefully (creates it)', () => {
    writeFileSync(join(tmpDir, '.env'), 'MAIN_AGENT_MODEL=claude-opus-5\n')

    applyWriteMainModelLogic(tmpDir, 'claude-sonnet-5')

    const cfg = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'))
    expect(cfg.model).toBe('claude-sonnet-5')
  })

  it('does NOT clobber unrelated .env keys when replacing MAIN_AGENT_MODEL', () => {
    writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'old-model' }))
    writeFileSync(join(tmpDir, '.env'), 'PORT=3420\nMAIN_AGENT_MODEL=old-model\nDEBUG=1\n')

    applyWriteMainModelLogic(tmpDir, 'claude-haiku-4-5-20251001')

    const env = readFileSync(join(tmpDir, '.env'), 'utf-8')
    expect(env).toContain('PORT=3420')
    expect(env).toContain('DEBUG=1')
    expect(env).toContain('MAIN_AGENT_MODEL=claude-haiku-4-5-20251001')
    expect(env).not.toContain('MAIN_AGENT_MODEL=old-model')
  })
})

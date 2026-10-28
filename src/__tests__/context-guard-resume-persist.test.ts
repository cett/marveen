// The context-guard's "restarted, resume prompt still owed" state survives a
// dashboard restart.
//
// Before this change the await-ready phase lived only in the runner's
// in-memory guardStates map. A dashboard restart between the agent's fresh
// restart and the next sweep re-armed the agent at 'idle', the resume prompt
// was never sent, and the fresh session sat at an empty prompt.
//
// These are BEHAVIOUR tests against the real runner and the real state
// machine; only the process/tmux/DB edges are mocked. The "dashboard restart"
// is simulated the only honest way available in-process: vi.resetModules()
// throws away every module-level Map, and a fresh import + startContextGuardRunner()
// is a new dashboard process that has nothing but store/ to go on.
//
// NEGATIVE CONTROL: delete the restorePendingResumes(...) call from
// startContextGuardRunner() and the first two runner tests go red -- the agent
// is back at 'idle' and sendPromptToSession is never called with the resume.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Under HOME, not /tmp: other guards in this repo reject /tmp-rooted roots.
const ROOT = mkdtempSync(join(homedir(), '.cgresume-test-'))
const STORE = join(ROOT, 'store')
const PENDING = join(STORE, 'context-guard-pending-resume.json')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
  STORE_DIR: STORE,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// A context-limit banner in the footer region: the saturation net trusts the
// pane without a transcript probe, so the in-run restart path can be driven
// with no transcript fixture.
const SATURATED_PANE = [
  '  some prior assistant output',
  '',
  'Context limit reached · use /compact or /clear to continue',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const h = vi.hoisted(() => ({
  pane: null as string | null,
  sessionReady: true,
  restartOk: true,
  sendOutcome: 'sent' as 'sent' | 'aborted-busy' | 'skipped-locked',
  sendThrows: false,
  guardOff: false,
  notifyChannel: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<void>>,
  createAgentMessage: null as unknown as import('vitest').Mock<(...a: unknown[]) => { id: number }>,
  sendPromptToSession: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<string>>,
  restartAgentProcess: null as unknown as import('vitest').Mock<(...a: unknown[]) => void>,
}))

vi.mock('../web/agent-process.js', async () => {
  const { vi } = await import('vitest')
  h.restartAgentProcess = vi.fn(() => {
    if (!h.restartOk) throw new Error('boom')
  })
  h.sendPromptToSession = vi.fn(async () => {
    if (h.sendThrows) throw new Error('tmux send failed')
    return h.sendOutcome
  })
  return {
    agentRunState: () => 'running',
    agentSessionName: (n: string) => `agent-${n}`,
    restartAgentProcess: (...a: unknown[]) => h.restartAgentProcess(...a),
    sendPromptToSession: (...a: unknown[]) => h.sendPromptToSession(...a),
    // Main agent's pane is absent -> main reads as not running and stays idle.
    capturePane: (session: string) => (session.startsWith('agent-') ? h.pane : null),
    isSessionReadyForPrompt: async () => h.sessionReady,
  }
})

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => ({ ok: true }),
  lastMainRespawnAt: () => 0,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['boni'],
  listAllAgentNames: () => ['boni'],
  agentDir: (n: string) => join(ROOT, 'agents', n),
  readAgentModel: () => null,
  readAgentClaudeConfigDir: () => null,
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => null,
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => null,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../web/context-guard-store.js', async () => {
  const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')
  // Only the always-on saturation net is armed, as on an install that never
  // opted in to the proactive tiers.
  return {
    readContextGuardConfig: () => ({
      ...DEFAULT_CONTEXT_GUARD,
      enabled: false,
      saturationRestart: !h.guardOff,
      idleFlushEnabled: false,
      dailyHandoffEnabled: false,
    }),
  }
})
vi.mock('../web/claude-plan-handoff-marker.js', () => ({ appendActivePlanMarkerToHandoff: () => {} }))
vi.mock('../notify.js', async () => {
  const { vi } = await import('vitest')
  h.notifyChannel = vi.fn(async () => {})
  return { notifyChannel: (...a: unknown[]) => h.notifyChannel(...a) }
})
vi.mock('../db/workspace.js', () => ({ getWorkspaceDocUpdatedAtMs: () => Promise.resolve(null) }))
vi.mock('../db.js', async () => {
  const { vi } = await import('vitest')
  h.createAgentMessage = vi.fn(() => ({ id: 1 }))
  return { createAgentMessage: (...a: unknown[]) => h.createAgentMessage(...a) }
})

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000
const T0 = 1_790_000_000_000

type Runner = typeof import('../web/context-guard-runner.js')
let timers: NodeJS.Timeout[] = []

/** A new dashboard process: fresh module state, only store/ carries over. */
async function bootDashboard(): Promise<Runner> {
  vi.resetModules()
  const runner = await import('../web/context-guard-runner.js')
  timers.push(runner.startContextGuardRunner())
  return runner
}

function readPending(): Record<string, { restartedAtMs: number }> {
  return existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf-8')) : {}
}

function writePending(obj: unknown): void {
  writeFileSync(PENDING, JSON.stringify(obj))
}

function resumeCalls(): unknown[][] {
  return h.sendPromptToSession.mock.calls.filter((c) =>
    String(c[1]).includes('Friss kontextussal indultál'),
  )
}

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.pane = null
  h.sessionReady = true
  h.restartOk = true
  h.sendOutcome = 'sent'
  h.sendThrows = false
  h.guardOff = false
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
  h.sendPromptToSession?.mockClear()
  h.restartAgentProcess?.mockClear()
  h.createAgentMessage?.mockClear()
  h.notifyChannel?.mockClear()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('context-guard resume obligation across a dashboard restart', () => {
  it('re-arms await-ready on startup and delivers the resume on the first sweep', async () => {
    writePending({ boni: { restartedAtMs: T0 - 60_000, handoffStaleMinutes: null, reason: 'pane saturated' } })

    const runner = await bootDashboard()
    // The load-on-startup itself: before any sweep has run.
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)

    expect(resumeCalls()).toHaveLength(1)
    expect(resumeCalls()[0][0]).toBe('agent-boni')
    // Delivered -> cleared, so a later dashboard restart does not send it again.
    expect(readPending()).toEqual({})
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
  })

  it('end to end: restart in one dashboard process, resume from the next', async () => {
    // Process 1: the saturation net restarts boni (two confirming sweeps).
    h.pane = SATURATED_PANE
    const first = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(first.getHardGuardPhase('boni')).toBe('await-ready')
    expect(Object.keys(readPending())).toEqual(['boni'])
    expect(resumeCalls()).toHaveLength(0)

    // The dashboard dies before the next sweep could deliver the resume.
    for (const t of timers) clearInterval(t)
    timers = []
    h.pane = null

    // Process 2: nothing in memory, only the file.
    const second = await bootDashboard()
    expect(second.getHardGuardPhase('boni')).toBe('await-ready')
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(1)
    expect(readPending()).toEqual({})
  })

  it('drops an obligation older than the TTL instead of sending it late', async () => {
    const { PENDING_RESUME_TTL_MS } = await import('../web/context-guard-resume-store.js')
    writePending({ boni: { restartedAtMs: T0 - PENDING_RESUME_TTL_MS - 1, handoffStaleMinutes: null, reason: 'x' } })

    const runner = await bootDashboard()
    expect(runner.getHardGuardPhase('boni')).toBe('idle')
    expect(readPending()).toEqual({})
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(0)
  })

  it('expires a restored obligation at the TTL edge if the session never gets ready', async () => {
    const { PENDING_RESUME_TTL_MS } = await import('../web/context-guard-resume-store.js')
    h.sessionReady = false
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(readPending()).toHaveProperty('boni') // still waiting, still owed
    await vi.advanceTimersByTimeAsync(PENDING_RESUME_TTL_MS)
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
    expect(readPending()).toEqual({})
    expect(resumeCalls()).toHaveLength(0)
  })

  it('keeps the obligation and retries when nothing was injected', async () => {
    h.sendOutcome = 'aborted-busy'
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(1)
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
    expect(readPending()).toHaveProperty('boni')

    h.sendOutcome = 'sent'
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(2)
    expect(readPending()).toEqual({})
  })

  it('a resume delivery that threw is not sent again by the next dashboard process', async () => {
    h.sendThrows = true
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(1)
    // Part of the text may already be in the pane: the obligation is dropped.
    expect(readPending()).toEqual({})

    // A dashboard restart well within the TTL must not deliver a second copy.
    for (const t of timers) clearInterval(t)
    timers = []
    h.sendThrows = false
    const second = await bootDashboard()
    expect(second.getHardGuardPhase('boni')).toBe('idle')
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(1)
  })

  it('an agent whose guard was switched off meanwhile loses its obligation, no resume is sent', async () => {
    h.guardOff = true
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(0)
    expect(readPending()).toEqual({})
  })

  it('restoring never overwrites a state the process already holds for the agent', async () => {
    const { INITIAL_GUARD_STATE } = await import('../context-guard.js')
    const runner = await bootDashboard()
    const live = { ...INITIAL_GUARD_STATE, phase: 'cooldown' as const, cooldownUntilMs: T0 + 1_000_000 }
    runner.guardStatesForTesting().set('boni', live)
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    expect(runner.restorePendingResumes(T0)).toEqual(['boni'])
    expect(runner.guardStatesForTesting().get('boni')).toBe(live)
  })

  it('never persists an obligation for a restart that failed', async () => {
    h.pane = SATURATED_PANE
    h.restartOk = false
    await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(existsSync(PENDING) ? readPending() : {}).toEqual({})
  })

  // The state machine steps to await-ready BEFORE the restart runs. A restart
  // that throws must not leave it there: the guard would wait for a session it
  // never started and push the resume prompt into the old, saturated pane.
  describe('a restart that throws is rolled back', () => {
    it('does not stay in await-ready, sends no resume, claims no restart on the queue', async () => {
      h.pane = SATURATED_PANE
      h.restartOk = false
      const runner = await bootDashboard()
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
      expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
      expect(runner.getHardGuardPhase('boni')).not.toBe('await-ready')

      // The session reports ready: with the old behaviour this delivered the
      // resume prompt into the pane that was never restarted.
      h.sessionReady = true
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(resumeCalls()).toHaveLength(0)
      expect(h.createAgentMessage).not.toHaveBeenCalled()
    })

    it('decides again on the next sweep and recovers once the restart works', async () => {
      h.pane = SATURATED_PANE
      h.restartOk = false
      const runner = await bootDashboard()
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
      expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)

      h.restartOk = true
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(h.restartAgentProcess).toHaveBeenCalledTimes(2)
      expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
      expect(Object.keys(readPending())).toEqual(['boni'])
      expect(h.createAgentMessage).toHaveBeenCalledTimes(1)
    })
  })
})

// A restart that keeps throwing is retried every sweep; the operator hears of it once per series.
describe('consecutive restart failures raise one message', () => {
  const alertCalls = (): unknown[][] => h.createAgentMessage.mock.calls.filter((c) => String(c[2]).includes('egymas utani'))
  const boom = new Error('launchctl kickstart failed at /opt/svc/LaunchAgents/a.plist')

  it('2 failures: none; the 3rd: exactly one; the 4th and 5th: no more', async () => {
    const runner = await bootDashboard()
    await runner.noteRestartFailure('boni', boom)
    await runner.noteRestartFailure('boni', boom)
    expect(alertCalls()).toHaveLength(0)
    await runner.noteRestartFailure('boni', boom)
    expect(alertCalls()).toHaveLength(1)
    await runner.noteRestartFailure('boni', boom)
    await runner.noteRestartFailure('boni', boom)
    expect(alertCalls()).toHaveLength(1)
  })

  it('the message names the agent, the count and a short path-free reason, to the main agent', async () => {
    const runner = await bootDashboard()
    for (let i = 0; i < 3; i++) await runner.noteRestartFailure('boni', boom)
    const [from, to, text] = alertCalls()[0] as [string, string, string]
    expect(from).toBe('boni')
    expect(to).toBe('marveen')
    expect(text).toContain('"boni"')
    expect(text).toContain('3.')
    expect(text).toContain('launchctl kickstart failed')
    expect(text).not.toContain('/opt/svc')
    expect(text.length).toBeLessThan(400)
  })

  it('a success resets the series: three more failures alert again', async () => {
    const runner = await bootDashboard()
    for (let i = 0; i < 3; i++) await runner.noteRestartFailure('boni', boom)
    runner.clearRestartFailures('boni')
    await runner.noteRestartFailure('boni', boom)
    await runner.noteRestartFailure('boni', boom)
    expect(alertCalls()).toHaveLength(1)
    await runner.noteRestartFailure('boni', boom)
    expect(alertCalls()).toHaveLength(2)
  })

  it('agents count separately', async () => {
    const runner = await bootDashboard()
    await runner.noteRestartFailure('boni', boom)
    await runner.noteRestartFailure('boni', boom)
    await runner.noteRestartFailure('other', boom)
    expect(alertCalls()).toHaveLength(0)
  })

  it('the main agent is told on the channel, not in its own queue', async () => {
    const runner = await bootDashboard()
    for (let i = 0; i < 3; i++) await runner.noteRestartFailure('marveen', boom)
    expect(h.notifyChannel).toHaveBeenCalledTimes(1)
    expect(alertCalls()).toHaveLength(0)
  })

  it('the runner clears the series right after a restart that did not throw (source pin: the guard cooldown keeps a second series out of reach of an end-to-end test)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'web', 'context-guard-runner.ts'), 'utf-8')
    const failed = src.indexOf('noteRestartFailure(name, err)\n          break\n        }')
    const cleared = src.indexOf('        clearRestartFailures(name)\n')
    expect(failed).toBeGreaterThan(0)
    expect(cleared).toBeGreaterThan(failed)
    expect(src.slice(failed, cleared).split('\n').length).toBeLessThan(6)
    expect(src.match(/clearRestartFailures\(name\)/g)).toHaveLength(1 + 0 + 0)
  })

  it('end to end: a restart that throws every sweep alerts once, on the third failure', async () => {
    h.pane = SATURATED_PANE
    h.restartOk = false
    await bootDashboard()
    // sweep 1 confirms, sweeps 2..6 each try (and fail) the restart
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 5 * INTERVAL_MS)
    expect(h.restartAgentProcess.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(alertCalls()).toHaveLength(1)
  })
})

describe('context-guard-resume-store: pure parts', () => {
  it('parses defensively: malformed entries are dropped, staleness is validated', async () => {
    const { parsePendingResumes } = await import('../web/context-guard-resume-store.js')
    expect(parsePendingResumes(null)).toEqual({})
    expect(parsePendingResumes([1, 2])).toEqual({})
    expect(parsePendingResumes({
      a: { restartedAtMs: 5, handoffStaleMinutes: 12, reason: 'r' },
      b: { restartedAtMs: 'nope' },
      c: { restartedAtMs: 7, handoffStaleMinutes: 'garbage' },
      d: { restartedAtMs: 8, handoffStaleMinutes: 'unknown' },
    })).toEqual({
      a: { restartedAtMs: 5, handoffStaleMinutes: 12, reason: 'r' },
      c: { restartedAtMs: 7, handoffStaleMinutes: null, reason: '' },
      d: { restartedAtMs: 8, handoffStaleMinutes: 'unknown', reason: '' },
    })
  })

  it('restores with the TTL edge as deadline and carries the staleness', async () => {
    const { restorableResumeStates } = await import('../web/context-guard-resume-store.js')
    const { live, expired } = restorableResumeStates({
      fresh: { restartedAtMs: 1_000, handoffStaleMinutes: 7, reason: '' },
      old: { restartedAtMs: 0, handoffStaleMinutes: null, reason: '' },
      // A future timestamp (clock change) must not make the entry immortal.
      future: { restartedAtMs: 10_000_000, handoffStaleMinutes: null, reason: '' },
    }, 1_500, 1_000)
    expect(expired).toEqual(['old'])
    expect(live.get('fresh')).toMatchObject({ phase: 'await-ready', deadlineMs: 2_000, handoffStaleMinutes: 7 })
    expect(live.get('future')).toMatchObject({ phase: 'await-ready', deadlineMs: 2_500 })
  })

  it('reads a missing or corrupt file as empty', async () => {
    const { readPendingResumes } = await import('../web/context-guard-resume-store.js')
    expect(readPendingResumes(join(STORE, 'does-not-exist.json'))).toEqual({})
    writeFileSync(join(STORE, 'corrupt.json'), '{not json')
    expect(readPendingResumes(join(STORE, 'corrupt.json'))).toEqual({})
  })
})

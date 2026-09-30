// Regression: a model-fallback downgrade used to be sticky.
//
//   - the runner REWROTE the operator's model config (.env MAIN_AGENT_MODEL /
//     agent-config.json) to downgrade, so the operator's choice was lost;
//   - "downgraded at" lived only in memory, so after a dashboard restart the
//     revert never fired and the agent stayed on the fallback forever;
//   - the revert climbed to the fleet-global chain[0], not the agent's own
//     primary;
//   - nothing paused between sweeps, so a freshly respawned pane that still
//     showed a banner cascaded opus -> sonnet -> haiku one minute apart;
//   - the "approaching usage limit" heads-up counted as an exhausted budget.
//
// Drives the REAL runner + state store + decision logic against a temp store
// dir; only tmux / process / config I/O is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ctx = vi.hoisted(() => ({
  store: '',
  panes: {} as Record<string, string | null>,
  configured: {} as Record<string, string>,
  idle: true,
  mainRestartOk: true,
}))
const m = vi.hoisted(() => ({
  capturePane: vi.fn(),
  restartAgentProcess: vi.fn(),
  hardRestart: vi.fn(),
  writeAgentModel: vi.fn(),
  updateEnvFile: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}))

vi.mock('../config.js', () => ({
  get STORE_DIR() { return ctx.store },
  MAIN_AGENT_ID: 'main',
  PROJECT_ROOT: '/nonexistent-test-root',
}))
vi.mock('../logger.js', () => ({
  logger: { info: m.loggerInfo, warn: m.loggerWarn, debug: vi.fn() },
}))
vi.mock('../web/agent-process.js', () => ({
  capturePane: m.capturePane,
  agentRunState: vi.fn(() => 'running'),
  agentSessionName: vi.fn((name: string) => `${name}-session`),
  restartAgentProcess: m.restartAgentProcess,
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn(() => ['sub']),
  readAgentRemoteHost: vi.fn(() => null),
  readAgentModelConfigured: vi.fn((name: string) => ctx.configured[name]),
  readMainModelConfigured: vi.fn(() => ctx.configured['main']),
  writeAgentModel: m.writeAgentModel,
  resolveModelId: vi.fn((x: string) => x),
  DEFAULT_MODEL: 'claude-opus-5',
}))
vi.mock('../env.js', () => ({ updateEnvFile: m.updateEnvFile, readEnvFile: vi.fn(() => ({})) }))
vi.mock('../web/model-fallback-store.js', () => ({
  readModelFallbackConfig: vi.fn(() => ({
    enabled: true,
    revertAfterMinutes: 60,
    chain: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  })),
}))
vi.mock('../pane-state.js', () => ({ paneLooksIdle: vi.fn(() => ctx.idle) }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels' }))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels: m.hardRestart }))

const OPUS55 = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5-20251001'
const MIN = 60_000

const BOX = '─'.repeat(80)
// Assembled at runtime: this file must not hold bare banner lines that the live
// pane detector could read off a pane displaying it.
const BANNER = ['You hit your session', 'limit · resets 5:50pm'].join(' ')
const APPROACHING = ['Approaching', 'usage limit'].join(' ')
const paneWith = (line: string) => ['  output', '', '  ' + line, '', BOX, '> ', BOX, '  ? for shortcuts'].join('\n')
const LIMIT_PANE = paneWith(BANNER)
const CLEAN_PANE = paneWith('  all good')

type Runner = typeof import('../web/model-fallback-runner.js')
type State = typeof import('../web/model-fallback-state.js')
let runner: Runner
let state: State
let handle: NodeJS.Timeout

async function boot(): Promise<void> {
  vi.resetModules()
  runner = await import('../web/model-fallback-runner.js')
  state = await import('../web/model-fallback-state.js')
  handle = runner.startModelFallbackRunner()
}

function stateFile(): Record<string, { primary: string; current: string; downgradedAt: number }> {
  const p = join(ctx.store, 'model-fallback-state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {}
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T13:00:00Z'))
  ctx.store = mkdtempSync(join(tmpdir(), 'model-fallback-sticky-'))
  ctx.idle = true
  ctx.configured = { main: OPUS55, sub: SONNET }
  ctx.panes = { 'main-channels': CLEAN_PANE, 'sub-session': CLEAN_PANE }
  for (const f of Object.values(m)) f.mockReset()
  m.capturePane.mockImplementation((session: string) => ctx.panes[session] ?? null)
  m.hardRestart.mockImplementation(() => (ctx.mainRestartOk ? { ok: true } : { ok: false, error: 'boom' }))
  ctx.mainRestartOk = true
})

afterEach(() => {
  clearInterval(handle)
  vi.useRealTimers()
  rmSync(ctx.store, { recursive: true, force: true })
})

// First sweep fires at 50s, then every 60s.
const firstSweep = () => vi.advanceTimersByTime(50_000 + 1)
const minutes = (n: number) => vi.advanceTimersByTime(n * MIN)

describe('downgrade leaves the operator config alone', () => {
  it('pins the agent in the overlay, never writes .env / agent-config', async () => {
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()

    expect(stateFile()['main']).toMatchObject({ primary: OPUS55, current: SONNET })
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
    expect(m.updateEnvFile).not.toHaveBeenCalled()
    expect(m.writeAgentModel).not.toHaveBeenCalled()
    // The operator's own model is what a revert goes back to -- untouched.
    expect(ctx.configured['main']).toBe(OPUS55)
  })

  it('a sub-agent downgrade goes through the same overlay, not agent-config.json', async () => {
    ctx.panes['sub-session'] = LIMIT_PANE
    await boot()
    firstSweep()

    expect(stateFile()['sub']).toMatchObject({ primary: SONNET, current: HAIKU })
    expect(m.restartAgentProcess).toHaveBeenCalledWith('sub', { fresh: false })
    expect(m.writeAgentModel).not.toHaveBeenCalled()
  })
})

describe('revert survives a dashboard restart and lands on the agent own primary', () => {
  it('reverts from a persisted overlay after a fresh boot (empty in-memory state)', async () => {
    const downgradedAt = Date.now() - 90 * MIN
    writeFileSync(
      join(ctx.store, 'model-fallback-state.json'),
      JSON.stringify({ main: { primary: OPUS55, current: SONNET, downgradedAt } }),
    )
    await boot() // "dashboard restarted": nothing in memory
    firstSweep()

    expect(stateFile()['main']).toBeUndefined()
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
    // Overlay gone -> resolvers fall through to the operator's model: opus-5-5,
    // NOT chain[0] (claude-opus-5).
    expect(ctx.configured['main']).toBe(OPUS55)
    expect(state.getFallbackOverride('main')).toBeNull()
    // The decision itself targets the agent's own primary, not chain[0].
    expect(m.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'revert', from: SONNET, to: OPUS55 }),
      'model-fallback: switched model',
    )
  })

  it('does not revert before the window has elapsed', async () => {
    writeFileSync(
      join(ctx.store, 'model-fallback-state.json'),
      JSON.stringify({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 10 * MIN } }),
    )
    await boot()
    firstSweep()

    expect(stateFile()['main']).toMatchObject({ current: SONNET })
    expect(m.hardRestart).not.toHaveBeenCalled()
  })

  it('a sub-agent whose primary is sonnet is never "reverted" up to the chain top', async () => {
    writeFileSync(
      join(ctx.store, 'model-fallback-state.json'),
      JSON.stringify({ sub: { primary: SONNET, current: HAIKU, downgradedAt: Date.now() - 90 * MIN } }),
    )
    await boot()
    firstSweep()

    expect(stateFile()['sub']).toBeUndefined()
    expect(m.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(m.writeAgentModel).not.toHaveBeenCalled()
    // What the respawn resolves to is the operator's sonnet, not chain[0] (opus).
    expect(ctx.configured['sub']).toBe(SONNET)
  })

  it('drops a stale overlay (operator has since set that very model) without a restart', async () => {
    ctx.configured['main'] = SONNET
    writeFileSync(
      join(ctx.store, 'model-fallback-state.json'),
      JSON.stringify({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 5 * MIN } }),
    )
    await boot()
    firstSweep()

    expect(stateFile()['main']).toBeUndefined()
    expect(m.hardRestart).not.toHaveBeenCalled()
  })

  it('a corrupt state file behaves like "nothing downgraded"', async () => {
    writeFileSync(join(ctx.store, 'model-fallback-state.json'), '{not json')
    await boot()
    firstSweep()

    expect(m.hardRestart).not.toHaveBeenCalled()
    expect(state.getFallbackOverride('main')).toBeNull()
  })
})

describe('cooldown stops the 60s cascade', () => {
  it('a pane that still shows the banner after the respawn does not trigger a second downgrade', async () => {
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()
    expect(stateFile()['main']).toMatchObject({ current: SONNET })

    // The 13:29 -> 13:30 incident: next sweep 60s later, banner still visible.
    vi.advanceTimersByTime(MIN)
    expect(stateFile()['main']).toMatchObject({ current: SONNET })
    expect(m.hardRestart).toHaveBeenCalledTimes(1)

    minutes(8) // still inside the 10 minute cooldown
    expect(stateFile()['main']).toMatchObject({ current: SONNET })
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
  })

  it('after the cooldown a banner that is still there moves one more step down', async () => {
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()
    minutes(11)

    expect(stateFile()['main']).toMatchObject({ primary: OPUS55, current: HAIKU })
    expect(m.hardRestart).toHaveBeenCalledTimes(2)
  })

  it('the cooldown also holds across a dashboard restart (persisted downgradedAt)', async () => {
    writeFileSync(
      join(ctx.store, 'model-fallback-state.json'),
      JSON.stringify({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - MIN } }),
    )
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()

    expect(stateFile()['main']).toMatchObject({ current: SONNET })
    expect(m.hardRestart).not.toHaveBeenCalled()
  })
})

describe('false positives', () => {
  it('the "approaching" heads-up does not downgrade anybody', async () => {
    ctx.panes['main-channels'] = paneWith(APPROACHING)
    ctx.panes['sub-session'] = paneWith(APPROACHING)
    await boot()
    firstSweep()
    minutes(3)

    expect(stateFile()).toEqual({})
    expect(m.hardRestart).not.toHaveBeenCalled()
    expect(m.restartAgentProcess).not.toHaveBeenCalled()
  })

  it('a busy pane defers the downgrade without touching any state', async () => {
    ctx.idle = false
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()

    expect(stateFile()).toEqual({})
    expect(m.hardRestart).not.toHaveBeenCalled()
  })
})

describe('a failed respawn does not leave a phantom downgrade', () => {
  it('rolls the overlay back when the restart throws (downgrade)', async () => {
    ctx.mainRestartOk = false
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()

    expect(m.hardRestart).toHaveBeenCalledTimes(1)
    expect(stateFile()['main']).toBeUndefined()
  })

  it('restores the previous overlay when the restart throws (revert)', async () => {
    ctx.mainRestartOk = false
    const entry = { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 90 * MIN }
    writeFileSync(join(ctx.store, 'model-fallback-state.json'), JSON.stringify({ main: entry }))
    await boot()
    firstSweep()

    expect(m.hardRestart).toHaveBeenCalledTimes(1)
    expect(stateFile()['main']).toEqual(entry)
  })
})

describe('state store', () => {
  it('rejects a model id that is not a plain id (it ends up in a shell launch command)', async () => {
    await boot()
    expect(() => state.setFallbackOverride('main', { primary: OPUS55, current: "x'; echo pwned; '", downgradedAt: 1 }))
      .toThrow()
    expect(stateFile()).toEqual({})
  })

  it('drops malformed entries on read instead of failing the launch path', async () => {
    writeFileSync(
      join(ctx.store, 'model-fallback-state.json'),
      JSON.stringify({
        good: { primary: OPUS55, current: SONNET, downgradedAt: 5 },
        badModel: { primary: OPUS55, current: 'a b', downgradedAt: 5 },
        badTime: { primary: OPUS55, current: SONNET, downgradedAt: 'x' },
      }),
    )
    await boot()
    expect(Object.keys(state.listFallbackOverrides())).toEqual(['good'])
  })
})

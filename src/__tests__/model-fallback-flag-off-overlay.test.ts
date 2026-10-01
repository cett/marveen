// Switching the model-fallback feature OFF must not strand an agent on the
// fallback model: the sweep keeps driving every EXISTING overlay back to the
// operator's model through the same revert path (same window, clear-then-restart),
// while the flag only forbids starting a NEW downgrade.
//
// Drives the REAL runner + state store + decision logic against a temp store
// dir; only tmux / process / config I/O is mocked. The effective model after a
// sweep is read the way a respawn reads it: scripts/channels.sh for main.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const ctx = vi.hoisted(() => ({
  store: '',
  panes: {} as Record<string, string | null>,
  configured: {} as Record<string, string>,
  idle: true,
  mainRestartOk: true,
  enabled: false,
  subRunning: true,
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
  agentRunState: vi.fn((name: string) => (name === 'sub' && !ctx.subRunning ? 'stopped' : 'running')),
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
    enabled: ctx.enabled,
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
  ctx.enabled = false
  ctx.subRunning = true
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


const writeState = (entries: Record<string, { primary: string; current: string; downgradedAt: number }>) =>
  writeFileSync(join(ctx.store, 'model-fallback-state.json'), JSON.stringify(entries))

// What a main-agent respawn would launch with right now (the real launcher
// resolver, reading the same state file the runner just wrote).
function mainLaunchModel(): string {
  const root = join(ctx.store, 'install')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(join(__dirname, '../../scripts/channels.sh'), join(root, 'scripts', 'channels.sh'))
  writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=main\nMAIN_AGENT_MODEL=${OPUS55}\n`)
  const out = execFileSync('bash', [join(root, 'scripts', 'channels.sh'), '--resolve-main-model'], {
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', MARVEEN_STORE_DIR: ctx.store, MAIN_AGENT_MODEL: OPUS55, MAIN_AGENT_ID: 'main' },
    encoding: 'utf-8',
  })
  return out.split('\n')[0]
}

describe('flag OFF: an existing overlay is still reverted', () => {
  it('an expired main overlay is cleared and the agent restarted, effective model = configured', async () => {
    writeState({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 90 * MIN } })
    expect(mainLaunchModel()).toBe(SONNET) // sanity: the overlay really pins it

    await boot()
    firstSweep()

    expect(stateFile()['main']).toBeUndefined()
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
    expect(mainLaunchModel()).toBe(OPUS55)
    expect(m.writeAgentModel).not.toHaveBeenCalled()
    expect(m.updateEnvFile).not.toHaveBeenCalled()
  })

  it('an expired sub-agent overlay is cleared and the agent respawned on its own primary', async () => {
    writeState({ sub: { primary: SONNET, current: HAIKU, downgradedAt: Date.now() - 90 * MIN } })
    await boot()
    firstSweep()

    expect(stateFile()['sub']).toBeUndefined()
    expect(m.restartAgentProcess).toHaveBeenCalledWith('sub', { fresh: false })
    expect(state.getFallbackOverride('sub')).toBeNull()
  })

  it('an overlay that is not yet due stays, and nothing is restarted', async () => {
    writeState({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 10 * MIN } })
    await boot()
    firstSweep()

    expect(stateFile()['main']).toMatchObject({ current: SONNET })
    expect(m.hardRestart).not.toHaveBeenCalled()
  })

  it('a due overlay is not dropped while the pane is busy (no cut turn), and goes once it is idle', async () => {
    writeState({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 90 * MIN } })
    ctx.idle = false
    await boot()
    firstSweep()
    expect(stateFile()['main']).toMatchObject({ current: SONNET })
    expect(m.hardRestart).not.toHaveBeenCalled()

    ctx.idle = true
    vi.advanceTimersByTime(MIN)
    expect(stateFile()['main']).toBeUndefined()
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
  })

  it('a due overlay of a STOPPED sub-agent is dropped without any restart', async () => {
    ctx.subRunning = false
    writeState({ sub: { primary: SONNET, current: HAIKU, downgradedAt: Date.now() - 90 * MIN } })
    await boot()
    firstSweep()

    expect(stateFile()['sub']).toBeUndefined()
    expect(m.restartAgentProcess).not.toHaveBeenCalled()
  })

  it('a failed respawn puts the overlay back (same rollback as with the flag on)', async () => {
    ctx.mainRestartOk = false
    const entry = { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 90 * MIN }
    writeState({ main: entry })
    await boot()
    firstSweep()

    expect(m.hardRestart).toHaveBeenCalledTimes(1)
    expect(stateFile()['main']).toEqual(entry)
  })
})

describe('flag OFF: no new downgrade, fleet otherwise untouched', () => {
  it('a usage-limit banner creates no overlay and restarts nobody', async () => {
    ctx.panes['main-channels'] = LIMIT_PANE
    ctx.panes['sub-session'] = LIMIT_PANE
    await boot()
    firstSweep()
    minutes(15)

    expect(stateFile()).toEqual({})
    expect(m.hardRestart).not.toHaveBeenCalled()
    expect(m.restartAgentProcess).not.toHaveBeenCalled()
  })

  it('a banner on a pane with an existing overlay does not push it further down', async () => {
    const entry = { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 20 * MIN }
    writeState({ main: entry })
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()
    minutes(15)

    expect(stateFile()['main']).toEqual(entry)
    expect(m.hardRestart).not.toHaveBeenCalled()
  })

  it('agents without an overlay are not even inspected', async () => {
    await boot()
    firstSweep()
    minutes(3)

    expect(m.capturePane).not.toHaveBeenCalled()
  })
})

describe('flag ON: unchanged', () => {
  it('still downgrades on a banner', async () => {
    ctx.enabled = true
    ctx.panes['main-channels'] = LIMIT_PANE
    await boot()
    firstSweep()

    expect(stateFile()['main']).toMatchObject({ primary: OPUS55, current: SONNET })
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
  })

  it('still reverts an expired overlay', async () => {
    ctx.enabled = true
    writeState({ main: { primary: OPUS55, current: SONNET, downgradedAt: Date.now() - 90 * MIN } })
    await boot()
    firstSweep()

    expect(stateFile()['main']).toBeUndefined()
    expect(m.hardRestart).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The health monitor runs the (synchronous, blocking) MCP reconnect in a
// DETACHED child process so it can never starve the dashboard event loop, so we
// assert on spawn(), not on an inline attemptChannelMcpReconnect call.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: mockSpawn,
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['samu'],
  readAgentChannelProvider: () => 'telegram',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => name === 'samu',
  capturePane: (session: string) => mockCapturePane(session),
  agentSessionName: (name: string) => `agent-${name}`,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

const mockReconnect = vi.fn()
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: (name: string) => mockReconnect(name),
  resolveAgentSession: (name: string) => name === 'marveen' ? 'marveen-channels' : `agent-${name}`,
  resolveAgentProviderType: () => 'telegram' as const,
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    pluginId: 'telegram@claude-plugins-official',
    pluginPaneId: 'plugin:telegram:telegram',
  }),
}))

import { getChannelHealth, startChannelHealthMonitor } from '../web/channel-health-monitor.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('getChannelHealth', () => {
  it('returns healthy when no reconnect state exists', () => {
    const health = getChannelHealth('unknown-agent')
    expect(health.healthy).toBe(true)
    expect(health.reconnectAttempts).toBe(0)
    expect(health.lastAttemptAt).toBeNull()
  })
})

describe('startChannelHealthMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Fake detached child: the monitor calls .once('exit'|'error', ...) + .unref().
    mockSpawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a timer handle', () => {
    const timer = startChannelHealthMonitor()
    expect(timer).toBeDefined()
    clearInterval(timer)
  })

  it('does not reconnect when pane shows no failure', () => {
    const timer = startChannelHealthMonitor()
    mockCapturePane.mockReturnValue('normal pane content with plugin:telegram:telegram active')

    vi.advanceTimersByTime(46_000)

    expect(mockSpawn).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('spawns a detached reconnect worker when pane shows plugin failure', () => {
    const timer = startChannelHealthMonitor()
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed\nsome other output',
    )

    vi.advanceTimersByTime(46_000)

    // Off-main-loop: a detached child (reconnect-cli.js) is spawned instead of
    // calling attemptChannelMcpReconnect inline (event-loop starvation fix).
    expect(mockSpawn).toHaveBeenCalled()
    const [, args] = mockSpawn.mock.calls[0]
    expect(String(args[0])).toContain('reconnect-cli')
    expect(args[1]).toBe('marveen')
    clearInterval(timer)
  })
})

// checkMainKeepaliveStaleness (channel-monitor.ts) -- bun-alive short-circuit
// (2026-06-01 21:18 incident): "óra :18 és :48 kor folyton" stale-keepalive
// alerts during quiet conversation periods. Each alert triggered a
// respawn-pane that killed the running --continue context for nothing -- the
// plugin was perfectly alive, the file just hadn't been touched in 18+ min
// because there was no organic inbound traffic. The fix: if the channel
// plugin's bun poller is alive under the claude pid, return early; a stale
// file with a live poller is a QUIET channel, not a deaf one. Source-grep
// guard against the real file (not the mocked module graph above).
describe('checkMainKeepaliveStaleness: bun-alive short-circuit', () => {
  const monitorSrc = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const fnStart = monitorSrc.indexOf('function checkMainKeepaliveStaleness')
  expect(fnStart, 'checkMainKeepaliveStaleness not found').toBeGreaterThan(0)
  const fnEnd = monitorSrc.indexOf('\nfunction ', fnStart + 1)
  const fnBody = monitorSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)

  it('probes hasChannelPluginAlive before measuring file staleness', () => {
    const aliveIdx = fnBody.indexOf('hasChannelPluginAlive(')
    const ageIdx = fnBody.indexOf('keepaliveAgeMs')
    expect(aliveIdx, 'hasChannelPluginAlive call missing').toBeGreaterThan(0)
    expect(ageIdx, 'age calculation missing').toBeGreaterThan(0)
    expect(aliveIdx).toBeLessThan(ageIdx)
  })

  it('returns early when the plugin is alive (no respawn for quiet channels)', () => {
    const aliveIdx = fnBody.indexOf('hasChannelPluginAlive(')
    // The early-return must come BEFORE shouldRespawnForStaleKeepalive() is consulted.
    const decisionIdx = fnBody.indexOf('shouldRespawnForStaleKeepalive(')
    expect(decisionIdx).toBeGreaterThan(aliveIdx)
    // And there must be a `return` between alive-probe and decision.
    const between = fnBody.slice(aliveIdx, decisionIdx)
    expect(between).toMatch(/return\b/)
  })

  it('fails OPEN (falls through to existing logic) if the liveness probe throws', () => {
    // A try/catch around the shortcut so a broken pgrep / missing tmux session
    // never blocks recovery of a genuinely dead session.
    const aliveIdx = fnBody.indexOf('hasChannelPluginAlive(')
    const tryIdx = fnBody.lastIndexOf('try {', aliveIdx)
    expect(tryIdx).toBeGreaterThan(0)
    // The try-block must end before shouldRespawnForStaleKeepalive
    const catchIdx = fnBody.indexOf('catch', tryIdx)
    expect(catchIdx).toBeGreaterThan(0)
    expect(catchIdx).toBeLessThan(fnBody.indexOf('shouldRespawnForStaleKeepalive('))
  })
})

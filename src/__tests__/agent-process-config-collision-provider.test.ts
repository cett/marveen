/**
 * Coverage for src/web/agent-process-config.ts functions with no direct test
 * coverage: countSameProviderChannelContenders (the I/O-fetching wrapper
 * around the already-tested pure maxSameProviderContenders), the
 * resetSharedConfigCollisionAlert/maybeAlertSharedConfigCollision alert-once
 * pair, and resolveAgentProvider's per-agent-override-vs-global-default
 * branching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../config.js'

const mockListAgentNames = vi.hoisted(() => vi.fn())
const mockReadAgentChannelProvider = vi.hoisted(() => vi.fn())
const mockAgentRunState = vi.hoisted(() => vi.fn())
const mockAgentHasChannel = vi.hoisted(() => vi.fn())
const mockNotifyChannel = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, listAgentNames: mockListAgentNames, readAgentChannelProvider: mockReadAgentChannelProvider }
})
vi.mock('../web/agent-process-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process-session.js')>()
  return { ...actual, agentRunState: mockAgentRunState, agentHasChannel: mockAgentHasChannel }
})
vi.mock('../notify.js', () => ({ notifyChannel: mockNotifyChannel }))

import {
  countSameProviderChannelContenders,
  resetSharedConfigCollisionAlert,
  maybeAlertSharedConfigCollision,
  resolveAgentProvider,
} from '../web/agent-process-config.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockNotifyChannel.mockResolvedValue(undefined)
  resetSharedConfigCollisionAlert()
})

describe('resolveAgentProvider', () => {
  it('returns the agent explicit per-agent provider when it is a valid channel type', () => {
    mockReadAgentChannelProvider.mockReturnValue('slack')
    expect(resolveAgentProvider('alice')).toBe('slack')
  })

  it('falls back to the global CHANNEL_PROVIDER when no explicit provider is set', () => {
    mockReadAgentChannelProvider.mockReturnValue(null)
    expect(resolveAgentProvider('bob')).toBe(CHANNEL_PROVIDER)
  })

  it('falls back to the global default for an unrecognised stored value', () => {
    mockReadAgentChannelProvider.mockReturnValue('not-a-real-provider')
    expect(resolveAgentProvider('carol')).toBe(CHANNEL_PROVIDER)
  })
})

describe('countSameProviderChannelContenders', () => {
  it('excludes the main agent from the contender count', () => {
    mockListAgentNames.mockReturnValue([MAIN_AGENT_ID, 'boni', 'samu'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentRunState.mockReturnValue('running')
    mockAgentHasChannel.mockReturnValue(true)
    // boni + samu contend on telegram; MAIN_AGENT_ID is excluded regardless of state.
    expect(countSameProviderChannelContenders('boni')).toBe(2)
  })

  it('treats the agent currently starting as running even before its tmux session exists', () => {
    mockListAgentNames.mockReturnValue(['boni', 'samu'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentHasChannel.mockReturnValue(true)
    // 'samu' is genuinely running; 'boni' is the one being spawned right now
    // (agentRunState would still say 'stopped' for it).
    mockAgentRunState.mockImplementation((n: string) => (n === 'samu' ? 'running' : 'stopped'))
    expect(countSameProviderChannelContenders('boni')).toBe(2)
  })

  it('returns 0 when no other agent shares a running, channel-having provider slot', () => {
    // 'boni' (the agent being started) is not itself in the fleet list here,
    // so it contributes nothing on its own; the one other agent is stopped.
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentRunState.mockReturnValue('stopped')
    mockAgentHasChannel.mockReturnValue(true)
    expect(countSameProviderChannelContenders('boni')).toBe(0)
  })
})

describe('maybeAlertSharedConfigCollision', () => {
  // shouldAlertSharedConfigCollision's platform check defaults to the real
  // process.platform (darwin never alerts, by design). Force 'linux' for
  // these tests so the alert path is exercised deterministically regardless
  // of which OS actually runs the suite.
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('does nothing when there is no collision (single contender)', () => {
    mockListAgentNames.mockReturnValue(['boni'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentRunState.mockReturnValue('running')
    mockAgentHasChannel.mockReturnValue(true)
    maybeAlertSharedConfigCollision('boni')
    expect(mockNotifyChannel).not.toHaveBeenCalled()
  })

  it('alerts once when >1 same-provider agent is running (on a non-darwin platform)', () => {
    mockListAgentNames.mockReturnValue(['boni', 'samu'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentRunState.mockReturnValue('running')
    mockAgentHasChannel.mockReturnValue(true)
    maybeAlertSharedConfigCollision('boni')
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
    expect(mockNotifyChannel.mock.calls[0][0]).toMatch(/fleet OAuth token/i)
  })

  it('does not re-alert on a second collision within the same episode (alert-once dedup)', () => {
    mockListAgentNames.mockReturnValue(['boni', 'samu'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentRunState.mockReturnValue('running')
    mockAgentHasChannel.mockReturnValue(true)
    maybeAlertSharedConfigCollision('boni')
    maybeAlertSharedConfigCollision('boni')
    expect(mockNotifyChannel).toHaveBeenCalledTimes(1)
  })

  it('resetSharedConfigCollisionAlert re-arms the latch for a later episode', () => {
    mockListAgentNames.mockReturnValue(['boni', 'samu'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockAgentRunState.mockReturnValue('running')
    mockAgentHasChannel.mockReturnValue(true)
    maybeAlertSharedConfigCollision('boni')
    resetSharedConfigCollisionAlert()
    maybeAlertSharedConfigCollision('boni')
    expect(mockNotifyChannel).toHaveBeenCalledTimes(2)
  })
})

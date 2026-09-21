// Test suite for channel-request-watcher (#751 step 26).
// Scans per-agent Slack audit logs for bot-mentioned-but-not-allowed drops,
// records them as pending channel requests, and resolves the Slack channel
// name asynchronously via the conversations.info API.
//
// The module keeps two module-level Maps (per-agent file offsets, a Slack
// channel-name cache) plus an interval handle. Every test re-imports the
// module fresh via vi.resetModules() so that state never leaks between
// cases -- without it, a later test reusing the same fake audit-log buffer
// silently sees "no new bytes" from a previous test's offset.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockExistsSync = vi.hoisted(() => vi.fn(() => false))
const mockReadFileSync = vi.hoisted(() => vi.fn(() => Buffer.from('')))
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

const mockLoggerInfo = vi.hoisted(() => vi.fn())
const mockLoggerWarn = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config.js', () => ({
  CHANNEL_PROVIDER: 'telegram',
}))

const mockListAgentNames = vi.hoisted(() => vi.fn(() => [] as string[]))
const mockReadAgentChannelProvider = vi.hoisted(() => vi.fn((_name: string) => null as string | null))
const mockAgentDir = vi.hoisted(() => vi.fn((name: string) => `/agents/${name}`))
vi.mock('../web/agent-config.js', () => ({
  agentDir: mockAgentDir,
  listAgentNames: mockListAgentNames,
  readAgentChannelProvider: mockReadAgentChannelProvider,
}))

const mockChannelStateDir = vi.hoisted(() => vi.fn((_provider: string, dir?: string) => `${dir}/channel-state`))
const mockReadChannelToken = vi.hoisted(() => vi.fn((_provider: string, _path: string) => null as string | null))
vi.mock('../channel-provider.js', () => ({
  channelStateDir: mockChannelStateDir,
  readChannelToken: mockReadChannelToken,
}))

const mockUpsertChannelRequest = vi.hoisted(() => vi.fn((_agent: string, _channel: string, _user?: string) => true))
const mockListPendingChannelRequests = vi.hoisted(() => vi.fn((_agent: string) => [] as Array<{ id: number; channel_id: string; channel_name: string | null }>))
const mockUpdateChannelRequestName = vi.hoisted(() => vi.fn())
vi.mock('../db.js', () => ({
  upsertChannelRequest: mockUpsertChannelRequest,
  listPendingChannelRequests: mockListPendingChannelRequests,
  updateChannelRequestName: mockUpdateChannelRequestName,
}))

vi.mock('../tool-timeouts.js', () => ({
  TOOL_TIMEOUTS: { slack: 10_000 },
}))

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal('fetch', mockFetch)

function auditLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry) + '\n'
}

const DROP_ENTRY = {
  type: 'gate.inbound.drop',
  reason: 'channel-not-allowed',
  channel: 'C123',
  user: 'U456',
  botMentioned: true,
}

let startChannelRequestWatcher: (intervalMs?: number) => void
let stopChannelRequestWatcher: () => void

// Fresh module instance per test (see file header): only resets mocks +
// re-imports. Timer mode is chosen per describe block below.
beforeEach(async () => {
  vi.resetModules()
  mockExistsSync.mockReset().mockReturnValue(false)
  mockReadFileSync.mockReset().mockReturnValue(Buffer.from(''))
  mockLoggerInfo.mockClear()
  mockLoggerWarn.mockClear()
  mockListAgentNames.mockReset().mockReturnValue([])
  mockReadAgentChannelProvider.mockReset().mockReturnValue(null)
  mockAgentDir.mockClear()
  mockChannelStateDir.mockClear()
  mockReadChannelToken.mockReset().mockReturnValue(null)
  mockUpsertChannelRequest.mockReset().mockReturnValue(true)
  mockListPendingChannelRequests.mockReset().mockReturnValue([])
  mockUpdateChannelRequestName.mockClear()
  mockFetch.mockReset()

  const mod = await import('../web/channel-request-watcher.js')
  startChannelRequestWatcher = mod.startChannelRequestWatcher
  stopChannelRequestWatcher = mod.stopChannelRequestWatcher
})

describe('channel-request-watcher: start/stop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    stopChannelRequestWatcher()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('runs a scan tick immediately on start', () => {
    mockListAgentNames.mockReturnValue(['agent-a'])
    startChannelRequestWatcher()
    expect(mockListAgentNames).toHaveBeenCalledTimes(1)
  })

  it('does not start a second interval when already running', () => {
    startChannelRequestWatcher()
    startChannelRequestWatcher()
    expect(mockListAgentNames).toHaveBeenCalledTimes(1)
  })

  it('re-scans on each interval tick', () => {
    startChannelRequestWatcher(5_000)
    vi.advanceTimersByTime(5_000)
    vi.advanceTimersByTime(5_000)
    expect(mockListAgentNames).toHaveBeenCalledTimes(3)
  })

  it('stops scanning after stopChannelRequestWatcher', () => {
    startChannelRequestWatcher(5_000)
    stopChannelRequestWatcher()
    vi.advanceTimersByTime(20_000)
    expect(mockListAgentNames).toHaveBeenCalledTimes(1)
  })

  it('is a no-op to stop when never started', () => {
    expect(() => stopChannelRequestWatcher()).not.toThrow()
  })

  it('logs the interval on start', () => {
    startChannelRequestWatcher(15_000)
    expect(mockLoggerInfo).toHaveBeenCalledWith({ intervalMs: 15_000 }, 'Channel request watcher started')
  })
})

describe('channel-request-watcher: agent provider filtering', () => {
  afterEach(() => {
    stopChannelRequestWatcher()
  })

  it('skips agents whose resolved provider is not slack', () => {
    mockListAgentNames.mockReturnValue(['tg-agent'])
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    startChannelRequestWatcher()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('falls back to the global CHANNEL_PROVIDER when the agent has no override', () => {
    mockListAgentNames.mockReturnValue(['default-agent'])
    mockReadAgentChannelProvider.mockReturnValue(null)
    startChannelRequestWatcher()
    // global CHANNEL_PROVIDER is mocked to 'telegram' -> not slack -> skipped
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('scans agents whose provider resolves to slack', () => {
    mockListAgentNames.mockReturnValue(['slack-agent'])
    mockReadAgentChannelProvider.mockReturnValue('slack')
    mockExistsSync.mockReturnValue(false)
    startChannelRequestWatcher()
    expect(mockChannelStateDir).toHaveBeenCalledWith('slack', '/agents/slack-agent')
    expect(mockExistsSync).toHaveBeenCalledWith('/agents/slack-agent/channel-state/audit.jsonl')
  })
})

describe('channel-request-watcher: scanAuditLog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockListAgentNames.mockReturnValue(['slack-agent'])
    mockReadAgentChannelProvider.mockReturnValue('slack')
  })
  afterEach(() => {
    stopChannelRequestWatcher()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does nothing when the audit file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    startChannelRequestWatcher()
    expect(mockReadFileSync).not.toHaveBeenCalled()
    expect(mockUpsertChannelRequest).not.toHaveBeenCalled()
  })

  it('records a new pending request on a matching drop line', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from(auditLine(DROP_ENTRY)))
    mockUpsertChannelRequest.mockReturnValue(true)
    startChannelRequestWatcher()
    expect(mockUpsertChannelRequest).toHaveBeenCalledWith('slack-agent', 'C123', 'U456')
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { agent: 'slack-agent', channel: 'C123', user: 'U456' },
      'New channel request from audit log'
    )
  })

  it('does not log a new-request line when the request already existed', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from(auditLine(DROP_ENTRY)))
    mockUpsertChannelRequest.mockReturnValue(false)
    startChannelRequestWatcher()
    expect(mockUpsertChannelRequest).toHaveBeenCalled()
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.anything(),
      'New channel request from audit log'
    )
  })

  it('ignores lines with a non-matching type', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from(auditLine({ type: 'gate.inbound.allow' })))
    startChannelRequestWatcher()
    expect(mockUpsertChannelRequest).not.toHaveBeenCalled()
  })

  it('ignores drop entries where the bot was not mentioned', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from(auditLine({ ...DROP_ENTRY, botMentioned: false })))
    startChannelRequestWatcher()
    expect(mockUpsertChannelRequest).not.toHaveBeenCalled()
  })

  it('ignores malformed JSON lines without crashing', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from('{not json\n' + auditLine(DROP_ENTRY)))
    expect(() => startChannelRequestWatcher()).not.toThrow()
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(1)
  })

  it('skips blank lines', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from('\n\n' + auditLine(DROP_ENTRY) + '\n'))
    startChannelRequestWatcher()
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(1)
  })

  it('only processes bytes appended since the last scan', () => {
    mockExistsSync.mockReturnValue(true)
    const first = auditLine(DROP_ENTRY)
    mockReadFileSync.mockReturnValue(Buffer.from(first))
    startChannelRequestWatcher(5_000)
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(1)

    // Same buffer (no growth) on the next tick -> nothing new processed.
    vi.advanceTimersByTime(5_000)
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(1)

    // File grew -> only the appended tail is scanned.
    const second = { ...DROP_ENTRY, channel: 'C999' }
    mockReadFileSync.mockReturnValue(Buffer.from(first + auditLine(second)))
    vi.advanceTimersByTime(5_000)
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(2)
    expect(mockUpsertChannelRequest).toHaveBeenLastCalledWith('slack-agent', 'C999', 'U456')
  })

  it('drops stale file offsets for agents no longer active', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from(auditLine(DROP_ENTRY)))
    startChannelRequestWatcher(5_000)
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(1)

    // Agent disappears for a tick, then comes back with the same audit path.
    mockListAgentNames.mockReturnValue([])
    vi.advanceTimersByTime(5_000)

    mockListAgentNames.mockReturnValue(['slack-agent'])
    vi.advanceTimersByTime(5_000)
    // Offset was cleared while the agent was inactive, so the same buffer
    // content is treated as new again.
    expect(mockUpsertChannelRequest).toHaveBeenCalledTimes(2)
  })
})

describe('channel-request-watcher: lookupChannelName', () => {
  beforeEach(() => {
    mockListAgentNames.mockReturnValue(['slack-agent'])
    mockReadAgentChannelProvider.mockReturnValue('slack')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(Buffer.from(''))
  })
  afterEach(() => {
    stopChannelRequestWatcher()
  })

  it('does not fetch when the pending request agent is not on slack', () => {
    mockReadAgentChannelProvider.mockReturnValue('telegram')
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'C1', channel_name: null }])
    startChannelRequestWatcher()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('does not fetch when there is no channel token', async () => {
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'C1', channel_name: null }])
    mockReadChannelToken.mockReturnValue(null)
    startChannelRequestWatcher()
    await vi.waitFor(() => expect(mockReadChannelToken).toHaveBeenCalled())
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('skips pending requests that already have a resolved name', () => {
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'C1', channel_name: 'general' }])
    mockReadChannelToken.mockReturnValue('xoxb-token')
    startChannelRequestWatcher()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('resolves and stores the channel name on a successful lookup', async () => {
    mockListPendingChannelRequests.mockReturnValue([{ id: 42, channel_id: 'C1', channel_name: null }])
    mockReadChannelToken.mockReturnValue('xoxb-token')
    mockFetch.mockResolvedValue({
      json: async () => ({ ok: true, channel: { name: 'general' } }),
    })
    startChannelRequestWatcher()
    await vi.waitFor(() => expect(mockUpdateChannelRequestName).toHaveBeenCalled())
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/conversations.info',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-token' }),
        body: 'channel=C1',
      })
    )
    expect(mockUpdateChannelRequestName).toHaveBeenCalledWith(42, 'general')
  })

  it('does not update when the API response has no matching pending row', async () => {
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'OTHER', channel_name: null }])
    mockReadChannelToken.mockReturnValue('xoxb-token')
    mockFetch.mockResolvedValue({ json: async () => ({ ok: true, channel: { name: 'general' } }) })
    startChannelRequestWatcher()
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(mockUpdateChannelRequestName).not.toHaveBeenCalled()
  })

  it('caches a negative result and logs a warning when the fetch throws', async () => {
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'C-ERR', channel_name: null }])
    mockReadChannelToken.mockReturnValue('xoxb-token')
    mockFetch.mockRejectedValue(new Error('network down'))
    startChannelRequestWatcher()
    await vi.waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled())
    expect(mockUpdateChannelRequestName).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'slack-agent', channelId: 'C-ERR' }),
      'Failed to look up Slack channel name'
    )
  })

  it('does not update when the response is not ok', async () => {
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'C-NOTOK', channel_name: null }])
    mockReadChannelToken.mockReturnValue('xoxb-token')
    mockFetch.mockResolvedValue({ json: async () => ({ ok: false }) })
    startChannelRequestWatcher()
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(mockUpdateChannelRequestName).not.toHaveBeenCalled()
  })

  it('does not re-fetch a channel id within the positive cache TTL', async () => {
    vi.useFakeTimers()
    // The pending-request mock never reflects the DB write, so the same
    // "unresolved" row is handed back on every tick -- the module's own
    // in-memory cache is what must stop the second fetch.
    mockListPendingChannelRequests.mockReturnValue([{ id: 1, channel_id: 'C-CACHED', channel_name: null }])
    mockReadChannelToken.mockReturnValue('xoxb-token')
    mockFetch.mockResolvedValue({ json: async () => ({ ok: true, channel: { name: 'general' } }) })

    startChannelRequestWatcher(5_000)
    // Wait for the whole async chain, including the cache write, which
    // happens just before this call -- not just for fetch to have been
    // invoked, which races the next tick below.
    await vi.waitFor(() => expect(mockUpdateChannelRequestName).toHaveBeenCalledTimes(1))
    expect(mockFetch).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000)
    await vi.waitFor(() => expect(mockListAgentNames).toHaveBeenCalledTimes(2))

    expect(mockFetch).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

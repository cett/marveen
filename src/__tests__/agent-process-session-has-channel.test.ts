// Coverage for agentHasChannel (src/web/agent-process-session.ts), previously
// untested. All of its direct dependencies (resolveAgentProvider, agentDir,
// channelStateDir, readChannelToken, parseTelegramToken) are mocked so the
// function's own branching -- token-present short-circuit, telegram fallback,
// non-telegram no-fallback -- is exercised in isolation.
import { describe, it, expect, vi } from 'vitest'

const mockResolveAgentProvider = vi.hoisted(() => vi.fn())
const mockAgentDir = vi.hoisted(() => vi.fn((name: string) => `/agents/${name}`))
const mockChannelStateDir = vi.hoisted(() => vi.fn((provider: string, dir?: string) => `${dir}/.claude/channels/${provider}`))
const mockReadChannelToken = vi.hoisted(() => vi.fn())
const mockParseTelegramToken = vi.hoisted(() => vi.fn())

vi.mock('../web/agent-process-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process-config.js')>()
  return { ...actual, resolveAgentProvider: mockResolveAgentProvider }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: mockAgentDir }
})
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...actual, channelStateDir: mockChannelStateDir, readChannelToken: mockReadChannelToken }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...actual, parseTelegramToken: mockParseTelegramToken }
})

import { agentHasChannel } from '../web/agent-process-session.js'

describe('agentHasChannel', () => {
  it('true when a channel token file is present, regardless of provider', () => {
    mockResolveAgentProvider.mockReturnValue('slack')
    mockReadChannelToken.mockReturnValue('xoxb-token')
    expect(agentHasChannel('alice')).toBe(true)
    expect(mockParseTelegramToken).not.toHaveBeenCalled()
  })

  it('telegram fallback: no token file, but a legacy .env token exists', () => {
    mockResolveAgentProvider.mockReturnValue('telegram')
    mockReadChannelToken.mockReturnValue(null)
    mockParseTelegramToken.mockReturnValue('123:legacy-token')
    expect(agentHasChannel('bob')).toBe(true)
  })

  it('telegram, no token file, no legacy token -> false', () => {
    mockResolveAgentProvider.mockReturnValue('telegram')
    mockReadChannelToken.mockReturnValue(null)
    mockParseTelegramToken.mockReturnValue(null)
    expect(agentHasChannel('carol')).toBe(false)
  })

  it('non-telegram provider with no token file -> false without a telegram fallback attempt', () => {
    mockResolveAgentProvider.mockReturnValue('discord')
    mockReadChannelToken.mockReturnValue(null)
    expect(agentHasChannel('erin')).toBe(false)
    expect(mockParseTelegramToken).not.toHaveBeenCalled()
  })
})

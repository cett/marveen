import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSendMessage, mockFormatMessage, mockSplitMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockFormatMessage: vi.fn().mockImplementation((t: string) => t),
  mockSplitMessage: vi.fn().mockImplementation((t: string) => [t]),
}))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    CHANNEL_TOKEN: 'test-bot-token',
    CHANNEL_CHAT_ID: '12345',
    CHANNEL_PROVIDER: 'telegram',
  }
})

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    getProvider: vi.fn().mockReturnValue({
      sendMessage: mockSendMessage,
      formatMessage: mockFormatMessage,
      splitMessage: mockSplitMessage,
    }),
  }
})

import { notifyChannel, notifySecurityEvent, deliverToChannel } from '../notify.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockSendMessage.mockResolvedValue({ ok: true })
  mockFormatMessage.mockImplementation((t: string) => t)
  mockSplitMessage.mockImplementation((t: string) => [t])
})

describe('notifyChannel', () => {
  it('sends a message when token and chat_id are configured', async () => {
    await notifyChannel('hello world')
    expect(mockSendMessage).toHaveBeenCalledWith('test-bot-token', '12345', 'hello world', 'HTML')
  })

  it('splits long messages and sends each chunk', async () => {
    mockSplitMessage.mockReturnValue(['chunk1', 'chunk2'])
    await notifyChannel('long text')
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('falls back to plain text on send error', async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error('formatted send failed'))
      .mockResolvedValue({ ok: true })
    await notifyChannel('fallback test')
    // Second call is the fallback plain text send
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('silently gives up when both sends fail', async () => {
    mockSendMessage.mockRejectedValue(new Error('all sends failed'))
    await expect(notifyChannel('totally broken')).resolves.toBeUndefined()
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })
})

describe('deliverToChannel', () => {
  it('is true when every part was sent', async () => {
    mockSplitMessage.mockReturnValue(['chunk1', 'chunk2'])
    await expect(deliverToChannel('long text')).resolves.toBe(true)
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('is true when the formatted send failed but the plain-text retry went through', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('formatted send failed')).mockResolvedValue({ ok: true })
    await expect(deliverToChannel('fallback test')).resolves.toBe(true)
  })

  it('is false when both the formatted send and the retry fail, and does not throw', async () => {
    mockSendMessage.mockRejectedValue(new Error('all sends failed'))
    await expect(deliverToChannel('totally broken')).resolves.toBe(false)
  })

  it('is false when only one of several parts is lost', async () => {
    mockSplitMessage.mockReturnValue(['chunk1', 'chunk2'])
    // chunk1 ok; chunk2 and its retry fail
    mockSendMessage
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('chunk2 failed'))
      .mockRejectedValueOnce(new Error('chunk2 retry failed'))
    await expect(deliverToChannel('two parts')).resolves.toBe(false)
  })
})

describe('deliverToChannel without a channel', () => {
  it('is false and sends nothing when token or chat id is missing', async () => {
    vi.resetModules()
    vi.doMock('../config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../config.js')>()
      return { ...actual, CHANNEL_TOKEN: '', CHANNEL_CHAT_ID: '', CHANNEL_PROVIDER: 'telegram' }
    })
    const fresh = await import('../notify.js')
    await expect(fresh.deliverToChannel('nobody to tell')).resolves.toBe(false)
    expect(mockSendMessage).not.toHaveBeenCalled()
    vi.doUnmock('../config.js')
    vi.resetModules()
  })
})

describe('notifySecurityEvent', () => {
  it('sends notification when channel is configured', async () => {
    await notifySecurityEvent('security alert')
    expect(mockSendMessage).toHaveBeenCalled()
  })

  it('does not throw when notifyChannel itself throws', async () => {
    mockSendMessage.mockRejectedValue(new Error('channel dead'))
    await expect(notifySecurityEvent('alert')).resolves.toBeUndefined()
  })
})

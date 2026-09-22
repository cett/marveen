import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setLastInboundModality,
  getLastInboundModality,
  clearLastInboundModality,
} from '../web/voice-modality.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => vi.useRealTimers())

describe('voice modality tracking', () => {
  it('returns null when nothing was recorded', () => {
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })

  it('returns the recorded modality within the TTL', () => {
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    vi.setSystemTime(5 * 60 * 1000)
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('voice')
  })

  it('expires the entry after the TTL and removes it', () => {
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    vi.setSystemTime(10 * 60 * 1000 + 1)
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
    // Second read after expiry must also be null (entry was deleted, not just skipped).
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })

  it('keys entries per (agentId, chatId), numeric and string chatId are distinct from a different agent', () => {
    setLastInboundModality('agent-a', 42, 'voice')
    setLastInboundModality('agent-b', 42, 'text')
    expect(getLastInboundModality('agent-a', 42)).toBe('voice')
    expect(getLastInboundModality('agent-b', 42)).toBe('text')
  })

  it('clearLastInboundModality removes the entry immediately', () => {
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    clearLastInboundModality('agent-a', 'chat-1')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })

  it('clear is a no-op when nothing was recorded', () => {
    expect(() => clearLastInboundModality('agent-x', 'chat-y')).not.toThrow()
  })

  it('a later write overwrites the earlier recorded modality', () => {
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    setLastInboundModality('agent-a', 'chat-1', 'text')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('text')
  })
})

import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  markMessageRefused,
  markMessageNoSession,
  markMessageDelivered,
  getAgentMessage,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') }) // fresh, isolated schema'd DB

// Refused_reason / no_session_at are additive
// columns on agent_messages, not a widened status CHECK -- a refusal
// persists as status='failed' plus refused_reason, and no_session_at is a
// timestamp on an otherwise still-pending row.
describe('markMessageRefused', () => {
  it('sets status=failed and refused_reason, distinct from a plain failure', () => {
    const msg = createAgentMessage('agent-a', 'agent-b', 'do the thing')
    expect(markMessageRefused(msg.id, 'not my job')).toBe(true)
    const row = getAgentMessage(msg.id)
    expect(row?.status).toBe('failed')
    expect(row?.refused_reason).toBe('not my job')
    expect(row?.completed_at).not.toBeNull()
  })

  it('returns false for a non-existent id', () => {
    expect(markMessageRefused(999999999, 'nope')).toBe(false)
  })
})

describe('markMessageNoSession', () => {
  it('stamps no_session_at on a pending row without changing its status', () => {
    const msg = createAgentMessage('agent-a', 'agent-c', 'ping')
    expect(markMessageNoSession(msg.id)).toBe(true)
    const row = getAgentMessage(msg.id)
    expect(row?.status).toBe('pending')
    expect(row?.no_session_at).not.toBeNull()
  })

  it('keeps the FIRST timestamp on repeated calls (COALESCE)', () => {
    const msg = createAgentMessage('agent-a', 'agent-d', 'ping again')
    markMessageNoSession(msg.id)
    const first = getAgentMessage(msg.id)?.no_session_at
    markMessageNoSession(msg.id)
    const second = getAgentMessage(msg.id)?.no_session_at
    expect(second).toBe(first)
  })

  it('is a no-op once the row is no longer pending', () => {
    const msg = createAgentMessage('agent-a', 'agent-e', 'ping once more')
    expect(markMessageDelivered(msg.id)).toBe(true)
    expect(markMessageNoSession(msg.id)).toBe(false)
    expect(getAgentMessage(msg.id)?.no_session_at).toBeNull()
  })
})

// envelope is a plain additive column, same shape as
// refused_reason/no_session_at above -- round-trip it against the real db.
describe('createAgentMessage envelope', () => {
  it('is null when not passed', () => {
    const msg = createAgentMessage('agent-a', 'agent-b', 'no envelope here')
    expect(msg.envelope).toBeNull()
    expect(getAgentMessage(msg.id)?.envelope).toBeNull()
  })

  it('persists a passed envelope string on both the return value and the live row', () => {
    const msg = createAgentMessage('agent-a', 'agent-b', 'with envelope', null, null, 'default', '{"branch":"feat/x"}')
    expect(msg.envelope).toBe('{"branch":"feat/x"}')
    expect(getAgentMessage(msg.id)?.envelope).toBe('{"branch":"feat/x"}')
  })
})

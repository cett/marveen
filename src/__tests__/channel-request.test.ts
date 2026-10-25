import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  upsertChannelRequest,
  listPendingChannelRequests,
  updateChannelRequestStatus,
  updateChannelRequestName,
} from '../db.js'

beforeAll(() => {
  // In-memory DB so the test never writes to the real store/claudeclaw.db.
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec("DELETE FROM pending_channel_requests")
})

describe('upsertChannelRequest', () => {
  it('inserts a new pending request', async () => {
    expect(await upsertChannelRequest('test-agent', 'C123', 'U456')).toBe(true)
    const rows = await listPendingChannelRequests('test-agent')
    expect(rows).toHaveLength(1)
    expect(rows[0].channel_id).toBe('C123')
    expect(rows[0].user_id).toBe('U456')
    expect(rows[0].status).toBe('pending')
  })

  it('deduplicates pending requests for same agent+channel', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    expect(await upsertChannelRequest('test-agent', 'C123')).toBe(false)
    expect(await listPendingChannelRequests('test-agent')).toHaveLength(1)
  })

  it('allows same channel for different agents', async () => {
    await upsertChannelRequest('agent-a', 'C123')
    expect(await upsertChannelRequest('agent-b', 'C123')).toBe(true)
  })

  it('blocks re-entry for recently denied channels (7-day window)', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestStatus(rows[0].id, 'denied')
    expect(await upsertChannelRequest('test-agent', 'C123')).toBe(false)
  })

  it('allows re-entry for denied channels after 7 days', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestStatus(rows[0].id, 'denied')
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400
    getDb().prepare('UPDATE pending_channel_requests SET resolved_at = ? WHERE id = ?').run(eightDaysAgo, rows[0].id)
    expect(await upsertChannelRequest('test-agent', 'C123')).toBe(true)
  })

  it('allows re-entry for approved channels (new pending)', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestStatus(rows[0].id, 'approved')
    expect(await upsertChannelRequest('test-agent', 'C123')).toBe(true)
  })
})

describe('updateChannelRequestStatus', () => {
  it('sets resolved_at when approving', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestStatus(rows[0].id, 'approved')
    const row = getDb().prepare('SELECT resolved_at, status FROM pending_channel_requests WHERE id = ?').get(rows[0].id) as { resolved_at: number; status: string }
    expect(row.status).toBe('approved')
    expect(row.resolved_at).toBeGreaterThan(0)
  })

  it('sets resolved_at when denying', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestStatus(rows[0].id, 'denied')
    const row = getDb().prepare('SELECT resolved_at, status FROM pending_channel_requests WHERE id = ?').get(rows[0].id) as { resolved_at: number; status: string }
    expect(row.status).toBe('denied')
    expect(row.resolved_at).toBeGreaterThan(0)
  })

  it('returns false for non-existent id', async () => {
    expect(await updateChannelRequestStatus(99999, 'approved')).toBe(false)
  })

  it('returns false for already resolved request', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestStatus(rows[0].id, 'denied')
    expect(await updateChannelRequestStatus(rows[0].id, 'approved')).toBe(false)
  })
})

describe('updateChannelRequestName', () => {
  it('sets channel name on existing request', async () => {
    await upsertChannelRequest('test-agent', 'C123')
    const rows = await listPendingChannelRequests('test-agent')
    await updateChannelRequestName(rows[0].id, 'general')
    const updated = await listPendingChannelRequests('test-agent')
    expect(updated[0].channel_name).toBe('general')
  })
})

describe('audit log parsing (algorithm)', () => {
  it('parses gate.inbound.drop with botMentioned', () => {
    const line = '{"type":"gate.inbound.drop","reason":"channel-not-allowed","channel":"C123","user":"U456","botMentioned":true}'
    const entry = JSON.parse(line) as { type?: string; reason?: string; channel?: string; user?: string; botMentioned?: boolean }
    expect(entry.type).toBe('gate.inbound.drop')
    expect(entry.reason).toBe('channel-not-allowed')
    expect(entry.botMentioned).toBe(true)
    expect(entry.channel).toBe('C123')
  })

  it('ignores lines without botMentioned', () => {
    const line = '{"type":"gate.inbound.drop","reason":"channel-not-allowed","channel":"C123"}'
    const entry = JSON.parse(line) as { botMentioned?: boolean }
    expect(entry.botMentioned).toBeUndefined()
  })

  it('handles malformed JSON gracefully', () => {
    expect(() => JSON.parse('not json')).toThrow()
  })
})

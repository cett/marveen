// Tokens per card. The assignee's token rows inside the
// card's in_progress windows (from kanban_card_events), per model, with the
// overlap with the agent's other in_progress cards stated, never split.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, createKanbanCard } from '../db.js'
import { inProgressWindows, getCardTokenUsage, tokenAgentForAssignee } from '../web/card-token-usage.js'

const OPTS = { botName: 'Orin', mainAgentId: 'orin', now: 10_000 }

function event(cardId: string, from: string | null, to: string, at: number): void {
  getDb().prepare(
    'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(cardId, from, to, 'test', at)
}

let seq = 0
function tokens(agent: string, at: number, input: number, output: number, model = 'claude-opus'): void {
  getDb().prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)
  `).run(agent, `s${seq++}`, at, input, output, model)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('inProgressWindows', () => {
  it('opens on in_progress, closes on the next move out, an open window runs to now', () => {
    expect(inProgressWindows([
      { from_status: 'planned', to_status: 'in_progress', created_at: 100 },
      { from_status: 'in_progress', to_status: 'waiting', created_at: 200 },
      { from_status: 'waiting', to_status: 'in_progress', created_at: 300 },
    ], 1000)).toEqual([{ from: 100, to: 200 }, { from: 300, to: 1000 }])
  })

  it('a card never in_progress has no window', () => {
    expect(inProgressWindows([{ from_status: 'planned', to_status: 'done', created_at: 100 }], 1000)).toEqual([])
  })
})

describe('tokenAgentForAssignee', () => {
  it('lowercases, maps the bot name to the main agent id, empty is null', () => {
    expect(tokenAgentForAssignee('Dex', OPTS)).toBe('dex')
    expect(tokenAgentForAssignee('Orin', OPTS)).toBe('orin')
    expect(tokenAgentForAssignee('', OPTS)).toBeNull()
    expect(tokenAgentForAssignee(null, OPTS)).toBeNull()
  })
})

describe('getCardTokenUsage', () => {
  it('sums only the rows inside the windows, per model', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'Dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'done', 200)
    tokens('dex', 50, 1000, 10) // before
    tokens('dex', 120, 300, 30)
    tokens('dex', 150, 200, 20, 'claude-sonnet')
    tokens('dex', 250, 1000, 10) // after
    tokens('zara', 150, 999, 99) // another agent
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.agent).toBe('dex')
    expect(u.totalCalls).toBe(2)
    expect(u.outputTokens).toBe(50)
    expect(u.totalTokens).toBe(550)
    expect(u.perModel.map((m) => m.model)).toEqual(['claude-opus', 'claude-sonnet'])
    expect(u.overlappingCards).toBe(0)
    expect(u.dataUntil).toBe(250)
  })

  it('counts the other in_progress cards of the same agent, without splitting', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    createKanbanCard({ id: 'c2', title: 'Other', assignee: 'Dex' })
    createKanbanCard({ id: 'c3', title: 'Later', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'done', 200)
    event('c2', 'planned', 'in_progress', 150)
    event('c3', 'planned', 'in_progress', 300)
    tokens('dex', 160, 100, 10)
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.overlappingCards).toBe(1)
    expect(u.totalTokens).toBe(110)
  })

  it('the bot-named main agent card reads the main agent rows', () => {
    createKanbanCard({ id: 'c1', title: 'Main', assignee: 'Orin' })
    event('c1', 'planned', 'in_progress', 100)
    tokens('orin', 150, 10, 5)
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.agent).toBe('orin')
    expect(u.windows).toEqual([{ from: 100, to: 10_000 }])
    expect(u.totalCalls).toBe(1)
  })

  it('no assignee or never in_progress: empty, no crash; missing card is null', () => {
    createKanbanCard({ id: 'c1', title: 'Nobody' })
    expect(getCardTokenUsage('c1', OPTS)!.agent).toBeNull()
    createKanbanCard({ id: 'c2', title: 'Idle', assignee: 'dex' })
    const u = getCardTokenUsage('c2', OPTS)!
    expect(u.windows).toEqual([])
    expect(u.totalCalls).toBe(0)
    expect(getCardTokenUsage('nope', OPTS)).toBeNull()
  })
})

describe('getCardTokenUsage breakdown', () => {
  it('splits fresh input from cache reads and drops zero-token model rows', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
      VALUES ('dex', 'x1', 120, 10, 5, 900, 40, 'claude-opus'), ('dex', 'x2', 130, 0, 0, 0, 0, '<synthetic>')
    `).run()
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.freshInputTokens).toBe(50)
    expect(u.cacheReadTokens).toBe(900)
    expect(u.totalTokens).toBe(955)
    expect(u.perModel.map((m) => m.model)).toEqual(['claude-opus'])
    expect(u.totalCalls).toBe(1)
  })
})

describe('getCardTokenUsage window boundaries', () => {
  it('a window is [from, to): a row at from counts, a row at to does not', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'done', 200)
    tokens('dex', 99, 1, 1)
    tokens('dex', 100, 10, 1) // at from: in
    tokens('dex', 199, 100, 1) // last second inside
    tokens('dex', 200, 1000, 1) // at to: out
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.totalCalls).toBe(2)
    expect(u.freshInputTokens).toBe(110)
  })

  it('a row on the boundary shared by two windows is counted once', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'waiting', 200)
    event('c1', 'waiting', 'in_progress', 200) // moved back in the same second
    event('c1', 'in_progress', 'done', 300)
    tokens('dex', 200, 10, 1)
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.windows).toEqual([{ from: 100, to: 200 }, { from: 200, to: 300 }])
    expect(u.totalCalls).toBe(1)
    expect(u.freshInputTokens).toBe(10)
  })

  it('an open window runs up to now, and a row at now is not in it yet', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    tokens('dex', 9_999, 10, 1)
    tokens('dex', 10_000, 1000, 1) // OPTS.now
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.windows).toEqual([{ from: 100, to: 10_000 }])
    expect(u.totalCalls).toBe(1)
    expect(u.freshInputTokens).toBe(10)
  })

  it('another card of the agent that only touches the window at its edge does not overlap; one second of overlap does', () => {
    createKanbanCard({ id: 'c1', title: 'This', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'done', 200)
    createKanbanCard({ id: 'before', title: 'Ends where this starts', assignee: 'dex' })
    event('before', 'planned', 'in_progress', 50)
    event('before', 'in_progress', 'done', 100)
    createKanbanCard({ id: 'after', title: 'Starts where this ends', assignee: 'dex' })
    event('after', 'planned', 'in_progress', 200)
    event('after', 'in_progress', 'done', 300)
    expect(getCardTokenUsage('c1', OPTS)!.overlappingCards).toBe(0)
    createKanbanCard({ id: 'one-second', title: 'One second inside', assignee: 'dex' })
    event('one-second', 'planned', 'in_progress', 199)
    event('one-second', 'in_progress', 'done', 400)
    expect(getCardTokenUsage('c1', OPTS)!.overlappingCards).toBe(1)
  })
})

describe('getCardTokenUsage expired data', () => {
  // now = 10 days, retention 7 days: the raw log starts at day 3 (259_200 s).
  const DAY = 86_400
  const NOW = 10 * DAY
  const CUT = 3 * DAY

  it('a window that starts before the retention cut-off is marked expired, with the retention it used', () => {
    createKanbanCard({ id: 'c1', title: 'Old', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', CUT - 1)
    event('c1', 'in_progress', 'done', CUT + 100)
    const u = getCardTokenUsage('c1', { ...OPTS, now: NOW, retentionDays: 7 })!
    expect(u.dataExpired).toBe(true)
    expect(u.retentionDays).toBe(7)
    expect(u.totalCalls).toBe(0) // the rows are gone, and that is not a measurement
  })

  it('a window that starts exactly at the cut-off is not expired (the prune keeps timestamp >= cut-off)', () => {
    createKanbanCard({ id: 'c1', title: 'Edge', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', CUT)
    tokens('dex', CUT, 10, 1)
    const u = getCardTokenUsage('c1', { ...OPTS, now: NOW, retentionDays: 7 })!
    expect(u.dataExpired).toBe(false)
    expect(u.totalCalls).toBe(1)
  })

  it('only one old window among several is enough; a card with no window is never expired', () => {
    createKanbanCard({ id: 'c1', title: 'Mixed', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', CUT - 50)
    event('c1', 'in_progress', 'waiting', CUT - 10)
    event('c1', 'waiting', 'in_progress', 9 * DAY)
    expect(getCardTokenUsage('c1', { ...OPTS, now: NOW, retentionDays: 7 })!.dataExpired).toBe(true)
    createKanbanCard({ id: 'c2', title: 'Never', assignee: 'dex' })
    expect(getCardTokenUsage('c2', { ...OPTS, now: NOW, retentionDays: 7 })!.dataExpired).toBe(false)
  })

  it('the flag comes from the windows alone, so a card with no assignee reports it too', () => {
    createKanbanCard({ id: 'c1', title: 'Nobody' })
    event('c1', 'planned', 'in_progress', CUT - 1)
    const u = getCardTokenUsage('c1', { ...OPTS, now: NOW, retentionDays: 7 })!
    expect(u.agent).toBeNull()
    expect(u.dataExpired).toBe(true)
  })

  it('an unusable retention setting never marks anything expired; the setting default is read when none is passed', () => {
    createKanbanCard({ id: 'c1', title: 'Old', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 1)
    expect(getCardTokenUsage('c1', { ...OPTS, now: NOW, retentionDays: null })!.dataExpired).toBe(false)
    // default 30 days: a window from second 1 is expired at a "now" 40 days on, not at 10 days
    expect(getCardTokenUsage('c1', { ...OPTS, now: 40 * DAY })!.dataExpired).toBe(true)
    expect(getCardTokenUsage('c1', { ...OPTS, now: NOW })!.dataExpired).toBe(false)
    expect(getCardTokenUsage('c1', { ...OPTS, now: 40 * DAY })!.retentionDays).toBe(30)
  })
})

// "Time in progress" on the card detail: the pure computation from the card's own
// status-change log (web/modules/kanban-active-time.js), the opening event row a
// card born outside 'planned' gets, and the panel wiring (string-grep contract,
// like the other kanban UI tests).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sumInProgressSeconds, formatActiveTime } from '../../web/modules/kanban-active-time.js'
import { initDatabase, createKanbanCard, moveKanbanCard, getKanbanCardEvents } from '../db.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const ev = (to_status: string, created_at: number, id?: number) => ({ to_status, created_at, id })

describe('sumInProgressSeconds', () => {
  it('no events: not measured (null), which is not a measured zero', () => {
    expect(sumInProgressSeconds([], 1000)).toBeNull()
  })

  it('moved, but never in progress: a measured zero', () => {
    expect(sumInProgressSeconds([ev('waiting', 100), ev('done', 200)], 1000)).toBe(0)
  })

  it('a closed stay is charged from its opening to the next event', () => {
    expect(sumInProgressSeconds([ev('in_progress', 100), ev('done', 460)], 9999)).toBe(360)
  })

  it('sums several separate stays', () => {
    const events = [ev('in_progress', 100), ev('waiting', 200), ev('in_progress', 300), ev('testing', 350), ev('in_progress', 400), ev('done', 410)]
    expect(sumInProgressSeconds(events, 9999)).toBe(100 + 50 + 10)
  })

  it('an open stay of a card that is in progress now runs to the present', () => {
    expect(sumInProgressSeconds([ev('in_progress', 100)], 1000, { status: 'in_progress', updated_at: 100 })).toBe(900)
    expect(sumInProgressSeconds([ev('planned', 50), ev('in_progress', 100)], 1000)).toBe(900)
  })

  it('an open stay of a card that is no longer in progress is closed at its last update, not charged up to now', () => {
    // the status was changed without a logged move (an edit of the card itself)
    expect(sumInProgressSeconds([ev('in_progress', 100)], 100000, { status: 'done', updated_at: 460 })).toBe(360)
  })

  it('orders the events itself: same-second events keep their id order, and input order is irrelevant', () => {
    const events = [ev('done', 200, 3), ev('in_progress', 100, 1), ev('waiting', 100, 2)]
    // in_progress opens at 100 and the same-second waiting (id 2) closes it at 100; done at 200 adds nothing
    expect(sumInProgressSeconds(events, 9999)).toBe(0)
  })

  it('two events into in_progress in a row keep one continuous stay', () => {
    expect(sumInProgressSeconds([ev('in_progress', 100), ev('in_progress', 200), ev('done', 300)], 9999)).toBe(200)
  })

  it('never goes negative on clock skew', () => {
    expect(sumInProgressSeconds([ev('in_progress', 500)], 400, { status: 'in_progress', updated_at: 500 })).toBe(0)
  })
})

describe('formatActiveTime', () => {
  const t = (key: string, vars: Record<string, unknown> = {}) =>
    `${key}${Object.keys(vars).length ? ':' + Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',') : ''}`

  it('null / undefined (not measured) has no text, so the caller shows "not measured"', () => {
    expect(formatActiveTime(null, t)).toBeNull()
    expect(formatActiveTime(undefined, t)).toBeNull()
  })

  it('a measured zero is its own text, not an empty minute count', () => {
    expect(formatActiveTime(0, t)).toBe('kanban.active.zero')
  })

  it('picks the unit by size', () => {
    expect(formatActiveTime(59, t)).toBe('kanban.active.m:m=0')
    expect(formatActiveTime(3 * 60 + 5, t)).toBe('kanban.active.m:m=3')
    expect(formatActiveTime(2 * 3600 + 15 * 60, t)).toBe('kanban.active.h_m:h=2,m=15')
    expect(formatActiveTime(3 * 86400 + 5 * 3600 + 1800, t)).toBe('kanban.active.d_h:d=3,h=5')
  })
})

describe('opening event row for a card created outside planned', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('a card created into in_progress gets an opening event with no from_status, so it is measurable', async () => {
    await createKanbanCard({ id: 'born-ip', title: 'Born in progress', status: 'in_progress', assignee: 'worker' })
    const events = await getKanbanCardEvents('born-ip')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ card_id: 'born-ip', from_status: null, to_status: 'in_progress', actor: 'worker' })
    expect(sumInProgressSeconds(events, events[0].created_at + 90, { status: 'in_progress' })).toBe(90)
  })

  it('a card created into planned gets none (the first move writes the first event)', async () => {
    await createKanbanCard({ id: 'born-planned', title: 'Planned card' })
    expect(await getKanbanCardEvents('born-planned')).toHaveLength(0)
    await moveKanbanCard('born-planned', 'in_progress', 0, 'worker')
    expect(await getKanbanCardEvents('born-planned')).toHaveLength(1)
  })

  it('a card created into waiting gets the opening event too, and it is a measured zero', async () => {
    await createKanbanCard({ id: 'born-wait', title: 'Waiting card', status: 'waiting' })
    const events = await getKanbanCardEvents('born-wait')
    expect(events.map((e) => e.to_status)).toEqual(['waiting'])
    expect(sumInProgressSeconds(events, events[0].created_at + 500)).toBe(0)
  })
})

describe('card detail wiring (string contract)', () => {
  const KANBAN_JS = readFileSync(join(ROOT, 'web/modules/kanban.js'), 'utf8')

  it('reads the card\'s own events endpoint, not a field on the list', () => {
    expect(KANBAN_JS).toContain('/events`')
    expect(KANBAN_JS).toContain("from './kanban-active-time.js'")
    expect(KANBAN_JS).not.toContain('active_seconds')
  })

  it('renders the meta item with a placeholder and fills it after the request, guarding against a re-render', () => {
    expect(KANBAN_JS).toContain('id="metaActiveValue"')
    expect(KANBAN_JS).toMatch(/if \(!el\.isConnected\) return/)
    expect(KANBAN_JS).toMatch(/\n  loadActiveTime\(card\)\n/)
  })

  it('both languages carry every key the panel uses', () => {
    const en = readFileSync(join(ROOT, 'web/lang/en.js'), 'utf8')
    const hu = readFileSync(join(ROOT, 'web/lang/hu.js'), 'utf8')
    for (const key of ['meta.active', 'active.loading', 'active.none', 'active.zero', 'active.d_h', 'active.h_m', 'active.m', 'active.tooltip', 'active.tooltip_none']) {
      expect(en, key).toContain(`'kanban.${key}':`)
      expect(hu, key).toContain(`'kanban.${key}':`)
    }
  })
})

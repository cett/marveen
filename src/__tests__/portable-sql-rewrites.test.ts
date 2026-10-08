import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  getDb,
  createAgentMessage,
  saveAgentMemory,
  upsertMemoryLink,
  addKanbanComment,
  createKanbanCard,
  seedScheduleIfAbsent,
  seedSkillIfAbsent,
  addLabelToCard,
  insertEgressAllowlistEntry,
} from '../db.js'

// SQLite-dialect rewrites for the PostgreSQL preparation:
//   INSERT OR IGNORE        -> INSERT ... ON CONFLICT DO NOTHING
//   .run().lastInsertRowid  -> INSERT ... RETURNING id
// ON CONFLICT DO NOTHING absorbs key conflicts only; INSERT OR IGNORE also
// swallowed NOT NULL and CHECK violations. The file-fed seed paths keep that
// "bad row is skipped" behaviour with an explicit guard, pinned here.

beforeAll(() => { initDatabase(':memory:') })

const seedOpts = {
  prompt: 'p', description: 'd', schedule: '0 * * * *', agent: 'agent-a',
  type: 'task' as const, enabled: true, tenant_id: null,
  skip_if_busy: false, force_send: false,
}

describe('RETURNING id replaces lastInsertRowid', () => {
  it('createAgentMessage returns the row id and ids increase', () => {
    const a = createAgentMessage('a', 'rw-' + Math.random(), 'x')
    const b = createAgentMessage('a', 'rw-' + Math.random(), 'y')
    expect(Number.isInteger(a.id)).toBe(true)
    expect(b.id).toBeGreaterThan(a.id)
    const row = getDb().prepare('SELECT content FROM agent_messages WHERE id = ?').get(b.id) as { content: string }
    expect(row.content).toBe('y')
  })

  it('addKanbanComment returns the id of the comment it wrote', () => {
    createKanbanCard({ id: 'rw-card', title: 'rw card' })
    const c = addKanbanComment('rw-card', 'someone', 'hello')
    const row = getDb().prepare('SELECT content FROM kanban_comments WHERE id = ?').get(c.id) as { content: string }
    expect(row.content).toBe('hello')
  })

  it('upsertMemoryLink returns the same id when the link is updated', () => {
    const m1 = saveAgentMemory('agent-a', 'link source', 'hot').id
    const m2 = saveAgentMemory('agent-a', 'link target', 'hot').id
    const first = upsertMemoryLink(m1, m2, 'semantic', 0.4)
    // An unrelated insert in between moves lastInsertRowid on; the upsert must
    // still report the link's own row.
    saveAgentMemory('agent-a', 'unrelated insert', 'hot')
    const again = upsertMemoryLink(m1, m2, 'semantic', 0.9)
    expect(again).toBe(first)
    const row = getDb().prepare('SELECT weight FROM memory_links WHERE id = ?').get(first) as { weight: number }
    expect(row.weight).toBe(0.9)
  })
})

describe('ON CONFLICT DO NOTHING keeps the insert-if-absent behaviour', () => {
  it('addLabelToCard twice leaves one row', () => {
    const db = getDb()
    createKanbanCard({ id: 'rw-label-card', title: 'label card' })
    db.prepare("INSERT INTO labels (id, name, color, created_at) VALUES ('rw-l', 'rw-l', '#fff', 1)").run()
    addLabelToCard('rw-label-card', 'rw-l')
    addLabelToCard('rw-label-card', 'rw-l')
    const n = db.prepare('SELECT COUNT(*) AS n FROM kanban_card_labels WHERE card_id = ?').get('rw-label-card') as { n: number }
    expect(n.n).toBe(1)
  })

  it('an egress allowlist entry added twice stays one row', () => {
    insertEgressAllowlistEntry({ value: 'rw.example.test', type: 'domain' })
    insertEgressAllowlistEntry({ value: 'rw.example.test', type: 'domain' })
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM egress_allowlist WHERE value = 'rw.example.test'").get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('seedScheduleIfAbsent inserts once and reports an existing row as false', () => {
    expect(seedScheduleIfAbsent('rw-sched', seedOpts)).toBe(true)
    expect(seedScheduleIfAbsent('rw-sched', { ...seedOpts, prompt: 'changed' })).toBe(false)
    const row = getDb().prepare("SELECT prompt FROM schedules WHERE id = 'rw-sched'").get() as { prompt: string }
    expect(row.prompt).toBe('p')
  })
})

describe('file-fed seeds still skip a row the table would reject', () => {
  it('a schedule with an unknown type is skipped, not thrown', () => {
    expect(seedScheduleIfAbsent('rw-bad-type', { ...seedOpts, type: 'weekly' as never })).toBe(false)
    expect(getDb().prepare("SELECT 1 FROM schedules WHERE id = 'rw-bad-type'").get()).toBeUndefined()
  })

  it('a schedule without a cron expression or agent is skipped', () => {
    expect(seedScheduleIfAbsent('rw-no-cron', { ...seedOpts, schedule: undefined as never })).toBe(false)
    expect(seedScheduleIfAbsent('rw-no-agent', { ...seedOpts, agent: undefined as never })).toBe(false)
  })

  it('a skill without a name or content is skipped', () => {
    const ok = { id: 'rw-skill', name: 'n', description: 'd', content: 'c', tenant_id: 'default', is_global: false }
    expect(seedSkillIfAbsent({ ...ok, id: 'rw-skill-1', name: undefined as never })).toBe(false)
    expect(seedSkillIfAbsent({ ...ok, id: 'rw-skill-2', content: undefined as never })).toBe(false)
    expect(seedSkillIfAbsent(ok)).toBe(true)
    expect(seedSkillIfAbsent(ok)).toBe(false)
  })
})

describe('fleet import: a row the table would reject is skipped', () => {
  it('breaksTableRules flags a missing NOT NULL column and an out-of-list CHECK value', async () => {
    const { breaksTableRules } = await import('../web/fleet-transfer.js')
    expect(breaksTableRules({ title: 'a', created_at: 1 }, ['title', 'created_at'])).toBe(false)
    expect(breaksTableRules({ title: 'a' }, ['title', 'created_at'])).toBe(true)
    expect(breaksTableRules({ created_at: null }, ['created_at'])).toBe(true)
    expect(breaksTableRules({ status: 'new' }, [], { status: ['new', 'done'] })).toBe(false)
    expect(breaksTableRules({ status: 'bogus' }, [], { status: ['new', 'done'] })).toBe(true)
    expect(breaksTableRules({}, [], { status: ['new'] })).toBe(true)
  })
})

// Tenant-scope wrapper contract tests.
//
// Verifies that scopeToTenant() enforces tenant isolation on all four core
// tables: reads return only the caller's tenant rows, writes are stamped with
// the caller's tenant_id, and cross-tenant access is structurally impossible.
//
// Runs against the real migrated schema (initDatabase(':memory:')), so the
// facade's SQL is checked against the production columns and constraints.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { scopeToTenant } from '../web/tenant-scope.js'

type TestDb = ReturnType<typeof getDb>

function openDb(): TestDb {
  initDatabase(':memory:')
  const db = getDb()
  for (const id of ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-new']) {
    db.prepare('INSERT OR IGNORE INTO tenants (id, display_name) VALUES (?, ?)').run(id, id)
  }
  return db
}

// ── memories ──────────────────────────────────────────────────────────────────

describe('scopeToTenant -- memories', () => {
  let db: TestDb

  beforeEach(() => {
    db = openDb()
    // Seed rows for two tenants
    db.exec(`
      INSERT INTO memories (chat_id, sector, created_at, accessed_at, agent_id, category, content, keywords, tenant_id)
        VALUES ('', 'semantic', 0, 0, 'agent-a', 'warm', 'mem-a-content', 'kw-a', 'tenant-a');
      INSERT INTO memories (chat_id, sector, created_at, accessed_at, agent_id, category, content, keywords, tenant_id)
        VALUES ('', 'semantic', 0, 0, 'agent-a', 'warm', 'mem-b-content', 'kw-b', 'tenant-b');
    `)
  })

  it('list returns only tenant-a rows', () => {
    const rows = scopeToTenant('tenant-a').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('mem-a-content')
    expect(rows[0]!.tenant_id).toBe('tenant-a')
  })

  it('list returns only tenant-b rows', () => {
    const rows = scopeToTenant('tenant-b').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('mem-b-content')
  })

  it('cross-tenant list returns 0 rows for unknown tenant', () => {
    const rows = scopeToTenant('tenant-c').memories.list('agent-a')
    expect(rows).toHaveLength(0)
  })

  it('category filter works within tenant', () => {
    db.exec(`INSERT INTO memories (chat_id, sector, created_at, accessed_at, agent_id, category, content, tenant_id)
      VALUES ('', 'semantic', 0, 0, 'agent-a', 'cold', 'cold-content', 'tenant-a')`)
    const warm = scopeToTenant('tenant-a').memories.list('agent-a', 'warm')
    expect(warm).toHaveLength(1)
    const cold = scopeToTenant('tenant-a').memories.list('agent-a', 'cold')
    expect(cold).toHaveLength(1)
  })

  it('get returns row only within correct tenant', () => {
    const scope = scopeToTenant('tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content') as { id: number }
    expect(scope.memories.get(row.id)).not.toBeNull()
  })

  it('get returns null for row in different tenant', () => {
    const scope = scopeToTenant('tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content') as { id: number }
    expect(scope.memories.get(row.id)).toBeNull()
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant('tenant-a').memories.insert('agent-a', 'hot', 'new-insert-content', 'new-kw')
    const row = db.prepare('SELECT tenant_id FROM memories WHERE content = ?').get('new-insert-content') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('insert into tenant-a is invisible to tenant-b', () => {
    scopeToTenant('tenant-a').memories.insert('agent-a', 'hot', 'hidden-content')
    const rows = scopeToTenant('tenant-b').memories.list('agent-a')
    expect(rows.find((r) => r.content === 'hidden-content')).toBeUndefined()
  })

  it('update patches only own-tenant row', () => {
    const scope = scopeToTenant('tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content') as { id: number }
    const changed = scope.memories.update(row.id, { category: 'cold' })
    expect(changed).toBe(true)
    const updated = db.prepare('SELECT category FROM memories WHERE id = ?').get(row.id) as { category: string }
    expect(updated.category).toBe('cold')
  })

  it('update cannot touch cross-tenant row', () => {
    const scopeA = scopeToTenant('tenant-a')
    const rowB = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content') as { id: number }
    const changed = scopeA.memories.update(rowB.id, { category: 'cold' })
    expect(changed).toBe(false)
    const untouched = db.prepare('SELECT category FROM memories WHERE id = ?').get(rowB.id) as { category: string }
    expect(untouched.category).toBe('warm')
  })

  it('delete removes only own-tenant row', () => {
    const scope = scopeToTenant('tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content') as { id: number }
    expect(scope.memories.delete(row.id)).toBe(true)
    expect(db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content')).toBeUndefined()
  })

  it('delete cannot remove cross-tenant row', () => {
    const scopeA = scopeToTenant('tenant-a')
    const rowB = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content') as { id: number }
    expect(scopeA.memories.delete(rowB.id)).toBe(false)
    expect(db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content')).toBeDefined()
  })
})

// ── kanban ────────────────────────────────────────────────────────────────────

describe('scopeToTenant -- kanban', () => {
  let db: TestDb

  beforeEach(() => {
    db = openDb()
    db.exec(`
      INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at) VALUES ('card-a', 'Task A', 'tenant-a', 0, 0);
      INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at) VALUES ('card-b', 'Task B', 'tenant-b', 0, 0);
    `)
  })

  it('list returns only tenant-a cards', () => {
    const cards = scopeToTenant('tenant-a').kanban.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe('card-a')
  })

  it('cross-tenant list returns 0 cards', () => {
    expect(scopeToTenant('tenant-c').kanban.list()).toHaveLength(0)
  })

  it('status filter works within tenant', () => {
    db.exec(`UPDATE kanban_cards SET status = 'done' WHERE id = 'card-a'`)
    const planned = scopeToTenant('tenant-a').kanban.list('planned')
    expect(planned).toHaveLength(0)
    const done = scopeToTenant('tenant-a').kanban.list('done')
    expect(done).toHaveLength(1)
  })

  it('list excludes archived cards by default', () => {
    db.exec(`UPDATE kanban_cards SET archived_at = 1700000000 WHERE id = 'card-a'`)
    expect(scopeToTenant('tenant-a').kanban.list()).toHaveLength(0)
  })

  it('list has no implicit row cap', () => {
    for (let i = 0; i < 250; i++) {
      db.prepare(`INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at) VALUES (?, ?, 'tenant-a', 0, 0)`).run(`bulk-${i}`, `Bulk ${i}`)
    }
    expect(scopeToTenant('tenant-a').kanban.list()).toHaveLength(251)
  })

  it('get returns card only in correct tenant', () => {
    expect(scopeToTenant('tenant-a').kanban.get('card-a')).not.toBeNull()
    expect(scopeToTenant('tenant-b').kanban.get('card-a')).toBeNull()
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant('tenant-a').kanban.insert('card-new', 'New Task')
    const row = db.prepare('SELECT tenant_id FROM kanban_cards WHERE id = ?').get('card-new') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('update only affects own-tenant card', () => {
    expect(scopeToTenant('tenant-a').kanban.update('card-a', { status: 'done' })).toBe(true)
    expect(scopeToTenant('tenant-a').kanban.update('card-b', { status: 'done' })).toBe(false)
    const b = db.prepare('SELECT status FROM kanban_cards WHERE id = ?').get('card-b') as { status: string }
    expect(b.status).toBe('planned')
  })

  it('delete only removes own-tenant card', () => {
    expect(scopeToTenant('tenant-a').kanban.delete('card-b')).toBe(false)
    expect(db.prepare('SELECT id FROM kanban_cards WHERE id = ?').get('card-b')).toBeDefined()
    expect(scopeToTenant('tenant-a').kanban.delete('card-a')).toBe(true)
    expect(db.prepare('SELECT id FROM kanban_cards WHERE id = ?').get('card-a')).toBeUndefined()
  })
})

// ── agentMessages ─────────────────────────────────────────────────────────────

describe('scopeToTenant -- agentMessages', () => {
  let db: TestDb

  beforeEach(() => {
    db = openDb()
    db.exec(`
      INSERT INTO agent_messages (from_agent, to_agent, content, tenant_id, created_at)
        VALUES ('agent-x', 'agent-y', 'msg-a', 'tenant-a', 0);
      INSERT INTO agent_messages (from_agent, to_agent, content, tenant_id, created_at)
        VALUES ('agent-x', 'agent-y', 'msg-b', 'tenant-b', 0);
    `)
  })

  it('listFor returns only tenant-a messages', () => {
    const msgs = scopeToTenant('tenant-a').agentMessages.listFor('agent-y')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toBe('msg-a')
  })

  it('cross-tenant listFor returns 0 messages', () => {
    expect(scopeToTenant('tenant-c').agentMessages.listFor('agent-y')).toHaveLength(0)
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant('tenant-a').agentMessages.insert('agent-x', 'agent-z', 'hello')
    const row = db
      .prepare('SELECT tenant_id FROM agent_messages WHERE content = ?')
      .get('hello') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('status filter works within tenant', () => {
    db.exec(`UPDATE agent_messages SET status = 'done' WHERE content = 'msg-a'`)
    const pending = scopeToTenant('tenant-a').agentMessages.listFor('agent-y', 'pending')
    expect(pending).toHaveLength(0)
    const done = scopeToTenant('tenant-a').agentMessages.listFor('agent-y', 'done')
    expect(done).toHaveLength(1)
  })
})

// ── importMemories ────────────────────────────────────────────────────────────

describe('scopeToTenant -- importMemories', () => {
  let db: TestDb

  beforeEach(() => {
    db = openDb()
    // import_memories.source_id is a foreign key into import_sources.
    for (const id of ['src-1', 'src-2']) {
      db.prepare(
        "INSERT INTO import_sources (id, type, path, created_at, updated_at) VALUES (?, 'local', '/p', 0, 0)",
      ).run(id)
    }
    db.exec(`
      INSERT INTO import_memories (id, source_id, file_path, content, tenant_id, file_name, content_hash, last_seen_at, created_at, updated_at)
        VALUES ('im-a', 'src-1', '/a.md', 'body-a', 'tenant-a', 'f', 'h', 0, 0, 0);
      INSERT INTO import_memories (id, source_id, file_path, content, tenant_id, file_name, content_hash, last_seen_at, created_at, updated_at)
        VALUES ('im-b', 'src-1', '/b.md', 'body-b', 'tenant-b', 'f', 'h', 0, 0, 0);
    `)
  })

  it('listForSource returns only tenant-a memories', () => {
    const rows = scopeToTenant('tenant-a').importMemories.listForSource('src-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('im-a')
  })

  it('cross-tenant listForSource returns 0 rows', () => {
    expect(scopeToTenant('tenant-c').importMemories.listForSource('src-1')).toHaveLength(0)
  })

  it('get returns record only in correct tenant', () => {
    expect(scopeToTenant('tenant-a').importMemories.get('im-a')).not.toBeNull()
    expect(scopeToTenant('tenant-a').importMemories.get('im-b')).toBeNull()
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant('tenant-a').importMemories.insert('im-new', 'src-2', '/new.md', 'body')
    const row = db
      .prepare('SELECT tenant_id FROM import_memories WHERE id = ?')
      .get('im-new') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('delete removes only own-tenant record', () => {
    expect(scopeToTenant('tenant-a').importMemories.delete('im-b')).toBe(false)
    expect(db.prepare('SELECT id FROM import_memories WHERE id = ?').get('im-b')).toBeDefined()
    expect(scopeToTenant('tenant-a').importMemories.delete('im-a')).toBe(true)
    expect(db.prepare('SELECT id FROM import_memories WHERE id = ?').get('im-a')).toBeUndefined()
  })
})

// ── default tenant backward-compat ───────────────────────────────────────────

describe('scopeToTenant -- default tenant backward-compat', () => {
  let db: TestDb

  beforeEach(() => {
    db = openDb()
    // Simulate rows that got tenant_id = 'default' from the migration backfill.
    db.exec(`
      INSERT INTO memories (chat_id, sector, created_at, accessed_at, agent_id, category, content, keywords, tenant_id)
        VALUES ('', 'semantic', 0, 0, 'agent-a', 'warm', 'legacy-content', 'legacy-kw', 'default');
      INSERT INTO kanban_cards (id, title, tenant_id, created_at, updated_at)
        VALUES ('legacy-card', 'Legacy Task', 'default', 0, 0);
    `)
  })

  it('default tenant scope sees legacy memory rows', () => {
    const rows = scopeToTenant('default').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('legacy-content')
  })

  it('default tenant scope sees legacy kanban cards', () => {
    const cards = scopeToTenant('default').kanban.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe('legacy-card')
  })

  it('non-default tenant does not see legacy rows', () => {
    expect(scopeToTenant('tenant-new').memories.list('agent-a')).toHaveLength(0)
    expect(scopeToTenant('tenant-new').kanban.list()).toHaveLength(0)
  })
})

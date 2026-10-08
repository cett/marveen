// Migration 0076: tenant_id NOT NULL on approvals, device_keys and schedules, and an integer-only
// kanban due_date. Built the way a real install gets it: the schema up to 0075, seeded with the NULLs
// and the text date the live database held, then 0076 on top.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'

const SRC = join(__dirname, '..', 'migrations')
let dir: string
let db: Database.Database

function stage(upTo: (f: string) => boolean): void {
  for (const f of readdirSync(SRC).filter(f => f.endsWith('.sql')).sort().filter(upTo)) copyFileSync(join(SRC, f), join(dir, f))
}
const m76 = () => readdirSync(SRC).find(f => f.startsWith('0076'))!

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notnull-migr-'))
  stage(f => f < '0076')
  db = new Database(':memory:')
  applyMigrations(db, dir)
  db.exec(`
    INSERT INTO tenants (id, display_name, created_at) VALUES ('t1', 'T1', 0);
    INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, tenant_id) VALUES
      ('ap-null', 'a', 'c', 'd', 'pending', 5, NULL), ('ap-t1', 'a', 'c', 'd', 'approved', 6, 't1');
    INSERT INTO device_keys (key_hash, name, created_at, tenant_id) VALUES ('h-null', 'n', 1, NULL), ('h-t1', 'n', 2, 't1');
    INSERT INTO schedules (id, prompt, schedule, agent, type, tenant_id, status, last_run_at) VALUES
      ('s-null', 'p', '* * * * *', 'a', 'task', NULL, 'live', 77), ('s-t1', 'p', '* * * * *', 'a', 'command', 't1', 'draft', NULL);
    INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id) VALUES ('root', 'x', 1, 1, 'admin', NULL);
    INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at, due_date) VALUES
      ('k-text', 'text date', 'done', 'normal', 1, 1, '2026-07-15'),
      ('k-int', 'int date', 'planned', 'normal', 1, 1, 1790812800),
      ('k-null', 'no date', 'planned', 'normal', 1, 1, NULL);
  `)
  copyFileSync(join(SRC, m76()), join(dir, m76()))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const nullTenants = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id IS NULL`).get() as { n: number }).n

describe('0076 backfill and rebuild', () => {
  it('turns every NULL tenant_id into default and keeps the other rows and columns intact', () => {
    applyMigrations(db, dir)
    for (const t of ['approvals', 'device_keys', 'schedules']) expect(nullTenants(t), t).toBe(0)
    expect(db.prepare('SELECT id, tenant_id, status, requested_at FROM approvals ORDER BY id').all()).toEqual([
      { id: 'ap-null', tenant_id: 'default', status: 'pending', requested_at: 5 },
      { id: 'ap-t1', tenant_id: 't1', status: 'approved', requested_at: 6 },
    ])
    expect(db.prepare('SELECT key_hash, tenant_id FROM device_keys ORDER BY id').all()).toEqual([
      { key_hash: 'h-null', tenant_id: 'default' }, { key_hash: 'h-t1', tenant_id: 't1' },
    ])
    expect(db.prepare('SELECT id, tenant_id, type, status, last_run_at FROM schedules ORDER BY id').all()).toEqual([
      { id: 's-null', tenant_id: 'default', type: 'task', status: 'live', last_run_at: 77 },
      { id: 's-t1', tenant_id: 't1', type: 'command', status: 'draft', last_run_at: null },
    ])
  })

  it('enforces NOT NULL afterwards, with default as the column default', () => {
    applyMigrations(db, dir)
    expect(() => db.prepare("INSERT INTO approvals (id, agent_id, category, action_description, tenant_id) VALUES ('x', 'a', 'c', 'd', NULL)").run()).toThrow(/NOT NULL/)
    expect(() => db.prepare("INSERT INTO schedules (id, schedule, agent, tenant_id) VALUES ('x', '* * * * *', 'a', NULL)").run()).toThrow(/NOT NULL/)
    expect(() => db.prepare("INSERT INTO device_keys (key_hash, name, created_at, tenant_id) VALUES ('x', 'n', 1, NULL)").run()).toThrow(/NOT NULL/)
    db.prepare("INSERT INTO device_keys (key_hash, name, created_at) VALUES ('omitted', 'n', 1)").run()
    expect((db.prepare("SELECT tenant_id FROM device_keys WHERE key_hash = 'omitted'").get() as { tenant_id: string }).tenant_id).toBe('default')
  })

  it('keeps the indexes and the other constraints (status CHECK, schedule type CHECK, unique key_hash)', () => {
    applyMigrations(db, dir)
    const idx = (t: string) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(t) as { name: string }[]).map(r => r.name)
    expect(idx('approvals')).toEqual(['idx_approvals_agent', 'idx_approvals_status', 'idx_approvals_tenant'])
    expect(idx('schedules')).toEqual(['idx_schedules_status', 'schedules_agent', 'schedules_enabled', 'schedules_tenant_id'])
    expect(() => db.prepare("INSERT INTO approvals (id, agent_id, category, action_description, status) VALUES ('y', 'a', 'c', 'd', 'bogus')").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO schedules (id, schedule, agent, type) VALUES ('y', '* * * * *', 'a', 'bogus')").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO device_keys (key_hash, name, created_at) VALUES ('h-t1', 'dup', 1)").run()).toThrow(/UNIQUE/)
  })

  it('leaves dashboard_users.tenant_id nullable: the global admin keeps its NULL', () => {
    applyMigrations(db, dir)
    expect(nullTenants('dashboard_users')).toBe(1)
  })

  it('deleting a tenant removes its device keys (ON DELETE CASCADE replaces SET NULL, which NOT NULL cannot take)', () => {
    applyMigrations(db, dir)
    db.pragma('foreign_keys = ON')
    db.prepare("DELETE FROM tenants WHERE id = 't1'").run()
    expect(db.prepare('SELECT key_hash FROM device_keys').all()).toEqual([{ key_hash: 'h-null' }])
  })

  it('does not violate any foreign key and keeps the integrity of the database', () => {
    applyMigrations(db, dir)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('works on a database whose triggers point at a module that is not loaded yet (the vec0 case)', () => {
    // A live install has vec_* triggers on memories/artifacts that name the sqlite-vec vec0 table; the
    // migration runner runs before that module is loaded. An ALTER TABLE ... RENAME re-parses every
    // trigger and dies on such a reference ("no such module: vec0" at boot). The stand-in here is a
    // trigger on another table whose body names a table that does not exist.
    db.exec('CREATE TRIGGER vec_standin_ad AFTER DELETE ON kanban_cards BEGIN DELETE FROM vec_missing WHERE rowid = OLD.rowid; END;')
    expect(() => db.exec('CREATE TABLE probe_a (x); ALTER TABLE probe_a RENAME TO probe_b')).toThrow(/no such table|vec_missing/)
    applyMigrations(db, dir)
    for (const t of ['approvals', 'device_keys', 'schedules']) expect(nullTenants(t), t).toBe(0)
  })

  it('carries the AUTOINCREMENT counter of device_keys over, so a deleted key id is never reused', () => {
    db.exec("DELETE FROM device_keys")
    db.exec("INSERT INTO device_keys (key_hash, name, created_at, tenant_id) VALUES ('later', 'n', 1, 't1')")
    db.exec("DELETE FROM device_keys WHERE key_hash = 'later'")
    const before = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'device_keys'").get() as { seq: number }).seq
    expect(before).toBeGreaterThanOrEqual(3)
    applyMigrations(db, dir)
    db.prepare("INSERT INTO device_keys (key_hash, name, created_at) VALUES ('next', 'n', 1)").run()
    const id = (db.prepare("SELECT id FROM device_keys WHERE key_hash = 'next'").get() as { id: number }).id
    expect(id).toBe(before + 1)
  })

  it('is applied once: a second run is a no-op', () => {
    applyMigrations(db, dir)
    applyMigrations(db, dir)
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 76').get() as { n: number }).n).toBe(1)
  })
})

describe('0076 kanban due_date', () => {
  const due = (id: string) => db.prepare('SELECT due_date, typeof(due_date) AS t FROM kanban_cards WHERE id = ?').get(id) as { due_date: unknown; t: string }

  it('converts the text date to the UTC-midnight epoch and leaves integers and NULL alone', () => {
    applyMigrations(db, dir)
    expect(due('k-text')).toEqual({ due_date: 1784073600, t: 'integer' })   // 2026-07-15T00:00:00Z
    expect(due('k-int')).toEqual({ due_date: 1790812800, t: 'integer' })
    expect(due('k-null').t).toBe('null')
  })

  it('self-heals raw SQL writers: a date string, a numeric string, a REAL; garbage becomes NULL', () => {
    applyMigrations(db, dir)
    const put = (id: string, v: unknown) => db.prepare("INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at, due_date) VALUES (?, 't', 'planned', 'normal', 1, 1, ?)").run(id, v)
    put('w-date', '2026-10-29'); put('w-num', '1793232000'); put('w-real', 1793232000.0); put('w-junk', 'next friday'); put('w-bad-date', '2026-13-45')
    expect(due('w-date').due_date).toBe(1793232000)
    expect(due('w-num')).toEqual({ due_date: 1793232000, t: 'integer' })
    expect(due('w-real').t).toBe('integer')
    expect(due('w-junk').t).toBe('null')
    expect(due('w-bad-date').t).toBe('null')
    db.prepare("UPDATE kanban_cards SET due_date = '2026-11-01' WHERE id = 'k-int'").run()
    expect(due('k-int').due_date).toBe(1793491200)
    db.prepare("UPDATE kanban_cards SET due_date = 'soon' WHERE id = 'k-int'").run()
    expect(due('k-int').t).toBe('null')
  })
})

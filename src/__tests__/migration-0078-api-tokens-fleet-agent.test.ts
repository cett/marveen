// Migration 0078: api_tokens gets agent_id and the role CHECK learns 'fleet_agent'. Built the way a
// real install gets it: the schema up to 0077, seeded with the token rows the live database holds
// (the dashboard token, a rotated pair, a revoked one), then 0078 on top.

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
const m78 = () => readdirSync(SRC).find(f => f.startsWith('0078'))!

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'api-tokens-migr-'))
  stage(f => f < '0078')
  db = new Database(':memory:')
  applyMigrations(db, dir)
  db.exec(`
    INSERT INTO api_tokens (id, token_hash, name, role, tenant_id, created_at, expires_at, revoked_at, last_used_at, rotated_from) VALUES
      (1, 'h-dashboard', 'dashboard', 'admin', 'default', 100, NULL, NULL, 150, NULL),
      (2, 'h-old', 'old-agent', 'agent', 't1', 110, 900, 120, NULL, NULL),
      (3, 'h-new', 'old-agent', 'agent', 't1', 120, 900, NULL, 130, 2),
      (7, 'h-revoked', 'viewer-tok', 'viewer', 'default', 130, NULL, 140, NULL, NULL);
  `)
  copyFileSync(join(SRC, m78()), join(dir, m78()))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('0078 rebuild', () => {
  it('keeps every row and column, the rotation chain included, and gives them a NULL agent_id', () => {
    applyMigrations(db, dir)
    expect(db.prepare('SELECT id, token_hash, name, role, tenant_id, created_at, expires_at, revoked_at, last_used_at, rotated_from, agent_id FROM api_tokens ORDER BY id').all()).toEqual([
      { id: 1, token_hash: 'h-dashboard', name: 'dashboard', role: 'admin', tenant_id: 'default', created_at: 100, expires_at: null, revoked_at: null, last_used_at: 150, rotated_from: null, agent_id: null },
      { id: 2, token_hash: 'h-old', name: 'old-agent', role: 'agent', tenant_id: 't1', created_at: 110, expires_at: 900, revoked_at: 120, last_used_at: null, rotated_from: null, agent_id: null },
      { id: 3, token_hash: 'h-new', name: 'old-agent', role: 'agent', tenant_id: 't1', created_at: 120, expires_at: 900, revoked_at: null, last_used_at: 130, rotated_from: 2, agent_id: null },
      { id: 7, token_hash: 'h-revoked', name: 'viewer-tok', role: 'viewer', tenant_id: 'default', created_at: 130, expires_at: null, revoked_at: 140, last_used_at: null, rotated_from: null, agent_id: null },
    ])
  })

  it('carries the AUTOINCREMENT counter over: the id of a deleted or revoked token is never reused', () => {
    db.prepare('DELETE FROM api_tokens WHERE id = 7').run()
    applyMigrations(db, dir)
    const row = db.prepare(
      "INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES ('h-next', 'n', 'admin', 1) RETURNING id",
    ).get() as { id: number }
    expect(row.id).toBeGreaterThan(7)
  })

  it('accepts a fleet_agent token only with an agent_id', () => {
    applyMigrations(db, dir)
    db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at, agent_id) VALUES ('h-alpha', 'fleet-agent:alpha', 'fleet_agent', 1, 'alpha')").run()
    expect(() => db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES ('h-x', 'n', 'fleet_agent', 1)").run()).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at, agent_id) VALUES ('h-y', 'n', 'fleet_agent', 1, '')").run()).toThrow(/CHECK/)
  })

  it('lets a token of another role carry an agent_id as a label, and still refuses an unknown role', () => {
    applyMigrations(db, dir)
    db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at, agent_id) VALUES ('h-main', 'main', 'admin', 1, 'main-agent')").run()
    expect(() => db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at) VALUES ('h-z', 'n', 'root', 1)").run()).toThrow(/CHECK/)
  })

  it('allows several tokens per agent (rotation) and keeps token_hash unique', () => {
    applyMigrations(db, dir)
    const ins = db.prepare("INSERT INTO api_tokens (token_hash, name, role, created_at, agent_id) VALUES (?, 'fleet-agent:alpha', 'fleet_agent', 1, 'alpha')")
    ins.run('h-1')
    ins.run('h-2')
    expect(() => ins.run('h-1')).toThrow(/UNIQUE/)
  })

  it('keeps the old indexes and adds the agent index', () => {
    applyMigrations(db, dir)
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_tokens' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name)
    expect(idx).toEqual(['idx_api_tokens_agent', 'idx_api_tokens_hash', 'idx_api_tokens_tenant'])
  })

  it('does not violate any foreign key and keeps the integrity of the database', () => {
    applyMigrations(db, dir)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('works on a database whose triggers point at a module that is not loaded yet (the vec0 case)', () => {
    db.exec('CREATE TRIGGER vec_standin_ad AFTER DELETE ON kanban_cards BEGIN DELETE FROM vec_missing WHERE rowid = OLD.rowid; END;')
    expect(() => db.exec('CREATE TABLE probe_a (x); ALTER TABLE probe_a RENAME TO probe_b')).toThrow(/no such table|vec_missing/)
    applyMigrations(db, dir)
    expect((db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n).toBe(4)
  })
})

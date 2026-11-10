// Migration 0093: skills.status. Built the way a real install gets it: the schema up to 0092, seeded with skills (fleet
// and tenant, with companion files, a tenant grant and a trail), then 0093 on top. Pinned: every old row becomes
// 'live' and is otherwise untouched, the children of the table (files, grants, trail) survive, the CHECK allows
// exactly the four states, a writer that names no status gets 'live', and the migration is a plain ADD COLUMN (no
// rename, no rebuild: a rebuild would cascade into the child tables).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'

const SRC = join(__dirname, '..', 'migrations')
let dir: string
let db: Database.Database

function stage(upTo: (f: string) => boolean): void {
  for (const f of readdirSync(SRC).filter(f => f.endsWith('.sql')).sort().filter(upTo)) copyFileSync(join(SRC, f), join(dir, f))
}
const m93 = () => readdirSync(SRC).find(f => f.startsWith('0093'))!

const INSERT = `INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skills-status-migr-'))
  stage(f => f < '0093')
  db = new Database(':memory:')
  applyMigrations(db, dir)
  const ins = db.prepare(INSERT)
  ins.run('global/skill-a', 'skill-a', 'first', 'body a', 'fleet', 1, null, 1000, 1100)
  ins.run('agent/agent-a/skill-b', 'skill-b', '', 'body b', 'fleet', 0, 'user-a', 1200, 1300)
  ins.run('tenant-a-skill-c', 'skill-c', 'third', 'body c', 'tenant-a', 0, null, 1400, 1500)
  db.prepare("INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('global/skill-a', 'scripts/run.sh', x'01', 493)").run()
  db.prepare("INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by) VALUES ('tenant-a-skill-c', 'tenant-b', 'user-a')").run()
  db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('global/skill-a', 'fleet', 1, 'baseline', 'system')").run()
  copyFileSync(join(SRC, m93()), join(dir, m93()))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const OLD_COLUMNS = 'id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at'
const rows = () => db.prepare(`SELECT ${OLD_COLUMNS} FROM skills ORDER BY id`).all() as Array<Record<string, unknown>>
const statuses = () => db.prepare('SELECT id, status FROM skills ORDER BY id').all() as Array<{ id: string; status: string }>

describe('0093 skills.status', () => {
  it('is migration 0093, directly after 0092, with no duplicate number (the whole-list order is db-migrations-order)', () => {
    const nums = readdirSync(SRC).filter(f => /^\d{4}_.*\.sql$/.test(f)).map(f => Number(f.slice(0, 4))).sort((a, b) => a - b)
    expect(m93()).toMatch(/^0093_/)
    expect(new Set(nums).size).toBe(nums.length)
    expect(nums.indexOf(93)).toBe(nums.indexOf(92) + 1)
  })

  it('has no status column before the migration and makes every existing skill live after it', () => {
    const cols = () => (db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols()).not.toContain('status')
    applyMigrations(db, dir)
    expect(cols()).toContain('status')
    expect(statuses()).toEqual([
      { id: 'agent/agent-a/skill-b', status: 'live' },
      { id: 'global/skill-a', status: 'live' },
      { id: 'tenant-a-skill-c', status: 'live' },
    ])
  })

  it('leaves every other column of every old row as it was', () => {
    const before = rows()
    applyMigrations(db, dir)
    expect(rows()).toEqual(before)
  })

  it('keeps the child tables: companion files, the tenant grant and the trail are all still there', () => {
    applyMigrations(db, dir)
    expect(db.prepare('SELECT skill_id, rel_path, mode FROM skill_files').all()).toEqual([{ skill_id: 'global/skill-a', rel_path: 'scripts/run.sh', mode: 493 }])
    expect(db.prepare('SELECT skill_id, tenant_id FROM skill_tenant_access').all()).toEqual([{ skill_id: 'tenant-a-skill-c', tenant_id: 'tenant-b' }])
    expect(db.prepare('SELECT skill_id, action FROM skill_revisions').all()).toEqual([{ skill_id: 'global/skill-a', action: 'baseline' }])
  })

  it('a writer that names no status gets live (the default), so no insert path has to change', () => {
    applyMigrations(db, dir)
    db.prepare(INSERT).run('global/skill-d', 'skill-d', '', 'body d', 'fleet', 1, null, 1, 1)
    expect((db.prepare("SELECT status FROM skills WHERE id = 'global/skill-d'").get() as { status: string }).status).toBe('live')
  })

  it('allows exactly the four states and refuses anything else, including NULL, case variants and padding', () => {
    applyMigrations(db, dir)
    const set = db.prepare("UPDATE skills SET status = ? WHERE id = 'global/skill-a'")
    for (const s of ['live', 'pending_review', 'disabled', 'expired']) expect(() => set.run(s), s).not.toThrow()
    for (const s of ['Live', 'LIVE', 'live ', ' disabled', 'revoked', 'active', '']) expect(() => set.run(s), JSON.stringify(s)).toThrow(/CHECK/)
    expect(() => set.run(null)).toThrow(/NOT NULL/)
    // The refused writes left the last good value in place.
    expect((db.prepare("SELECT status FROM skills WHERE id = 'global/skill-a'").get() as { status: string }).status).toBe('expired')
  })

  it('the trail already accepts the revoke action (0092 widened it): this migration does not touch skill_revisions', () => {
    applyMigrations(db, dir)
    expect(() => db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('global/skill-a', 'fleet', 2, 'revoke', 'human')").run()).not.toThrow()
    const sql = readFileSync(join(SRC, m93()), 'utf-8')
    const statements = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    expect(statements).not.toMatch(/skill_revisions/i)
  })

  it('is a plain ADD COLUMN: no rename and no table rebuild, so the child rows are never cascaded away', () => {
    const sql = readFileSync(join(SRC, m93()), 'utf-8')
    const statements = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    expect(statements).toMatch(/ALTER\s+TABLE\s+skills\s+ADD\s+COLUMN\s+status/i)
    expect(statements).not.toMatch(/\bRENAME\b/i)
    expect(statements).not.toMatch(/\bDROP\b/i)
    expect(statements).not.toMatch(/\bCREATE\s+TABLE\b/i)
  })

  it('running it twice does not fail or change anything (a pure ADD COLUMN migration is applied once and tolerated twice)', () => {
    applyMigrations(db, dir)
    db.prepare("UPDATE skills SET status = 'disabled' WHERE id = 'global/skill-a'").run()
    applyMigrations(db, dir)
    expect(statuses().find(s => s.id === 'global/skill-a')?.status).toBe('disabled')
  })

  it('a deleted skill still cascades its files and grants (the FK into skills is intact after the new column)', () => {
    applyMigrations(db, dir)
    db.prepare("DELETE FROM skills WHERE id = 'global/skill-a'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_files').get()).toEqual({ n: 0 })
    db.prepare("DELETE FROM skills WHERE id = 'tenant-a-skill-c'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_tenant_access').get()).toEqual({ n: 0 })
  })
})

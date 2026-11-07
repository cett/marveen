// Migration 0092: skill_revisions.author_kind learns 'operator'. Built the way a real install gets it: the schema up
// to 0091, seeded with trail rows (including the pre-change shape of an operator token write: kind 'agent', id
// 'operator'), then 0092 on top. Pinned: old rows are not rewritten, every column and the sequence survive, the
// CHECK accepts the new kind and still refuses junk, the table has no trigger and the rebuild never renames.

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
const m92 = () => readdirSync(SRC).find(f => f.startsWith('0092'))!

const INSERT = `INSERT INTO skill_revisions
  (id, skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts, content, author_kind, author_id, source_ref, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-rev-migr-'))
  stage(f => f < '0092')
  db = new Database(':memory:')
  applyMigrations(db, dir)
  const ins = db.prepare(INSERT)
  ins.run(1, 'skill-a', 'tenant-a', 1, 'baseline', 'h1', null, null, 0, 'body one', 'system', 'baseline', null, null, 1000)
  ins.run(2, 'skill-a', 'tenant-a', 2, 'modify', 'h2', 'h1', null, 1, 'body two', 'agent', 'operator', 'src-x', 'why', 1100) // the old operator shape
  ins.run(3, 'skill-a', 'tenant-a', 3, 'file_put', null, null, 'f1', 1, null, 'human', 'user-a', null, null, 1200)
  ins.run(5, 'skill-b', 'tenant-b', 1, 'create', 'h9', null, null, 0, 'other', 'import', null, 'fleet-transfer', null, 1300) // id 4 was purged: a gap
  ins.run(7, 'skill-b', 'tenant-b', 2, 'modify', 'h10', 'h9', null, 0, 'x', 'agent', 'agent-a', null, null, 1400)
  // The sequence ends ABOVE the highest remaining id: rows 3 and 7 are purged, so a rebuild that does not carry
  // sqlite_sequence over would hand out id 6 again instead of 8.
  db.prepare('DELETE FROM skill_revisions WHERE id IN (3, 7)').run()
  copyFileSync(join(SRC, m92()), join(dir, m92()))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const rows = () => db.prepare('SELECT * FROM skill_revisions ORDER BY id').all() as Array<Record<string, unknown>>

describe('0092 rebuild', () => {
  it('is migration 0092, directly after 0091, and the numbering has no gap or duplicate', () => {
    const nums = readdirSync(SRC).filter(f => /^\d{4}_.*\.sql$/.test(f)).map(f => Number(f.slice(0, 4)))
    expect(m92()).toMatch(/^0092_/)
    expect(new Set(nums).size).toBe(nums.length)
    expect(nums.filter(n => n >= 91)).toEqual(expect.arrayContaining([91, 92]))
  })

  it('keeps every old row byte for byte: the old operator write stays agent / operator, nothing is rewritten', () => {
    const before = rows()
    applyMigrations(db, dir)
    expect(rows()).toEqual(before)
    expect(rows().map(r => [r['id'], r['author_kind'], r['author_id']])).toEqual([
      [1, 'system', 'baseline'], [2, 'agent', 'operator'], [5, 'import', null],
    ])
  })

  it('records the migration and leaves the sequence above every id ever handed out', () => {
    const maxBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'skill_revisions'").get() as { seq: number }).seq
    expect(maxBefore).toBe(7)
    applyMigrations(db, dir)
    const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'skill_revisions'").get() as { seq: number }).seq
    expect(seq).toBe(7)
    db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('skill-c', 't', 1, 'create', 'operator')").run()
    expect((db.prepare('SELECT MAX(id) AS m FROM skill_revisions').get() as { m: number }).m).toBe(8) // never reuses 3, 4 or 7
  })

  it('the new table accepts operator on a new row and still refuses an unknown kind and an unknown action', () => {
    applyMigrations(db, dir)
    const ok = db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES (?, 't', ?, 'modify', ?)")
    for (const [i, kind] of ['human', 'agent', 'import', 'system', 'auto', 'operator'].entries()) expect(() => ok.run('skill-k', i + 1, kind), kind).not.toThrow()
    for (const kind of ['Operator', 'operator ', 'root', '']) expect(() => ok.run('skill-bad', 1, kind), JSON.stringify(kind)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('s', 't', 9, 'rewrite', 'agent')").run()).toThrow(/CHECK/)
  })

  it('keeps the other constraints: UNIQUE(skill_id, seq), NOT NULLs, the default has_scripts and created_at, the tenant index', () => {
    applyMigrations(db, dir)
    expect(() => db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('skill-a', 'tenant-a', 1, 'modify', 'agent')").run()).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action) VALUES ('s', 't', 1, 'modify')").run()).toThrow(/NOT NULL/)
    db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('s2', 't', 1, 'modify', 'agent')").run()
    const fresh = db.prepare("SELECT has_scripts, created_at FROM skill_revisions WHERE skill_id = 's2'").get() as { has_scripts: number; created_at: number }
    expect(fresh.has_scripts).toBe(0)
    expect(fresh.created_at).toBeGreaterThan(1_000_000_000)
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skill_revisions' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    expect(idx.map(i => i.name)).toEqual(['idx_skill_revisions_tenant_created'])
  })

  it('leaves no scratch table behind and the column list is the one of 0091', () => {
    const cols = () => (db.prepare('PRAGMA table_info(skill_revisions)').all() as Array<{ name: string }>).map(c => c.name)
    const before = cols()
    applyMigrations(db, dir)
    expect(cols()).toEqual(before)
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE (tbl_name LIKE 'skill_revisions%' OR name LIKE '%skill_revisions%') AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name).sort()
    expect(names).toEqual(['idx_skill_revisions_tenant_created', 'skill_revisions'])
  })

  it('skill_revisions has no trigger and no vec0 virtual table, and the migration does not rename (the vec0 rule)', () => {
    applyMigrations(db, dir)
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'skill_revisions' OR sql LIKE '%skill_revisions%')").all()
    expect(triggers).toEqual([])
    const vec = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%vec0%' AND sql LIKE '%skill_revisions%'").all()
    expect(vec).toEqual([])
    const sql = readFileSync(join(SRC, m92()), 'utf-8')
    const statements = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
    expect(statements).not.toMatch(/ALTER\s+TABLE/i)
    expect(statements).not.toMatch(/\bRENAME\b/i)
  })

  it('running the migration twice through applyMigrations does not rebuild again', () => {
    applyMigrations(db, dir)
    const once = rows()
    applyMigrations(db, dir)
    expect(rows()).toEqual(once)
  })
})

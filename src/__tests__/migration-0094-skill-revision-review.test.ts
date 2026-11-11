// Migration 0094: the review state of a skill revision. Built the way a real install gets it: the schema up to 0093 with
// a trail in it, then 0094 on top. Pinned: every old revision becomes 'activated' and is otherwise untouched (ids and
// the autoincrement counter included), the CHECK allows exactly the four states, the new columns default to nothing,
// skill_revision_files exists with its key, and the migration is ADD COLUMN plus a new table (no rename, no rebuild).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'

const SRC = join(__dirname, '..', 'migrations')
let dir: string
let db: Database.Database

const stage = (upTo: (f: string) => boolean): void => {
  for (const f of readdirSync(SRC).filter((f) => f.endsWith('.sql')).sort().filter(upTo)) copyFileSync(join(SRC, f), join(dir, f))
}
const m94 = (): string => readdirSync(SRC).find((f) => f.startsWith('0094'))!
const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-rev-review-migr-'))
  stage((f) => f < '0094')
  db = new Database(':memory:')
  applyMigrations(db, dir)
  const ins = db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind, content_sha256, content) VALUES (?, 'fleet', ?, ?, 'system', ?, ?)")
  ins.run('global/skill-a', 1, 'baseline', 'aa', 'text a')
  ins.run('global/skill-a', 2, 'modify', 'bb', 'text b')
  ins.run('global/skill-c', 1, 'revoke', 'cc', null)
  copyFileSync(join(SRC, m94()), join(dir, m94()))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('0094 skill revision review', () => {
  it('is migration 0094, directly after 0093, with no duplicate number', () => {
    const nums = readdirSync(SRC).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b)
    expect(m94()).toMatch(/^0094_/)
    expect(new Set(nums).size).toBe(nums.length)
    expect(nums.indexOf(94)).toBe(nums.indexOf(93) + 1)
  })

  it('makes every existing revision activated and changes nothing else about it', () => {
    const before = db.prepare('SELECT id, skill_id, seq, action, content_sha256, content, created_at FROM skill_revisions ORDER BY id').all()
    expect(cols('skill_revisions')).not.toContain('status')
    applyMigrations(db, dir)
    expect(cols('skill_revisions')).toEqual(expect.arrayContaining(['status', 'touches_privilege', 'submitted_by', 'decided_by', 'decided_at', 'decision_ref', 'proposed_description']))
    expect(db.prepare('SELECT id, skill_id, seq, action, content_sha256, content, created_at FROM skill_revisions ORDER BY id').all()).toEqual(before)
    expect(db.prepare('SELECT status, touches_privilege, submitted_by, decided_by, decided_at, decision_ref FROM skill_revisions').all()).toEqual(
      Array(3).fill({ status: 'activated', touches_privilege: 0, submitted_by: null, decided_by: null, decided_at: null, decision_ref: null }))
  })

  it('keeps the autoincrement counter: the next revision gets the next id, not a reused one', () => {
    applyMigrations(db, dir)
    db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind) VALUES ('global/skill-a', 'fleet', 3, 'modify', 'system')").run()
    expect((db.prepare('SELECT MAX(id) AS m FROM skill_revisions').get() as { m: number }).m).toBe(4)
  })

  it('accepts exactly the four states and refuses a fifth', () => {
    applyMigrations(db, dir)
    const put = (seq: number, status: string) => db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind, status) VALUES ('global/skill-z', 'fleet', ?, 'modify', 'system', ?)").run(seq, status)
    ;['activated', 'pending', 'rejected', 'expired'].forEach((s, i) => expect(() => put(i + 1, s)).not.toThrow())
    expect(() => put(9, 'approved')).toThrow(/CHECK/)
    expect(() => put(10, '')).toThrow(/CHECK/)
  })

  it('creates skill_revision_files keyed by revision and path, and refuses a duplicate', () => {
    applyMigrations(db, dir)
    const put = () => db.prepare("INSERT INTO skill_revision_files (revision_id, rel_path, content) VALUES (1, 'scripts/run.sh', x'01')").run()
    put()
    expect(() => put()).toThrow(/UNIQUE|PRIMARY/)
    expect(db.prepare('SELECT mode FROM skill_revision_files').get()).toEqual({ mode: 420 })
  })

  it('is ADD COLUMN and a new table: no rename, no table rebuild', () => {
    const sql = readFileSync(join(SRC, m94()), 'utf-8')
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/RENAME/i)
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/CREATE\s+TABLE\s+skill_revisions\b/i)
  })
})

// Migration 0095: skill_revisions.prev_state_sha256, the hash of the live state a proposal was built against. Built the
// way a real install gets it: the schema up to 0094 with a trail in it, then 0095 on top. Pinned: it is the number after
// 0094, every old row keeps its data and reads NULL, a new row can carry a value, and the migration is exactly one
// nullable ADD COLUMN (no rename, no default, no CHECK, no trigger), so a later PostgreSQL baseline translates it as is.
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
const m95 = (): string => readdirSync(SRC).find((f) => f.startsWith('0095'))!
const cols = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-rev-state-migr-'))
  stage((f) => f < '0095')
  db = new Database(':memory:')
  applyMigrations(db, dir)
  const ins = db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind, content_sha256, status) VALUES (?, 'fleet', ?, ?, 'system', ?, ?)")
  ins.run('global/skill-a', 1, 'baseline', 'aa', 'activated')
  ins.run('global/skill-a', 2, 'modify', 'bb', 'pending')
  copyFileSync(join(SRC, m95()), join(dir, m95()))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('0095 skill revision prev state', () => {
  it('is migration 0095, directly after 0094, with no duplicate number', () => {
    const nums = readdirSync(SRC).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b)
    expect(m95()).toMatch(/^0095_/)
    expect(new Set(nums).size).toBe(nums.length)
    expect(nums.indexOf(95)).toBe(nums.indexOf(94) + 1)
  })

  it('adds the column; every existing row keeps its data and reads NULL', () => {
    const before = db.prepare('SELECT id, skill_id, seq, action, content_sha256, status, created_at FROM skill_revisions ORDER BY id').all()
    expect(cols('skill_revisions')).not.toContain('prev_state_sha256')
    applyMigrations(db, dir)
    expect(cols('skill_revisions')).toContain('prev_state_sha256')
    expect(db.prepare('SELECT id, skill_id, seq, action, content_sha256, status, created_at FROM skill_revisions ORDER BY id').all()).toEqual(before)
    expect(db.prepare('SELECT prev_state_sha256 AS p FROM skill_revisions').all()).toEqual([{ p: null }, { p: null }])
  })

  it('a new row can carry the value', () => {
    applyMigrations(db, dir)
    db.prepare("INSERT INTO skill_revisions (skill_id, tenant_id, seq, action, author_kind, prev_state_sha256) VALUES ('global/skill-a', 'fleet', 3, 'modify', 'system', 'abc')").run()
    expect((db.prepare('SELECT prev_state_sha256 AS p FROM skill_revisions WHERE seq = 3').get() as { p: string }).p).toBe('abc')
  })

  it('is one nullable ADD COLUMN and nothing else: no rename, no default, no CHECK, no trigger, no other statement', () => {
    const sql = readFileSync(join(SRC, m95()), 'utf-8')
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()
    expect(code).toBe('ALTER TABLE skill_revisions ADD COLUMN prev_state_sha256 TEXT;')
  })
})

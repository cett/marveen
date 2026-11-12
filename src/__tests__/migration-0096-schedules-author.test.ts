// Migration 0096: schedules.author_user_id / author_label / activated_by / activated_at. Built the way a real install
// gets it: the schema up to 0095, seeded with schedules (live, draft, pending_review, two tenants), then 0096 on top.
// Pinned: every old column of every old row is untouched; the author columns are backfilled with the lowest-id enabled
// admin (never a literal id, never a disabled or non-admin user, NULL when there is none, so the backfill can never
// stop a schedule) and the activator columns stay NULL; the four indexes of the table survive; the migration is four
// plain ADD COLUMN plus exactly one UPDATE (no rebuild, no rename); it sits right after 0095 and is unique; and
// applying the chain twice is harmless.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'

const SRC = join(__dirname, '..', 'migrations')
let dir: string
let db: Database.Database

const files = (): string[] => readdirSync(SRC).filter((f) => f.endsWith('.sql')).sort()
const m96 = (): string => files().find((f) => f.startsWith('0096'))!
const OLD_COLS = 'id, prompt, description, schedule, agent, type, enabled, tenant_id, skip_if_busy, force_send, target_session, command, timeout_ms, fail_threshold, pre_check, catch_up_max_age_minutes, stuck_after_minutes, requires, status, last_run_at, last_run_result, created_at, updated_at'
const NEW_COLS = ['author_user_id', 'author_label', 'activated_by', 'activated_at']

const INSERT = `INSERT INTO schedules (id, prompt, description, schedule, agent, type, enabled, tenant_id, status, command, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

function indexNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'schedules' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name)
}

let before: unknown[]
let indexesBefore: string[]

type UserSeed = { id: number; username: string; role: string; disabled?: number; tenant?: string | null }
const seedUsers = (users: UserSeed[]): void => {
  const ins = db.prepare('INSERT INTO dashboard_users (id, username, password_hash, role, tenant_id, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)')
  for (const u of users) ins.run(u.id, u.username, 'hash-x', u.role, u.tenant ?? null, u.disabled ?? 0)
}
type AuthorRow = { id: string; author_user_id: number | null; author_label: string | null; activated_by: unknown; activated_at: unknown }
const authors = (): AuthorRow[] =>
  db.prepare('SELECT id, author_user_id, author_label, activated_by, activated_at FROM schedules ORDER BY id').all() as AuthorRow[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schedules-author-migr-'))
  for (const f of files().filter((x) => x < '0096')) copyFileSync(join(SRC, f), join(dir, f))
  db = new Database(':memory:')
  applyMigrations(db, dir)
  const ins = db.prepare(INSERT)
  ins.run('task-live-a', 'p1', 'd1', '0 9 * * *', 'agent-a', 'task', 1, 'default', 'live', null, 1000, 1100)
  ins.run('task-draft-b', 'p2', '', '*/5 * * * *', 'agent-b', 'heartbeat', 0, 'tenant-a', 'draft', null, 1200, 1300)
  ins.run('task-review-c', 'p3', 'd3', '30 2 * * 1', 'agent-a', 'command', 1, 'tenant-b', 'pending_review', 'echo hi', 1400, 1500)
  seedUsers([{ id: 1, username: 'admin-a', role: 'admin' }])
  before = db.prepare(`SELECT ${OLD_COLS} FROM schedules ORDER BY id`).all()
  indexesBefore = indexNames()
  copyFileSync(join(SRC, m96()), join(dir, m96()))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migration 0096 schedules author columns', () => {
  it('leaves every old column of every old row byte-for-byte, adds four nullable columns, backfills the author only', () => {
    expect(before).toHaveLength(3)
    applyMigrations(db, dir)
    expect(db.prepare(`SELECT ${OLD_COLS} FROM schedules ORDER BY id`).all()).toEqual(before)
    const cols = (db.prepare('PRAGMA table_info(schedules)').all() as { name: string; type: string; notnull: number; dflt_value: unknown }[])
    for (const c of NEW_COLS) {
      const col = cols.find((x) => x.name === c)!
      expect(col, c).toBeDefined()
      expect(col.notnull, c).toBe(0)
      expect(col.dflt_value, c).toBeNull()
    }
    expect(cols.find((x) => x.name === 'author_user_id')!.type).toBe('INTEGER')
    expect(cols.find((x) => x.name === 'activated_at')!.type).toBe('INTEGER')
    expect(cols.find((x) => x.name === 'author_label')!.type).toBe('TEXT')
    expect(cols.find((x) => x.name === 'activated_by')!.type).toBe('TEXT')
    const rows = authors()
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toMatchObject({ author_user_id: 1, author_label: 'admin-a', activated_by: null, activated_at: null })
  })

  it('keeps the indexes of the table, so nothing was rebuilt', () => {
    expect(indexesBefore).toHaveLength(4)
    applyMigrations(db, dir)
    expect(indexNames()).toEqual(indexesBefore)
  })

  it('has no foreign key, CHECK or index on the new columns (a deleted user must neither cascade nor block)', () => {
    applyMigrations(db, dir)
    expect(db.prepare("PRAGMA foreign_key_list('schedules')").all()).toEqual([])
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get() as { sql: string }).sql
    for (const c of NEW_COLS) expect(sql).not.toMatch(new RegExp(`CHECK[^,]*${c}`, 'i'))
    for (const name of indexNames()) {
      const cols = (db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as { name: string }[]).map((x) => x.name)
      for (const c of NEW_COLS) expect(cols, name).not.toContain(c)
    }
  })

  it('is four plain ADD COLUMN and exactly one UPDATE: no DROP TABLE, no RENAME, no INSERT, no CREATE', () => {
    const code = readFileSync(join(SRC, m96()), 'utf-8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code.match(/ALTER TABLE schedules ADD COLUMN/g)).toHaveLength(4)
    expect(code.match(/\bUPDATE\s/gi)).toHaveLength(1)
    expect(code).not.toMatch(/DROP\s+TABLE|RENAME|INSERT\s|CREATE\s/i)
  })

  it('sits directly after 0095 and no other file takes the number', () => {
    const all = files()
    expect(all.filter((f) => f.startsWith('0096'))).toHaveLength(1)
    expect(all.indexOf(m96())).toBe(all.findIndex((f) => f.startsWith('0095')) + 1)
  })

  it('applying the chain twice is harmless', () => {
    applyMigrations(db, dir)
    expect(() => applyMigrations(db, dir)).not.toThrow()
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(96)
  })
})

// The backfill: the lowest-id enabled admin, for every row, whatever its status.
describe('migration 0096 author backfill', () => {
  const run = (): void => applyMigrations(db, dir)

  it('gives every status (live, draft, pending_review) the author, and leaves the activator NULL', () => {
    run()
    const rows = authors()
    expect(rows.map((r) => r.id)).toEqual(['task-draft-b', 'task-live-a', 'task-review-c'])
    for (const r of rows) expect(r).toEqual({ id: r.id, author_user_id: 1, author_label: 'admin-a', activated_by: null, activated_at: null })
  })

  it('with several admins the lowest id wins, not the first created or the first by name', () => {
    seedUsers([{ id: 4, username: 'admin-0', role: 'admin' }, { id: 2, username: 'admin-b', role: 'admin' }])
    db.prepare('UPDATE dashboard_users SET id = 3 WHERE id = 1').run()
    run()
    expect(authors().every((r) => r.author_user_id === 2 && r.author_label === 'admin-b')).toBe(true)
  })

  it('an admin with a lower id who is disabled is skipped: the next enabled admin is the author', () => {
    db.prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = 1').run()
    seedUsers([{ id: 3, username: 'admin-c', role: 'admin' }, { id: 2, username: 'admin-b', role: 'admin', disabled: 1 }])
    run()
    expect(authors().every((r) => r.author_user_id === 3 && r.author_label === 'admin-c')).toBe(true)
  })

  it('a non-admin with a lower id does not win', () => {
    db.prepare('UPDATE dashboard_users SET id = 9 WHERE id = 1').run()
    seedUsers([
      { id: 1, username: 'viewer-a', role: 'viewer' }, { id: 2, username: 'tenant-user-a', role: 'agent', tenant: 'tenant-a' },
      { id: 3, username: 'reader-a', role: 'read_only' },
    ])
    run()
    expect(authors().every((r) => r.author_user_id === 9 && r.author_label === 'admin-a')).toBe(true)
  })

  it.each([
    ['only a disabled admin', (): void => { db.prepare('UPDATE dashboard_users SET disabled = 1').run() }],
    ['only non-admins', (): void => { db.prepare("UPDATE dashboard_users SET role = 'viewer'").run() }],
    ['an empty dashboard_users', (): void => { db.prepare('DELETE FROM dashboard_users').run() }],
  ])('%s: the author stays NULL, so the backfill can never stop a schedule', (_label, arrange) => {
    arrange()
    run()
    const rows = authors()
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toEqual({ id: r.id, author_user_id: null, author_label: null, activated_by: null, activated_at: null })
  })

  it('an admin with a tenant is still an admin: the tenant does not matter for the author', () => {
    db.prepare("UPDATE dashboard_users SET tenant_id = 'tenant-a' WHERE id = 1").run()
    run()
    expect(authors().every((r) => r.author_user_id === 1)).toBe(true)
  })

  it('production shape: admin id 1 with no tenant, 28 live default-tenant schedules (9 command, 12 heartbeat, 7 task): all 28 point at user 1', () => {
    db.prepare('DELETE FROM schedules').run()
    const ins = db.prepare(INSERT)
    const kinds: Array<[string, number, string | null]> = [['command', 9, 'echo run'], ['heartbeat', 12, null], ['task', 7, null]]
    let n = 0
    for (const [type, count, command] of kinds) {
      for (let i = 0; i < count; i++) { ins.run(`prod-${type}-${i}`, 'p', 'd', '0 9 * * *', 'agent-a', type, 1, 'default', 'live', command, 1000 + n, 1000 + n); n++ }
    }
    run()
    const rows = authors()
    expect(rows).toHaveLength(28)
    for (const r of rows) expect(r).toEqual({ id: r.id, author_user_id: 1, author_label: 'admin-a', activated_by: null, activated_at: null })
  })

  it('an install where the admin has id 5 (not 1): the author is user 5, so the id is not a literal', () => {
    db.prepare('DELETE FROM dashboard_users').run()
    seedUsers([{ id: 2, username: 'viewer-a', role: 'viewer' }, { id: 5, username: 'admin-e', role: 'admin' }, { id: 7, username: 'admin-g', role: 'admin' }])
    run()
    const rows = authors()
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toMatchObject({ author_user_id: 5, author_label: 'admin-e' })
  })

  it('a row inserted after the migration is not touched by it (a later seed has a NULL author)', () => {
    run()
    db.prepare(INSERT).run('seed-after', 'p', 'd', '0 9 * * *', 'agent-a', 'task', 1, 'default', 'live', null, 2000, 2000)
    run()
    expect(authors().find((r) => r.id === 'seed-after')).toMatchObject({ author_user_id: null, author_label: null })
  })
})

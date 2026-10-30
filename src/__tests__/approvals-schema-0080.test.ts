// Migrations 0080 / 0081: the human-only and consume columns on approvals, autonomy_categories.human_only,
// the approval_events journal, and the DB functions that read and write them. The decisions that use
// them (who may decide a human-only row, the consume step) are later steps; this pins the schema and
// the storage layer only.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  initDatabase, getDb, createApproval, getApproval, resolveApproval,
  recordApprovalEvent, listApprovalEvents,
} from '../db.js'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

function columns(db: Database.Database, table: string): Record<string, { type: string; notnull: number; dflt: string | null }> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[]
  return Object.fromEntries(rows.map((r) => [r.name, { type: r.type, notnull: r.notnull, dflt: r.dflt_value }]))
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('the schema after migrations 0080 and 0081', () => {
  it('approvals carries the human-only, resolver-path, content-hash and consume columns', () => {
    const c = columns(getDb(), 'approvals')
    expect(c.human_only).toMatchObject({ type: 'INTEGER', notnull: 1, dflt: '0' })
    expect(c.resolved_via.type).toBe('TEXT')
    expect(c.content_hash.type).toBe('TEXT')
    expect(c.consumed_at.type).toBe('INTEGER')
    expect(c.consumed_by.type).toBe('TEXT')
    expect(c.consumed_ref.type).toBe('TEXT')
  })

  it('autonomy_categories carries human_only, off for every seeded category', () => {
    const db = getDb()
    expect(columns(db, 'autonomy_categories').human_only).toMatchObject({ type: 'INTEGER', notnull: 1, dflt: '0' })
    const on = db.prepare('SELECT COUNT(*) AS n FROM autonomy_categories WHERE human_only != 0').get() as { n: number }
    expect(on.n).toBe(0)
  })

  it('approval_events exists with a tenant column and no CHECK on the event kind', () => {
    const db = getDb()
    const c = columns(db, 'approval_events')
    expect(Object.keys(c)).toEqual(['id', 'approval_id', 'tenant_id', 'event', 'reason', 'actor', 'ref', 'created_at'])
    expect(c.tenant_id.dflt).toBe("'default'")
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'approval_events'").get() as { sql: string }).sql
    expect(ddl).not.toMatch(/CHECK/i)
  })

  it('has the lookup indexes', () => {
    const names = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name)
    expect(names).toContain('idx_approval_events_approval')
    expect(names).toContain('idx_approvals_category_hash')
  })

  it('0080 is a pure ADD COLUMN migration, so the runner tolerates a column that is already there', () => {
    const sql = readFileSync(join(MIGRATIONS, '0080_approvals_human_only_and_consume_columns.sql'), 'utf8')
    const statements = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements.length).toBe(7)
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE\s+\w+\s+ADD COLUMN\s+/i)
  })
})

describe('createApproval / getApproval / resolveApproval with the new columns', () => {
  const base = { id: 'ap-1', agent_id: 'worker', category: 'email_send', action_description: 'send a mail' }
  const HASH = 'a'.repeat(64)

  it('an approval made without the new fields has them off / empty', async () => {
    const made = await createApproval(base)
    expect(made).toMatchObject({ human_only: 0, resolved_via: null, content_hash: null, consumed_at: null, consumed_by: null, consumed_ref: null })
    expect(await getApproval('ap-1')).toMatchObject({ human_only: 0, content_hash: null, consumed_at: null })
  })

  it('stores the human-only snapshot and the content hash, and returns them from both calls', async () => {
    const made = await createApproval({ ...base, human_only: true, content_hash: HASH })
    expect(made).toMatchObject({ human_only: 1, content_hash: HASH })
    expect(await getApproval('ap-1')).toMatchObject({ human_only: 1, content_hash: HASH, consumed_at: null })
  })

  it('resolveApproval records how the decision arrived, and keeps it NULL when the caller says nothing', async () => {
    await createApproval(base)
    await createApproval({ ...base, id: 'ap-2' })
    expect(await resolveApproval('ap-1', 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
    expect(await resolveApproval('ap-2', 'rejected', 'someone')).toBe(true)
    expect(await getApproval('ap-1')).toMatchObject({ status: 'approved', resolved_by: 'human:session:owner', resolved_via: 'dashboard_session' })
    expect(await getApproval('ap-2')).toMatchObject({ status: 'rejected', resolved_via: null })
  })

  it('a decided approval is not decided twice (the existing guard still holds)', async () => {
    await createApproval(base)
    expect(await resolveApproval('ap-1', 'approved', 'a', null, 'bearer')).toBe(true)
    expect(await resolveApproval('ap-1', 'rejected', 'b', null, 'dashboard_session')).toBe(false)
    expect(await getApproval('ap-1')).toMatchObject({ status: 'approved', resolved_via: 'bearer' })
  })
})

describe('the approval journal', () => {
  it('records events with their tenant and returns them oldest first', async () => {
    await recordApprovalEvent({ approval_id: 'ap-1', event: 'consume_refused', reason: 'hash_mismatch', actor: 'worker', ref: 'req-1', tenant_id: 't-a' })
    await recordApprovalEvent({ approval_id: 'ap-1', event: 'consumed', actor: 'worker' })
    await recordApprovalEvent({ approval_id: 'ap-2', event: 'bearer_denied', reason: 'human_only_category' })
    const events = await listApprovalEvents('ap-1')
    expect(events.map((e) => e.event)).toEqual(['consume_refused', 'consumed'])
    expect(events[0]).toMatchObject({ approval_id: 'ap-1', tenant_id: 't-a', reason: 'hash_mismatch', actor: 'worker', ref: 'req-1' })
    expect(events[1]).toMatchObject({ tenant_id: 'default', reason: null, ref: null })
    expect(typeof events[0].created_at).toBe('number')
    expect(await listApprovalEvents('ap-2')).toHaveLength(1)
    expect(await listApprovalEvents('nope')).toEqual([])
  })
})

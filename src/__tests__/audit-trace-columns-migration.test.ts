// Migration 0088 (the trace columns of the journal tables), SQLite only. Its subject is the SQLite side: the plain ADD COLUMN
// statements the runner may run again over a half-applied database, and the SQLite column shape (PRAGMA table_info). The
// PostgreSQL baseline carries the same columns in its CREATE TABLE statements; the writers that fill them are tested on both
// engines in audit-trace-columns.test.ts. This file does not use useTestDb (it opens its own in-memory database), so it is
// in neither the PORTED nor the EXCLUDED list.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { applyMigrations } from '../db-migrations.js'

const TABLES = [
  'agent_audit_log', 'hook_audit_log', 'approval_events', 'rbac_shadow_log', 'config_change_log',
  'fleet_blackboard_history', 'kanban_card_events',
] as const

describe('migration 0088', () => {
  it('adds a nullable trace_id and span_id to the seven journal tables, with no default', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      for (const table of TABLES) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>
        for (const name of ['trace_id', 'span_id']) {
          const c = cols.find((x) => x.name === name)
          expect(c, `${table}.${name}`).toBeDefined()
          expect(c).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
        }
      }
    } finally {
      db.close()
    }
  })

  it('is nothing but plain ADD COLUMN statements (the runner tolerates a half-applied run only for those)', () => {
    const sql = readFileSync(new URL('../migrations/0088_audit_trace_columns.sql', import.meta.url), 'utf8')
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(14)
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE [a-z_]+ ADD COLUMN (trace_id|span_id) TEXT$/)
    // every table of the list, both columns, once
    expect(new Set(statements).size).toBe(14)
    for (const t of TABLES) for (const c of ['trace_id', 'span_id']) expect(statements).toContain(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`)
  })

  it('runs again over a half-applied database without an error and keeps the old rows NULL', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      db.prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('k', 'a', 'b', 'user-a', 1)").run()
      db.prepare('DELETE FROM schema_version WHERE version = 88').run()
      expect(() => applyMigrations(db)).not.toThrow()
      expect(db.prepare('SELECT 1 FROM schema_version WHERE version = 88').get()).toBeTruthy()
      expect(db.prepare('SELECT trace_id, span_id FROM config_change_log').get()).toEqual({ trace_id: null, span_id: null })
    } finally {
      db.close()
    }
  })
})

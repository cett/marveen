// Verifies migration 0034: tenant isolation for import_sources / import_audit_log.
//
// Unlike 0031/0033 (derived from tenant_agent_availability), import_sources
// has no per-agent signal to derive tenant_id from -- existing rows simply
// default to 'default'. import_audit_log inherits its tenant_id from the
// parent source via source_id.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_PATH = join(__dirname, '../../src/migrations/0034_import_sources_tenant.sql')

function reapplyBackfill(db: Database.Database): void {
  // The ALTER TABLE lines only run once (0034 is already applied by
  // initDatabase's normal migration pass) -- skip them and re-run just the
  // backfill UPDATE + index creation to simulate rows that predate the
  // migration.
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const withoutAlter = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('ALTER TABLE'))
    .join('\n')
  db.exec(withoutAlter)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('Migration 0034 -- import_sources / import_audit_log tenant_id', () => {
  it('a new import_sources row defaults to tenant_id "default"', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at)
      VALUES ('mig-src-1', 'local', '/tmp/mig', 4, 1, ?, ?)
    `).run(now, now)

    const row = db.prepare("SELECT tenant_id FROM import_sources WHERE id = 'mig-src-1'").get() as { tenant_id: string }
    expect(row.tenant_id).toBe('default')
  })

  it('backfills import_audit_log.tenant_id from its parent source', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
      VALUES ('mig-src-2', 'local', '/tmp/mig2', 4, 1, ?, ?, 'tenant-mig')
    `).run(now, now)

    // Simulate a pre-migration audit row: tenant_id lands on the column
    // DEFAULT ('default') since the insert below doesn't set it explicitly.
    db.prepare(`
      INSERT INTO import_audit_log (source_id, run_at, files_scanned, files_added, files_updated,
        files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type)
      VALUES ('mig-src-2', ?, 3, 1, 0, 0, 0, 0, 0)
    `).run(now)

    const before = db.prepare("SELECT tenant_id FROM import_audit_log WHERE source_id = 'mig-src-2'").get() as { tenant_id: string }
    expect(before.tenant_id).toBe('default')

    reapplyBackfill(db)

    const after = db.prepare("SELECT tenant_id FROM import_audit_log WHERE source_id = 'mig-src-2'").get() as { tenant_id: string }
    expect(after.tenant_id).toBe('tenant-mig')
  })

  it('is idempotent -- running the backfill twice in a row does not change the result', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
      VALUES ('mig-src-3', 'local', '/tmp/mig3', 4, 1, ?, ?, 'tenant-idem')
    `).run(now, now)
    db.prepare(`
      INSERT INTO import_audit_log (source_id, run_at, files_scanned, files_added, files_updated,
        files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type)
      VALUES ('mig-src-3', ?, 1, 0, 0, 0, 0, 0, 0)
    `).run(now)

    reapplyBackfill(db)
    reapplyBackfill(db)

    const row = db.prepare("SELECT tenant_id FROM import_audit_log WHERE source_id = 'mig-src-3'").get() as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-idem')
  })

  it('creates the tenant indexes on import_sources and import_audit_log', () => {
    const db = getDb()
    const sourceIndexes = db.prepare("PRAGMA index_list(import_sources)").all() as { name: string }[]
    const auditIndexes = db.prepare("PRAGMA index_list(import_audit_log)").all() as { name: string }[]
    expect(sourceIndexes.some(i => i.name === 'idx_import_sources_tenant')).toBe(true)
    expect(auditIndexes.some(i => i.name === 'idx_import_audit_tenant')).toBe(true)
  })
})

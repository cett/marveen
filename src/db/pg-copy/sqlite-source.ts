// The SQLite side of the copy tool (P-G1): a snapshot of the live file, read-only, and the readers of its schema and rows.
//
// The copy never reads the live file. The snapshot is taken with the SQLite backup API into a directory the tool creates
// (mode 0700) and removes at the end, so a running dashboard cannot move the ground under the read. The final cutover still
// runs with the fleet stopped; the snapshot is what makes a rehearsal on a live system safe.

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqliteTable } from './schema.js'

export interface SqliteSnapshot {
  /** the snapshot, read-only, with integers read as bigint (the coercion takes them exactly) */
  db: Database.Database
  /** the directory that holds the snapshot file; removed by close() */
  dir: string
  close(): void
}

/** Copies the live database with the backup API into a private directory and opens the copy read-only. */
export async function openSnapshot(livePath: string): Promise<SqliteSnapshot> {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-pg-copy-'))
  const file = join(dir, 'snapshot.db')
  try {
    const live = new Database(livePath, { readonly: true, fileMustExist: true })
    try {
      await live.backup(file)
    } finally {
      live.close()
    }
    const db = new Database(file, { readonly: true, fileMustExist: true })
    db.defaultSafeIntegers(true)
    let closed = false
    return {
      db,
      dir,
      close(): void {
        if (closed) return
        closed = true
        db.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

/** `"name"` with embedded quotes doubled: the only identifier quoting the readers need (table names come from sqlite_master). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** PRAGMA integrity_check answers one row 'ok' on a sound file; anything else is the list of problems. */
export function integrityProblems(db: Database.Database): string[] {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  return rows.map((r) => r.integrity_check).filter((line) => line !== 'ok')
}

/** Every table of the SQLite side with its columns, in name order. Views and indexes are not tables and are left out. */
export function readSqliteTables(db: Database.Database): SqliteTable[] {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string; sql: string | null }>
  return tables.map(({ name, sql }) => {
    // A virtual table is never PRAGMA-read: its module may not be loaded by this snapshot (opened without sqlite-vec), and
    // PRAGMA table_info would fail with "no such module". It is listed with no columns. The skip list (skipReason) decides
    // by name: a known vec0 index (vec_*) or FTS5 table is skipped; any other virtual table is refused by planSchema, which
    // finds no PostgreSQL table for it. The shadow tables of a vec0 index are ordinary vec_* tables, skipped by name.
    if (sql !== null && VIRTUAL_TABLE.test(sql)) return { name, columns: [] }
    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{ name: string; type: string }>
    return {
      name,
      columns: cols.map((c) => ({ name: c.name, declaredType: c.type })),
    }
  })
}

/** The CREATE statement of a virtual table (sqlite_master.sql): any module, vec0 and FTS5 alike. */
const VIRTUAL_TABLE = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i

/** The highest version of the SQLite migration bookkeeping, or undefined when the database has no schema_version table. */
export function schemaVersionMax(db: Database.Database): number | undefined {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
  if (!exists) return undefined
  const row = db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: bigint | number | null }
  if (row.v === null) return undefined
  return Number(row.v)
}

/** The rows of a table, counted. */
export function sqliteRowCount(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get() as { n: bigint | number }
  return Number(row.n)
}

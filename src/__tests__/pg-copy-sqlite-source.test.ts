// The SQLite table reader on a live database that holds a real vec0 index (P-G1 c1 fixup). The copy opens its snapshot
// without sqlite-vec, so the vec0 table must not be PRAGMA-read ("no such module: vec0"). Its shadow tables are ordinary
// tables named vec_*, and skipReason skips both by name. No PostgreSQL needed.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as loadSqliteVec } from 'sqlite-vec'
import { afterAll, describe, expect, it } from 'vitest'
import { skipReason } from '../db/pg-copy/schema.js'
import { readSqliteTables } from '../db/pg-copy/sqlite-source.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A live database with one regular table and a real vec0 index; the extension is loaded only to build it. */
function buildLive(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-vec0-'))
  dirs.push(dir)
  const file = join(dir, 'live.db')
  const db = new Database(file)
  loadSqliteVec(db)
  db.exec('CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
  db.exec("INSERT INTO kanban_cards (id, title) VALUES ('kanban-one', 'first card')")
  db.exec('CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[4])')
  db.prepare('INSERT INTO vec_memories (rowid, embedding) VALUES (1, ?)').run(Buffer.from(new Float32Array([1, 2, 3, 4]).buffer))
  db.close()
  return file
}

describe('the table reader on a vec0 index: the vec0 table is not read, its vec_* tables are skipped by name', () => {
  it('reads the regular tables with their columns; the vec0 table and each shadow table are named vec_* and have a skip reason', () => {
    // opened the way the copy opens its snapshot: no sqlite-vec loaded
    const db = new Database(buildLive(), { readonly: true, fileMustExist: true })
    try {
      const tables = readSqliteTables(db)
      const byName = new Map(tables.map((t) => [t.name, t]))
      expect(byName.get('kanban_cards')?.columns.map((c) => c.name)).toEqual(['id', 'title'])
      expect(byName.get('vec_memories')?.columns).toEqual([])
      const vecNames = tables.map((t) => t.name).filter((n) => n.startsWith('vec_'))
      expect(vecNames).toContain('vec_memories')
      expect(vecNames.length).toBeGreaterThan(1) // the shadow tables of the index are listed as ordinary tables
      for (const n of vecNames) expect(skipReason(n), n).toBeDefined()
    } finally {
      db.close()
    }
  })
})

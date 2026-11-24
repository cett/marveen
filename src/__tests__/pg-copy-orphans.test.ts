// The orphan scan of the copy tool (P-G1) on a SQLite snapshot alone: the keys are the PostgreSQL catalog's, passed in by
// hand here; the catalog itself is read by the PostgreSQL cells (pg-copy-check.pg.test.ts). The database is opened read-only,
// as the snapshot is, so the scan proves it writes nothing but its temporary sets.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ORPHAN_SAMPLE_ROWIDS, orphanRefusals, scanOrphans, uncoveredPolicyEdges } from '../db/pg-copy/orphans.js'
import type { PgForeignKey, TableMapping } from '../db/pg-copy/schema.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A SQLite file with the given DDL and rows; opened read-only for the scan. */
function snapshot(setup: string): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-orphans-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const w = new Database(file)
  w.exec(setup)
  w.close()
  const r = new Database(file, { readonly: true, fileMustExist: true })
  r.defaultSafeIntegers(true)
  return r
}

/** A mapping for every table of the database, every column text (the scan reads columns by name, the types are not its concern). */
function mappingsOf(db: Database.Database): TableMapping[] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
  return names.map((name) => {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>
    return {
      name,
      columns: cols.map((c) => ({ name: c.name, pgType: 'text', flag: false, fromRowid: false })),
      leftToDatabase: [],
      identityColumns: [],
    }
  })
}

function fk(name: string, table: string, columns: string[], refTable: string, refColumns: string[], matchSimple = true): PgForeignKey {
  return { name, table, columns, refTable, refColumns, matchSimple }
}

const PARENT_CHILD = `
  CREATE TABLE parent (id TEXT PRIMARY KEY);
  CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT, note TEXT);
  CREATE TABLE grand (id INTEGER PRIMARY KEY, child_id INTEGER);
  INSERT INTO parent VALUES ('p-ok');
  INSERT INTO child (id, parent_id, note) VALUES (1, 'p-ok', 'fine'), (2, 'gone-a', 'VALUE-SECRET-42'), (3, 'gone-b', 'x'), (4, NULL, 'no parent key');
  INSERT INTO grand (id, child_id) VALUES (1, 1), (2, 2), (3, 3), (4, 99);
`

describe('the orphan scan: one finding per key, the closure, the NULL rule', () => {
  it('a child whose parent is missing is an orphan; the grandchild of an orphan is an orphan too; a NULL key is not checked', () => {
    const db = snapshot(PARENT_CHILD)
    // the grandchild's key is listed first: a single pass would find the child orphans only after it has looked at grand
    const fks = [
      fk('grand_child_fk', 'grand', ['child_id'], 'child', ['id']),
      fk('child_parent_fk', 'child', ['parent_id'], 'parent', ['id']),
    ]
    const scan = scanOrphans(db, mappingsOf(db), fks)
    expect(scan.problems).toEqual([])
    expect([...scan.orphans.get('child')!].map(String).sort()).toEqual(['2', '3'])
    // grand 2 (child 2 is an orphan), grand 3 (child 3 is an orphan), grand 4 (child 99 is missing); grand 1 is fine
    expect([...scan.orphans.get('grand')!].map(String).sort()).toEqual(['2', '3', '4'])
    expect(scan.findings.map((f) => [f.constraint, f.count])).toEqual([
      ['grand_child_fk', 3],
      ['child_parent_fk', 2],
    ])
    db.close()
  })

  it('a self reference: a row whose parent is missing is an orphan, and so is every row below it (the closure over the same table)', () => {
    const db = snapshot(`
      CREATE TABLE node (id TEXT PRIMARY KEY, parent_id TEXT);
      INSERT INTO node (id, parent_id) VALUES ('root', NULL), ('mid', 'root'), ('lost', 'nowhere'), ('below-lost', 'lost'), ('deep', 'below-lost');
    `)
    const scan = scanOrphans(db, mappingsOf(db), [fk('node_parent_fk', 'node', ['parent_id'], 'node', ['id'])])
    expect([...scan.orphans.get('node')!].map(String).sort()).toEqual(['3', '4', '5'])
    expect(scan.findings).toEqual([expect.objectContaining({ constraint: 'node_parent_fk', count: 3, rowids: ['3', '4', '5'] })])
    db.close()
  })

  it('a composite key with one NULL component is not checked; with both components set and no match it is an orphan', () => {
    const db = snapshot(`
      CREATE TABLE pair_parent (a TEXT, b TEXT, PRIMARY KEY (a, b));
      CREATE TABLE pair_child (id INTEGER PRIMARY KEY, a TEXT, b TEXT);
      INSERT INTO pair_parent VALUES ('k', 'ok');
      INSERT INTO pair_child (id, a, b) VALUES (1, 'k', 'ok'), (2, NULL, 'missing'), (3, 'k', 'missing'), (4, NULL, NULL);
    `)
    const scan = scanOrphans(db, mappingsOf(db), [fk('pair_fk', 'pair_child', ['a', 'b'], 'pair_parent', ['a', 'b'])])
    expect([...scan.orphans.get('pair_child')!].map(String)).toEqual(['3'])
    db.close()
  })

  it('a parent table that is not in the source: every child row with a key value is an orphan, and the finding says so', () => {
    const db = snapshot(`
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT);
      INSERT INTO child (id, parent_id) VALUES (1, 'a'), (2, NULL), (3, 'b');
    `)
    const scan = scanOrphans(db, mappingsOf(db), [fk('child_gone_fk', 'child', ['parent_id'], 'pgonly_parent', ['id'])])
    expect([...scan.orphans.get('child')!].map(String).sort()).toEqual(['1', '3'])
    expect(scan.findings[0]).toEqual(expect.objectContaining({ parentInSource: false, count: 2 }))
    db.close()
  })
})

describe('the orphan scan: the sample, the refusal text, the scan writes nothing', () => {
  it('the live-shape counts: one finding per key, the exact count, at most 20 rowids, and no value in the text', () => {
    const rows = Array.from({ length: ORPHAN_SAMPLE_ROWIDS + 1 }, (_, i) => `(${i + 1}, 'gone-${i}', 'VALUE-SECRET-${i}')`).join(', ')
    const db = snapshot(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT, note TEXT);
      INSERT INTO child (id, parent_id, note) VALUES ${rows};
    `)
    const scan = scanOrphans(db, mappingsOf(db), [fk('child_parent_fk', 'child', ['parent_id'], 'parent', ['id'])])
    const refusals = orphanRefusals(scan.findings)
    expect(scan.findings).toEqual([expect.objectContaining({ count: ORPHAN_SAMPLE_ROWIDS + 1 })])
    expect(scan.findings[0]!.rowids).toHaveLength(ORPHAN_SAMPLE_ROWIDS)
    expect(scan.findings[0]!.rowids[0]).toBe('1')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.table).toBe('child')
    expect(refusals[0]!.reason).toMatch(/child_parent_fk/)
    expect(refusals[0]!.reason).toMatch(/21 orphan row/)
    expect(JSON.stringify(refusals)).not.toMatch(/VALUE-SECRET/)
    db.close()
  })

  it('the scan leaves no temporary set behind and the file is unchanged (the snapshot is read-only)', () => {
    const db = snapshot(PARENT_CHILD)
    scanOrphans(db, mappingsOf(db), [fk('child_parent_fk', 'child', ['parent_id'], 'parent', ['id'])])
    const temps = db.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table'").all()
    expect(temps).toEqual([])
    db.close()
  })

  it('a key the scan cannot model is a named problem, never a silent pass: MATCH FULL, and a key column with no SQLite column', () => {
    const db = snapshot(PARENT_CHILD)
    const mappings = mappingsOf(db)
    const full = scanOrphans(db, mappings, [fk('child_full_fk', 'child', ['parent_id'], 'parent', ['id'], false)])
    expect(full.problems).toEqual([expect.objectContaining({ table: 'child', reason: expect.stringMatching(/MATCH SIMPLE/) })])
    const missing = scanOrphans(db, mappings, [fk('child_ghost_fk', 'child', ['ghost_column'], 'parent', ['id'])])
    expect(missing.problems).toEqual([expect.objectContaining({ table: 'child', column: 'ghost_column' })])
    expect(missing.findings).toEqual([])
    db.close()
  })
})

describe('policy edges: a row-level policy that reads a parent is listed when no foreign key backs its pair', () => {
  it('an edge of a copied table with no foreign key on its pair is listed; an edge with one, or of a table not copied, is not', () => {
    const edges = [
      { table: 'kanban_comments', refTable: 'kanban_cards', policy: 'via_parent' },
      { table: 'memory_versions', refTable: 'memories', policy: 'via_parent' },
      { table: 'memory_embeddings', refTable: 'memories', policy: 'via_parent' },
    ]
    const mappings: TableMapping[] = ['kanban_comments', 'memory_versions'].map((name) => ({ name, columns: [], leftToDatabase: [], identityColumns: [] }))
    const fks = [fk('memory_versions_memory_fk', 'memory_versions', ['memory_id'], 'memories', ['id'])]
    // memory_embeddings is not copied (no mapping): its edge is not this tool's concern
    expect(uncoveredPolicyEdges(edges, fks, mappings)).toEqual([edges[0]])
  })
})

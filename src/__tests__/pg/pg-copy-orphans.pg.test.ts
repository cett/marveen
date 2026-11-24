// The orphan rows and the dependency order of the copy tool (P-G1) against a real PostgreSQL 16 target: skip mode (O4), the
// self-reference order (S1), the self-reference cycle (S2) and the order is kept by depth only where a table has a self
// reference (S3). The SQLite side is the real migration chain; the orphan rows are the live shape (no parent row).
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { connect, preconditions, runCheck } from '../../db/pg-copy/check.js'
import { runCopy, type CopyReport } from '../../db/pg-copy/copy.js'
import { openSnapshot } from '../../db/pg-copy/sqlite-source.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A SQLite database built by the migration chain; `extra` runs with the foreign keys off (SQLite declares them, the live data breaks them). */
function buildSqlite(extra: (db: Database.Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-orphans-pg-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const db = new Database(file)
  applyMigrations(db)
  db.pragma('foreign_keys = OFF')
  extra(db)
  db.close()
  return file
}

let target: PgTestDb | undefined

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

async function freshTarget(): Promise<PgTestDb> {
  target = await createPgTestDb()
  return target
}

/** Rows of the copied tables this cell touches, summed: 0 on a target the copy did not write into. */
async function rowsOf(t: PgTestDb, table: string): Promise<number> {
  const r = await t.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`)
  return Number(r.rows[0]?.n)
}

describe('skip mode: the orphans and every row below them are left out; the rest is copied and verified', () => {
  it('the copy is green, the report names the orphans first, the target has exactly the rows that were not orphans', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      db.exec(`
        INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id) VALUES
          ('kc-root', 'root', 'planned', 'normal', 0, 1, 1, NULL),
          ('kc-ok', 'fine child', 'planned', 'normal', 0, 1, 1, 'kc-root'),
          ('kc-gone', 'parent missing', 'planned', 'normal', 0, 1, 1, 'kc-missing'),
          ('kc-below', 'below the orphan', 'planned', 'normal', 0, 1, 1, 'kc-gone');
        INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type)
          VALUES (999, 'orphaned version', 'c', 1, 'agent-a', 'create');
      `)
    })
    const report: CopyReport = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false, orphans: 'skip' })
    expect(report.notice).toMatch(/^orphans skipped \(--orphans skip\): 3 row\(s\) in 2 table\(s\)/)
    expect(JSON.stringify(report).indexOf('"notice"')).toBeLessThan(JSON.stringify(report).indexOf('"ok"'))
    expect(report.refusals).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.committed).toBe(true)
    expect(report.orphans.map((f) => [f.table, f.count])).toEqual([
      ['kanban_cards', 2],
      ['memory_versions', 1],
    ])
    const kanban = report.tables.find((x) => x.name === 'kanban_cards')!
    expect(kanban).toEqual(expect.objectContaining({ sourceRows: 4, writtenRows: 2, skippedRows: 2 }))
    expect(report.verified.map((v) => v.table)).toEqual(expect.arrayContaining(['kanban_cards', 'memory_versions']))
    expect(await rowsOf(t, 'kanban_cards')).toBe(2)
    expect(await rowsOf(t, 'memory_versions')).toBe(0)
    expect(JSON.stringify(report)).not.toMatch(/orphaned version|parent missing/)
  })
})

describe('the self-reference order: a child is written after its parent, whatever its rowid', () => {
  it('a chain of depth three with children that have lower rowids than their parents copies green and keeps every link', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      // the live shape: the leaf is rowid 1 (the first copy chunk, 500 rows) and its parent is rowid 600 (the second chunk),
      // so a rowid-order write refuses the leaf. A parent in the same INSERT would hide the order: PostgreSQL checks a
      // non-deferred key at the end of each statement.
      db.exec(`
        INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id) VALUES
          ('kc-leaf', 'leaf', 'planned', 'normal', 0, 1, 1, 'kc-mid');
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 598)
          INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id)
          SELECT 'kc-fill-' || i, 'filler', 'planned', 'normal', 0, 1, 1, NULL FROM n;
        INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id) VALUES
          ('kc-mid', 'middle', 'planned', 'normal', 0, 1, 1, 'kc-root'),
          ('kc-root', 'root', 'planned', 'normal', 0, 1, 1, NULL),
          ('kc-deep', 'deep', 'planned', 'normal', 0, 1, 1, 'kc-leaf'),
          ('kc-sib', 'sibling', 'planned', 'normal', 0, 1, 1, 'kc-root');
      `)
    })
    const report = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false })
    expect(report.failure).toBeUndefined()
    expect(report.ok).toBe(true)
    expect(report.committed).toBe(true)
    expect(report.tables.find((x) => x.name === 'kanban_cards')).toEqual(expect.objectContaining({ sourceRows: 603, writtenRows: 603, skippedRows: 0 }))
    const links = await t.pool.query<{ id: string; parent_id: string | null }>(
      "SELECT id, parent_id FROM kanban_cards WHERE id LIKE 'kc-%' AND id NOT LIKE 'kc-fill-%' ORDER BY id",
    )
    expect(links.rows).toEqual([
      { id: 'kc-deep', parent_id: 'kc-leaf' },
      { id: 'kc-leaf', parent_id: 'kc-mid' },
      { id: 'kc-mid', parent_id: 'kc-root' },
      { id: 'kc-root', parent_id: null },
      { id: 'kc-sib', parent_id: 'kc-root' },
    ])
  })

  it('a parent loop (no root reaches the cycle) is refused by name with its rowids; nothing is written', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      db.exec(`
        INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id) VALUES
          ('kc-a', 'a', 'planned', 'normal', 0, 1, 1, 'kc-b'),
          ('kc-b', 'b', 'planned', 'normal', 0, 1, 1, 'kc-a');
      `)
    })
    const report = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual([
      expect.objectContaining({ table: 'kanban_cards', reason: expect.stringMatching(/self-reference cycle: 2 row\(s\).*rowids: 1, 2/) }),
    ])
    expect(await rowsOf(t, 'kanban_cards')).toBe(0)
  })

  it('the second self-referencing table (api_tokens.rotated_from) gets the same order: a leaf with a lower rowid than its parent copies green', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      // the leaf is rowid 1 (the first chunk, 500 rows) and its parent is rowid 600 (the second chunk): a rowid-order write
      // refuses the leaf on rotated_from. The root is rowid 900, its own parent NULL.
      db.exec(`
        INSERT INTO api_tokens (id, token_hash, name, role, tenant_id, created_at, rotated_from) VALUES
          (1, 'h-leaf', 'leaf', 'agent', 'default', 1, 600);
        WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 599)
          INSERT INTO api_tokens (id, token_hash, name, role, tenant_id, created_at, rotated_from)
          SELECT i, 'h-fill-' || i, 'filler', 'agent', 'default', 1, NULL FROM n;
        INSERT INTO api_tokens (id, token_hash, name, role, tenant_id, created_at, rotated_from) VALUES
          (600, 'h-mid', 'mid', 'agent', 'default', 1, 900),
          (900, 'h-root', 'root', 'agent', 'default', 1, NULL);
      `)
    })
    const report = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false })
    expect(report.failure).toBeUndefined()
    expect(report.ok).toBe(true)
    expect(report.committed).toBe(true)
    expect(report.tables.find((x) => x.name === 'api_tokens')).toEqual(expect.objectContaining({ sourceRows: 601, writtenRows: 601, skippedRows: 0 }))
    const links = await t.pool.query<{ token_hash: string; rotated_from: string | null }>(
      "SELECT a.token_hash, b.token_hash AS rotated_from FROM api_tokens a LEFT JOIN api_tokens b ON b.id = a.rotated_from WHERE a.token_hash IN ('h-leaf', 'h-mid', 'h-root') ORDER BY a.token_hash",
    )
    expect(links.rows).toEqual([
      { token_hash: 'h-leaf', rotated_from: 'h-mid' },
      { token_hash: 'h-mid', rotated_from: 'h-root' },
      { token_hash: 'h-root', rotated_from: null },
    ])
  })

  it('only the tables with a self reference have a depth table (kanban_cards.parent_id, api_tokens.rotated_from): the rest is read by rowid', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite(() => {})
    const snapshot = await openSnapshot(sqlitePath)
    const client = await connect(t.ownerUrl)
    try {
      const pre = await preconditions(snapshot.db, client)
      expect([...pre.depthTables.keys()].sort()).toEqual(['api_tokens', 'kanban_cards'])
      expect(pre.report.notice).toBe('')
    } finally {
      await client.end()
      snapshot.close()
    }
  })

  it('check in skip mode is green and says what it leaves out; check in refuse mode refuses the same orphans', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      db.exec(`INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type) VALUES (999, 'x', 'c', 1, 'agent-a', 'create')`)
    })
    const refuse = await runCheck({ sqlitePath, pgUrl: t.ownerUrl })
    expect(refuse.ok).toBe(false)
    expect(refuse.notice).toBe('')
    const skip = await runCheck({ sqlitePath, pgUrl: t.ownerUrl, orphans: 'skip' })
    expect(skip.notice).toMatch(/^orphans skipped/)
    expect(skip.refusals.filter((r) => /orphan row/.test(r.reason))).toEqual([])
    expect(skip.plan.orphans.map((f) => f.table)).toEqual(['memory_versions'])
  })
})

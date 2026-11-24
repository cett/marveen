// The differential cell of the copy tool (P-G1, spec 2.7): a SQLite database built by the real migration chain with at least
// one row in EVERY mapped table, copied whole into a clone of the PostgreSQL baseline. Every copied table is read back and
// fingerprinted by the copy itself (a mismatch stops the run); here the counts and the identity sequences are checked
// against the SQLite side as well.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { runCopy } from '../../db/pg-copy/copy.js'
import { skipReason } from '../../db/pg-copy/schema.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

let target: PgTestDb | undefined

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

/** A generic value for a NOT NULL column with no default: a value of its declared type, or the first literal of its IN list. */
function valueFor(c: ColumnInfo, table: string): unknown {
  const type = c.type.toUpperCase()
  if (c.pk > 0 && type.includes('TEXT')) return `pk-${table}`
  if (type.includes('INT')) return 1
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 1.0
  if (type.includes('BLOB')) return Buffer.from([0x61])
  return `v-${c.name}`
}

/** One row in one table: the foreign keys point at a row of the parent, the CHECK IN lists take their first literal. */
function fillOne(db: Database.Database, table: string, sql: string, fks: Array<{ table: string; from: string; to: string }>): void {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[]
  const checkIn = new Map<string, string>()
  for (const m of sql.matchAll(/\b(\w+)\s+IN\s*\(\s*'([^']*)'/g)) {
    if (!checkIn.has(m[1]!)) checkIn.set(m[1]!, m[2]!)
  }
  const fkByColumn = new Map(fks.map((f) => [f.from, f]))
  const pkColumns = cols.filter((c) => c.pk > 0)
  const values: Array<[string, unknown]> = []
  for (const c of cols) {
    // a single INTEGER primary key is the rowid, which SQLite assigns; a column of a composite key is not
    if (pkColumns.length === 1 && c.pk > 0 && /^INTEGER$/i.test(c.type)) continue
    const fk = fkByColumn.get(c.name)
    if (fk) {
      if (fk.table === table) continue // a self reference: the parent row is not needed, the column may stay NULL
      const parent = db.prepare(`SELECT "${fk.to}" AS v FROM "${fk.table}" LIMIT 1`).get() as { v: unknown } | undefined
      if (parent) values.push([c.name, parent.v])
      continue
    }
    if (checkIn.has(c.name)) {
      values.push([c.name, checkIn.get(c.name)])
      continue
    }
    // a PRIMARY KEY column is filled even when SQLite reports it nullable (a TEXT key is not flagged NOT NULL)
    if ((c.notnull || c.pk > 0) && c.dflt_value == null) values.push([c.name, valueFor(c, table)])
  }
  try {
    if (values.length === 0) {
      db.exec(`INSERT INTO "${table}" DEFAULT VALUES`)
      return
    }
    const names = values.map(([n]) => `"${n}"`).join(', ')
    const marks = values.map(() => '?').join(', ')
    db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${marks})`).run(...values.map(([, v]) => v))
  } catch (err) {
    throw new Error(`filler: ${table} (${values.map(([n]) => n).join(', ') || 'DEFAULT VALUES'}): ${(err as Error).message}`)
  }
}

/**
 * Parents that SQLite does not declare but the PostgreSQL row-level security policy requires (WITH CHECK EXISTS on the parent):
 * a comment row needs its idea. Without these the filler writes a comment whose idea is missing, and PostgreSQL refuses it.
 */
const POLICY_PARENTS: Record<string, Array<{ from: string; table: string; to: string }>> = {
  artifact_embeddings: [{ from: 'artifact_id', table: 'artifacts', to: 'id' }],
  idea_comments: [{ from: 'idea_id', table: 'idea_box', to: 'id' }],
  idea_status_log: [{ from: 'idea_id', table: 'idea_box', to: 'id' }],
  kanban_card_events: [{ from: 'card_id', table: 'kanban_cards', to: 'id' }],
  kanban_card_labels: [{ from: 'card_id', table: 'kanban_cards', to: 'id' }],
  kanban_comments: [{ from: 'card_id', table: 'kanban_cards', to: 'id' }],
  memory_embeddings: [{ from: 'memory_id', table: 'memories', to: 'id' }],
  memory_versions: [{ from: 'memory_id', table: 'memories', to: 'id' }],
  skill_revision_files: [{ from: 'revision_id', table: 'skill_revisions', to: 'id' }],
  span_reads: [{ from: 'memory_id', table: 'memories', to: 'id' }],
  workspace_doc_embeddings: [{ from: 'doc_id', table: 'workspace_docs', to: 'id' }],
  skill_files: [{ from: 'skill_id', table: 'skills', to: 'id' }],
}

/** One row in every mapped table, parents first. The fixture is written with the constraints off (the PostgreSQL side has them on). */
function fillEveryTable(db: Database.Database): void {
  db.pragma('foreign_keys = OFF')
  db.pragma('ignore_check_constraints = ON')
  const pending = new Map(
    (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string; sql: string }>)
      .filter((t) => skipReason(t.name) === undefined)
      .map((t) => [t.name, t.sql]),
  )
  const fksOf = (name: string) => [
    ...(db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{ table: string; from: string; to: string }>),
    ...(POLICY_PARENTS[name] ?? []),
  ]
  let progress = true
  while (pending.size > 0 && progress) {
    progress = false
    for (const [name, sql] of [...pending]) {
      const fks = fksOf(name)
      if (fks.some((f) => f.table !== name && pending.has(f.table))) continue
      // a table the migration chain already seeded has rows: it is covered, and a second row could break its unique keys
      const seeded = (db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number | bigint }).n
      if (Number(seeded) === 0) fillOne(db, name, sql, fks)
      pending.delete(name)
      progress = true
    }
  }
  if (pending.size > 0) throw new Error(`no parent-first order for: ${[...pending.keys()].join(', ')}`)
}

describe('the differential: every mapped table with a row, copied whole', () => {
  it('every copied table has a row, the counts equal the SQLite side, every table is read back, and each identity column continues', async () => {
    target = await createPgTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-diff-'))
    dirs.push(dir)
    const sqlitePath = join(dir, 'source.db')
    const db = new Database(sqlitePath)
    applyMigrations(db)
    fillEveryTable(db)
    const sqliteCounts = new Map(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .filter((t) => skipReason(t.name) === undefined)
        .map((t) => [t.name, Number((db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get() as { n: number | bigint }).n)]),
    )
    db.close()

    const report = await runCopy({ sqlitePath, pgUrl: target.ownerUrl, dryRun: false })
    expect(report.failure, JSON.stringify(report.failure)).toBeUndefined()
    expect(report.refusals).toEqual([])
    expect(report.committed).toBe(true)
    expect(report.tables.length).toBe(sqliteCounts.size)
    expect(report.verified.length).toBe(report.tables.length)
    for (const tb of report.tables) {
      expect(tb.sourceRows, tb.name).toBeGreaterThan(0)
      expect(tb.writtenRows, tb.name).toBe(sqliteCounts.get(tb.name))
      const pg = await target.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${tb.name}"`)
      expect(Number(pg.rows[0]!.n), tb.name).toBe(sqliteCounts.get(tb.name))
    }

    const identity = await target.pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND is_identity = 'YES' ORDER BY 1, 2",
    )
    expect(identity.rows.length).toBeGreaterThan(0)
    for (const { table_name, column_name } of identity.rows) {
      const max = await target.pool.query<{ max: string | null }>(`SELECT max("${column_name}")::text AS max FROM "${table_name}"`)
      if (max.rows[0]!.max === null) continue
      const seq = await target.pool.query<{ seq: string }>('SELECT pg_get_serial_sequence($1, $2) AS seq', [table_name, column_name])
      const next = await target.pool.query<{ next: string }>('SELECT nextval($1::regclass)::text AS next', [seq.rows[0]!.seq])
      expect(BigInt(next.rows[0]!.next), `${table_name}.${column_name}`).toBeGreaterThan(BigInt(max.rows[0]!.max!))
    }
  })
})

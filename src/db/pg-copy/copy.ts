// `copy` of the copy tool (P-G1): the one transaction that moves the rows. It runs only from a green plan (preconditions),
// reads the whole SQLite snapshot once before the first write (every anomaly of the source is collected, and any anomaly
// aborts the run with nothing written), then writes every table in foreign-key order inside ONE transaction as the owner,
// in the system context, and sets each identity sequence past the copied rows, once every table is written and right before
// COMMIT (setval is not transactional, so a run that fails before that line moves no sequence). All or nothing: a failure
// rolls back and the rows and the sequences are as they were. `--dry-run` runs the same transaction and rolls it back, with the same report.
//
// The report names tables, columns, rowids and counts; never a value. A PostgreSQL error is reported by its constraint name
// and SQLSTATE only: the driver's detail text carries the key values, and that text is not printed.

import type Database from 'better-sqlite3'
import type pg from 'pg'
import { PG_SET_CONTEXT_SQL, pgContextValues } from '../pg/dbx.js'
import { coerceValue, type PgValue } from './coerce.js'
import { Fingerprint, isIntegerPgType, rowDigest } from './fingerprint.js'
import { connect, preconditions } from './check.js'
import type { OrphanFinding, OrphanMode } from './orphans.js'
import { restoreUserTriggers, suspendedByTable, suspendUserTriggers, TriggerRestoreError } from './triggers.js'
import { openSnapshot, quoteIdent, sqliteRowCount } from './sqlite-source.js'
import { SEED_TABLES, type PgTable, type Refusal, type SchemaPlan, type TableMapping } from './schema.js'

export interface Anomaly {
  table: string
  column: string
  /** the SQLite rowid of the row */
  rowid: string
  /** the SQLite typeof of the value */
  sqliteType: string
  reason: string
}

export interface CopyFailure {
  table: string
  /** a read-back mismatch, or another reason the tool wrote down (no values in it) */
  reason?: string
  /** what the SQLSTATE means for the copy, when the copy can say more than the code (row-level security: a parent row is missing) */
  hint?: string
  /** the rowid of the row PostgreSQL refused, when it could be found by writing the chunk row by row */
  rowid?: string
  /** the constraint that refused it, by name (the driver's detail text is not kept: it carries key values) */
  constraint?: string
  sqlstate?: string
}

export interface CopyReport {
  /** the first line when the counts need saying: the orphans left out by `--orphans skip` */
  notice: string
  ok: boolean
  dryRun: boolean
  /** true only when the transaction was committed */
  committed: boolean
  refusals: Refusal[]
  anomalies: Anomaly[]
  /** the orphan rows the scan found (skip mode: the ones left out of the copy) */
  orphans: OrphanFinding[]
  failure?: CopyFailure
  tables: Array<{ name: string; sourceRows: number; writtenRows: number; skippedRows: number }>
  /** the tables that passed the read-back: rows and the first 16 hex digits of the fingerprint */
  verified: Array<{ table: string; rows: number; fingerprint: string }>
  seedsCleared: string[]
  /** the user triggers suspended for the write, per table, by name; restored to their recorded state before the read-back */
  suspendedTriggers: Array<{ table: string; triggers: string[] }>
  identity: Array<{ table: string; column: string; next: string }>
}

/** Rows read from SQLite per batch (the read is keyset on the rowid). */
const READ_BATCH_ROWS = 1000
/** Bind parameters per INSERT statement (PostgreSQL allows 65535). */
const MAX_PARAMS = 60000
/** Rows per INSERT statement, at most. */
const MAX_ROWS_PER_INSERT = 500

type SqlValue = bigint | number | string | Buffer | null
type SourceRow = Record<string, SqlValue> & { __rowid: bigint }

function emptyReport(dryRun: boolean): CopyReport {
  return {
    notice: '',
    ok: false,
    dryRun,
    committed: false,
    refusals: [],
    anomalies: [],
    orphans: [],
    tables: [],
    verified: [],
    seedsCleared: [],
    suspendedTriggers: [],
    identity: [],
  }
}

/** Row-level security refused a row: the copy names the rowid; the hint says what the policy means (run check for the keys). */
const RLS_HINT =
  'row-level security refused the row: a via_parent policy found no parent row (an orphan). Run check: it names the orphan keys.'

/** The SQLite typeof of a value as better-sqlite3 hands it over (safeIntegers on: integers are bigint). */
export function sqliteTypeOf(v: SqlValue): string {
  if (v === null) return 'null'
  if (typeof v === 'bigint') return 'integer'
  if (typeof v === 'number') return 'real'
  if (typeof v === 'string') return 'text'
  return 'blob'
}

/** Whether the raw bytes of one text cell are valid UTF-8 (asked only when the decoded value shows U+FFFD). */
function rawUtf8Valid(db: Database.Database, table: string, column: string, rowid: bigint): boolean {
  const row = db
    .prepare(`SELECT CAST(${quoteIdent(column)} AS BLOB) AS b FROM ${quoteIdent(table)} WHERE rowid = ?`)
    .get(rowid) as { b: Buffer | null } | undefined
  if (!row || !row.b) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(row.b)
    return true
  } catch {
    return false
  }
}

function selectList(m: TableMapping): string {
  const cols = m.columns.filter((c) => !c.fromRowid).map((c) => quoteIdent(c.name))
  return ['rowid AS __rowid', ...cols].join(', ')
}

/** How the rows of a table are read: by rowid (the default), by dependency depth for a self-referencing table, minus the excluded rows. */
export interface SourceOrder {
  /** the temporary (rid, depth) table of a self-referencing table: its rows come in (depth, rid) order, parents first */
  depthTable?: string
  /** rowids left out of the read (the orphans that skip mode leaves out) */
  excluded?: Set<bigint>
}

/** Every source row of a table, read in keyset batches (a generator: a large table is never in memory at once). */
function* sourceRows(db: Database.Database, m: TableMapping, order: SourceOrder = {}): Generator<SourceRow> {
  if (order.depthTable !== undefined) {
    // the keyset is (depth, rid): a batch is one index range on the depth table, joined to its row by rowid
    const cols = m.columns.filter((c) => !c.fromRowid).map((c) => `t.${quoteIdent(c.name)}`)
    const stmt = db.prepare(
      `SELECT d.rid AS __rowid, ${cols.join(', ')}, d.depth AS __depth ` +
        `FROM ${quoteIdent(order.depthTable)} AS d JOIN ${quoteIdent(m.name)} AS t ON t.rowid = d.rid ` +
        `WHERE (d.depth, d.rid) > (?, ?) ORDER BY d.depth, d.rid LIMIT ?`,
    )
    let depth = -1n
    let rid = -1n
    for (;;) {
      const rows = stmt.all(depth, rid, READ_BATCH_ROWS) as Array<SourceRow & { __depth: bigint }>
      if (rows.length === 0) break
      for (const row of rows) {
        if (order.excluded?.has(row.__rowid)) continue
        yield row
      }
      const last = rows[rows.length - 1]!
      depth = last.__depth
      rid = last.__rowid
      if (rows.length < READ_BATCH_ROWS) break
    }
    return
  }
  const stmt = db.prepare(`SELECT ${selectList(m)} FROM ${quoteIdent(m.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
  let cursor = 0n
  for (;;) {
    const rows = stmt.all(cursor, READ_BATCH_ROWS) as SourceRow[]
    if (rows.length === 0) break
    for (const row of rows) {
      if (order.excluded?.has(row.__rowid)) continue
      yield row
    }
    cursor = rows[rows.length - 1]!.__rowid
    if (rows.length < READ_BATCH_ROWS) break
  }
}

/**
 * Coerces one source row to the values of the mapped columns, in mapping order. Each anomaly of the row is pushed to
 * `anomalies`; a row with any anomaly returns undefined.
 */
export function coerceSourceRow(
  db: Database.Database,
  m: TableMapping,
  row: SourceRow,
  anomalies: Anomaly[],
): PgValue[] | undefined {
  const values: PgValue[] = []
  let ok = true
  for (const c of m.columns) {
    const raw: SqlValue = c.fromRowid ? row.__rowid : (row[c.name] ?? null)
    const sqliteType = c.fromRowid ? 'integer' : sqliteTypeOf(raw)
    const r = coerceValue(raw, sqliteType, c.pgType, {
      flag: c.flag,
      utf8Valid: () => rawUtf8Valid(db, m.name, c.name, row.__rowid),
    })
    if (r.ok) {
      values.push(r.value)
    } else {
      ok = false
      anomalies.push({ table: m.name, column: c.name, rowid: row.__rowid.toString(), sqliteType, reason: r.reason })
    }
  }
  return ok ? values : undefined
}

/** The read-only pass: every mapped table, every row, every value. Returns all anomalies of the source (none means green). */
export function scanAnomalies(db: Database.Database, mappings: TableMapping[]): Anomaly[] {
  const anomalies: Anomaly[] = []
  for (const m of mappings) {
    for (const row of sourceRows(db, m)) coerceSourceRow(db, m, row, anomalies)
  }
  return anomalies
}

/** A bind value: bigint as its decimal text (PostgreSQL reads it into the column type), the rest as the driver takes them. */
function bindValue(v: PgValue): unknown {
  return typeof v === 'bigint' ? v.toString() : v
}

class RowRefused extends Error {
  constructor(readonly detail: CopyFailure) {
    super(`copy refused at ${detail.table}`)
  }
}

/** Writes one chunk in one INSERT. On a refusal the chunk is written row by row, to name the row that PostgreSQL refused. */
async function insertChunk(
  client: pg.Client,
  table: string,
  columns: string[],
  chunk: Array<{ rowid: bigint; values: PgValue[] }>,
): Promise<void> {
  const colList = columns.map((c) => quoteIdent(c)).join(', ')
  const params: unknown[] = []
  const tuples: string[] = []
  for (const row of chunk) {
    const marks: string[] = []
    for (const v of row.values) {
      params.push(bindValue(v))
      marks.push(`$${params.length}`)
    }
    tuples.push(`(${marks.join(', ')})`)
  }
  await client.query('SAVEPOINT copy_chunk')
  try {
    await client.query(`INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${tuples.join(', ')}`, params)
    await client.query('RELEASE SAVEPOINT copy_chunk')
    return
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT copy_chunk')
    await client.query('RELEASE SAVEPOINT copy_chunk')
  }
  for (const row of chunk) {
    await client.query('SAVEPOINT copy_row')
    try {
      await client.query(
        `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${row.values.map((_, i) => `$${i + 1}`).join(', ')})`,
        row.values.map(bindValue),
      )
      await client.query('RELEASE SAVEPOINT copy_row')
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT copy_row')
      await client.query('RELEASE SAVEPOINT copy_row')
      const e = err as { constraint?: string; code?: string }
      throw new RowRefused({
        table,
        rowid: row.rowid.toString(),
        constraint: e.constraint,
        sqlstate: e.code,
        hint: e.code === '42501' ? RLS_HINT : undefined,
      })
    }
  }
  // the chunk failed as a whole but no single row did: the failure is named by table, not by row
  throw new RowRefused({ table })
}

/** Writes every mapped table in `writeOrder` inside the open transaction of `client`. */
async function writeTables(
  client: pg.Client,
  db: Database.Database,
  plan: SchemaPlan,
  pgTables: PgTable[],
  writeOrder: string[],
  report: CopyReport,
  dryRun: boolean,
  pending: Array<{ table: string; column: string }>,
  fps: Map<string, Fingerprint>,
  order: { depthTables: Map<string, string>; orphanRowids: Map<string, Set<bigint>> },
): Promise<void> {
  const byName = new Map(plan.mappings.map((m) => [m.name, m]))
  const pgByName = new Map(pgTables.map((t) => [t.name, t]))

  for (const name of SEED_TABLES) {
    if (!byName.has(name)) continue
    await client.query(`DELETE FROM ${quoteIdent(name)}`)
    report.seedsCleared.push(name)
  }

  for (const name of writeOrder) {
    const m = byName.get(name)
    if (!m) continue
    const columns = m.columns.map((c) => c.name)
    const sourceTotal = sqliteRowCount(db, name)
    // the orphans of skip mode are left out; in refuse mode there are none (the scan refused the run before this point)
    const excluded = order.orphanRowids.get(name) ?? new Set<bigint>()
    const sourceCount = sourceTotal - excluded.size
    const sourceOrder: SourceOrder = { depthTable: order.depthTables.get(name), excluded }
    const rowsPerInsert = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS / Math.max(1, columns.length))))
    let written = 0
    const fp = new Fingerprint()
    fps.set(name, fp)
    // the rows are coerced in chunks (the scan was green on this snapshot, so every row coerces); each chunk is one INSERT
    for (const chunk of chunksOf(db, m, rowsPerInsert, sourceOrder)) {
      await insertChunk(client, name, columns, chunk)
      for (const row of chunk) {
        fp.add(rowDigest(m.columns.map((c, i) => ({ value: row.values[i] ?? null, pgType: c.pgType }))))
      }
      written += chunk.length
    }
    if (written !== sourceCount) {
      // every source row was coerced (the scan was green), so a difference is a bug, not data: stop the copy
      throw new Error(`${name}: ${written} row(s) written of ${sourceCount}`)
    }
    report.tables.push({ name, sourceRows: sourceTotal, writtenRows: written, skippedRows: excluded.size })

    const pgTable = pgByName.get(name)
    for (const pc of pgTable?.columns.filter((c) => c.identity) ?? []) pending.push({ table: name, column: pc.name })
  }
}

/**
 * The identity sequences, set once every table is written and right before COMMIT. setval is not transactional: a rollback
 * does not undo it, so a run that fails before this point moves no sequence. A dry run only computes the value it would set.
 */
async function setIdentities(
  client: pg.Client,
  pending: Array<{ table: string; column: string }>,
  dryRun: boolean,
  report: CopyReport,
): Promise<void> {
  for (const { table, column } of pending) {
    const next = `COALESCE((SELECT max(${quoteIdent(column)}) FROM ${quoteIdent(table)}), 0) + 1`
    const r = dryRun
      ? await client.query<{ next: string }>(`SELECT (${next})::text AS next`)
      : await client.query<{ next: string }>(`SELECT setval(pg_get_serial_sequence($1, $2), ${next}, false)::text AS next`, [quoteIdent(table), column])
    report.identity.push({ table, column, next: r.rows[0]?.next ?? '' })
  }
}

/**
 * The rows of a table as chunks of at most `size` rows, each with its coerced values. A row that does not coerce is not
 * in any chunk: the anomaly scan ran first on the same snapshot, so for a copy that reaches here that does not happen.
 */
function* chunksOf(
  db: Database.Database,
  m: TableMapping,
  size: number,
  order: SourceOrder,
): Generator<Array<{ rowid: bigint; values: PgValue[] }>> {
  let current: Array<{ rowid: bigint; values: PgValue[] }> = []
  const ignored: Anomaly[] = []
  for (const row of sourceRows(db, m, order)) {
    const values = coerceSourceRow(db, m, row, ignored)
    if (!values) continue
    current.push({ rowid: row.__rowid, values })
    if (current.length >= size) {
      yield current
      current = []
    }
  }
  if (current.length > 0) yield current
}

class VerifyFailure extends Error {
  constructor(
    readonly table: string,
    readonly reason: string,
  ) {
    super(`verification failed at ${table}`)
  }
}

/**
 * The read-back: every copied table is read in the same transaction and folded with the same canonical form as the
 * write; the count and the fold must equal what was written. A mismatch names the table and stops the run (rollback).
 * The read is one SELECT per table, so a table is in memory once during the check (the rehearsal measures it).
 */
async function verifyTables(
  client: pg.Client,
  plan: SchemaPlan,
  writeOrder: string[],
  fps: Map<string, Fingerprint>,
  report: CopyReport,
): Promise<void> {
  const byName = new Map(plan.mappings.map((m) => [m.name, m]))
  for (const name of writeOrder) {
    const m = byName.get(name)
    if (!m) continue
    const written = fps.get(name) ?? new Fingerprint()
    // An integer column is read as text: the connection's int8 parser refuses a value beyond 2^53 (a RangeError would roll
    // the whole run back), and the text is exact. It is folded as a bigint, the same value the write side folded.
    const cols = m.columns
      .map((c) => (isIntegerPgType(c.pgType) ? `${quoteIdent(c.name)}::text AS ${quoteIdent(c.name)}` : quoteIdent(c.name)))
      .join(', ')
    const r = await client.query<Record<string, unknown>>(`SELECT ${cols} FROM ${quoteIdent(name)}`)
    const back = new Fingerprint()
    for (const row of r.rows) {
      back.add(rowDigest(m.columns.map((c) => {
        const raw = row[c.name] ?? null
        const value = isIntegerPgType(c.pgType) && raw !== null ? BigInt(raw as string) : raw
        return { value: value as PgValue | Buffer, pgType: c.pgType }
      })))
    }
    if (!written.equals(back)) {
      throw new VerifyFailure(name, `the rows read back (${back.rows}) do not match the rows written (${written.rows}) by count and fingerprint`)
    }
    report.verified.push({ table: name, rows: back.rows, fingerprint: back.hexString.slice(0, 16) })
  }
}

/**
 * The copy. Preconditions first; then the anomaly scan over the whole snapshot; then, only if the source is clean, one
 * transaction for every table. Dry run ends the transaction with a rollback.
 */
export async function runCopy(opts: { sqlitePath: string; pgUrl: string; dryRun: boolean; orphans?: OrphanMode }): Promise<CopyReport> {
  const report = emptyReport(opts.dryRun)
  const snapshot = await openSnapshot(opts.sqlitePath)
  try {
    const client = await connect(opts.pgUrl)
    try {
      const pre = await preconditions(snapshot.db, client, { orphans: opts.orphans })
      report.orphans = pre.report.plan.orphans
      if (!pre.report.ok) {
        report.refusals = pre.report.refusals
        return report
      }
      report.notice = pre.report.notice
      const anomalies = scanAnomalies(snapshot.db, pre.plan.mappings)
      if (anomalies.length > 0) {
        report.anomalies = anomalies
        return report
      }
      await client.query('BEGIN')
      try {
        await client.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'system', name: 'pg-copy' }) })
        await client.query("SELECT set_config('statement_timeout', '0', true)")
        // the user triggers of the copied tables are suspended for the write (decided 2026-11-24): the copy writes what SQLite holds
        const copiedTables = pre.plan.mappings.map((m) => m.name)
        const recordedTriggers = await suspendUserTriggers(client, copiedTables)
        report.suspendedTriggers = suspendedByTable(recordedTriggers)
        const pending: Array<{ table: string; column: string }> = []
        const fps = new Map<string, Fingerprint>()
        await writeTables(client, snapshot.db, pre.plan, pre.pgTables, pre.writeOrder ?? [], report, opts.dryRun, pending, fps, {
          depthTables: pre.depthTables,
          orphanRowids: pre.orphanRowids,
        })
        // back to the recorded state after the last write, before the read-back: a mismatch rolls the run back by name
        await restoreUserTriggers(client, recordedTriggers, copiedTables)
        // read back inside the transaction, before COMMIT: a dry run verifies too
        await verifyTables(client, pre.plan, pre.writeOrder ?? [], fps, report)
        // the sequences last: after every write and the read-back, right before COMMIT
        await setIdentities(client, pending, opts.dryRun, report)
        if (opts.dryRun) {
          await client.query('ROLLBACK')
        } else {
          await client.query('COMMIT')
          report.committed = true
        }
        report.ok = true
      } catch (err) {
        await client.query('ROLLBACK')
        if (err instanceof RowRefused) {
          report.failure = err.detail
        } else if (err instanceof VerifyFailure) {
          report.failure = { table: err.table, reason: err.reason }
        } else if (err instanceof TriggerRestoreError) {
          report.failure = { table: err.table, reason: `user trigger ${err.trigger} not restored: ${err.reason}` }
        } else {
          report.failure = { table: '(transaction)', sqlstate: (err as { code?: string }).code }
        }
      }
      return report
    } finally {
      await client.end()
    }
  } finally {
    snapshot.close()
  }
}

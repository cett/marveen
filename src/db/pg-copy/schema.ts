// The schema agreement between a SQLite database and the PostgreSQL baseline (P-G1, copy tool), as pure functions: which
// SQLite objects are copied, which are left out on purpose, how the columns map, and in which order the tables are
// written. No database is touched here; the readers live in sqlite-source.ts and pg-target.ts.
//
// A SQLite table that is neither mapped nor on the skip list is a refusal: a table nobody ported must not be dropped
// silently. A SQLite column with no PostgreSQL column is a refusal. A PostgreSQL column with no SQLite column is allowed
// only when it is an identity, a generated column or has a default, and the report names it.

/** The non-seed tables are written empty; these six are cleared and reloaded from SQLite (the SQLite rows are the truth). */
export const SEED_TABLES: readonly string[] = [
  'tenants', 'system_config', 'autonomy_categories', 'model_profile_map', 'egress_allowlist', 'otel_metrics_export_state',
]

/** PostgreSQL tables the migration runner writes (the applied-migration rows): never copied, never checked for emptiness. */
export const PG_RUNNER_TABLES: readonly string[] = ['schema_version']

/** The FTS5 virtual tables of the SQLite side (Phase 3 on PostgreSQL: tsvector columns, not copied). */
export const FTS_VIRTUAL_TABLES: readonly string[] = ['artifacts_fts', 'memories_fts', 'workspace_docs_fts']

/**
 * PostgreSQL identity columns with no SQLite column of the same name whose value is the SQLite rowid: the running number
 * (kanban) and the insertion order (otel spans) that the code reads. An install that carries its rows over keeps them.
 */
export const ROWID_SEQ_COLUMNS: Readonly<Record<string, string>> = {
  kanban_cards: 'seq',
  otel_spans: 'seq',
}

export interface SqliteColumn {
  name: string
  /** the declared SQLite type (may be empty) */
  declaredType: string
}

export interface SqliteTable {
  name: string
  columns: SqliteColumn[]
}

export interface PgColumn {
  name: string
  /** format_type() of the column: text, bigint, smallint, double precision, real, bytea, boolean, ... */
  type: string
  identity: boolean
  generated: boolean
  hasDefault: boolean
  /** a 0/1 flag column (smallint with CHECK (col IN (0, 1))) */
  flag: boolean
}

export interface PgTable {
  name: string
  columns: PgColumn[]
  /** referenced table names: one entry per foreign key (self references included), and one per row-level policy reference (not the table itself) */
  references: string[]
}

/** A foreign key of the PostgreSQL catalog (pg_constraint, contype 'f'), with its columns on both sides, in key order. */
export interface PgForeignKey {
  name: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
  /** MATCH SIMPLE (the default): a row with a NULL in any key column is not checked. Any other match type is not modelled. */
  matchSimple: boolean
}

/** A row-level policy of the PostgreSQL side that reads another table (an EXISTS on the parent): one edge per pair. */
export interface PgPolicyEdge {
  table: string
  refTable: string
  policy: string
}

export interface Refusal {
  table: string
  column?: string
  reason: string
}

export interface ColumnMapping {
  name: string
  /** the PostgreSQL column this one is written to */
  pgType: string
  flag: boolean
  /** the value comes from the SQLite rowid, not from a column */
  fromRowid: boolean
}

export interface TableMapping {
  name: string
  columns: ColumnMapping[]
  /** PostgreSQL columns with no SQLite column that are left to the database (identity, generated or default) */
  leftToDatabase: string[]
  /** the identity columns of the table, which get a setval after the copy */
  identityColumns: string[]
}

export interface SchemaPlan {
  mappings: TableMapping[]
  /** SQLite tables on the skip list, with the reason */
  skipped: Array<{ table: string; reason: string }>
  /** PostgreSQL tables with no SQLite table: side tables that the embeddings stage fills, copied as nothing */
  pgOnlyTables: string[]
  refusals: Refusal[]
}

/** The reason a SQLite table is not copied, or undefined when it is copied (or refused). */
export function skipReason(table: string): string | undefined {
  if (table.startsWith('sqlite_')) return 'SQLite internal table'
  if (table === 'schema_version') return 'the migration bookkeeping of the SQLite chain (the PostgreSQL runner keeps its own)'
  for (const v of FTS_VIRTUAL_TABLES) {
    if (table === v) return 'FTS5 virtual table (tsvector on PostgreSQL)'
    if (table.startsWith(`${v}_`) && /^_(data|idx|docsize|config|content)$/.test(table.slice(v.length))) {
      return 'FTS5 shadow table'
    }
  }
  if (table.startsWith('vec_')) return 'vec0 index (sqlite-vec, pgvector on PostgreSQL)'
  return undefined
}

/** Maps the SQLite tables onto the PostgreSQL tables and lists every refusal (an empty refusal list is a green plan). */
export function planSchema(sqlite: SqliteTable[], pg: PgTable[]): SchemaPlan {
  const refusals: Refusal[] = []
  const skipped: Array<{ table: string; reason: string }> = []
  const pgByName = new Map(pg.map((t) => [t.name, t]))
  const sqliteNames = new Set<string>()
  const mappings: TableMapping[] = []

  for (const st of sqlite) {
    const reason = skipReason(st.name)
    if (reason !== undefined) {
      skipped.push({ table: st.name, reason })
      continue
    }
    sqliteNames.add(st.name)
    const pt = pgByName.get(st.name)
    if (!pt) {
      refusals.push({ table: st.name, reason: 'a SQLite table with no PostgreSQL table (not on the skip list): port it or skip it on purpose' })
      continue
    }
    const pgCols = new Map(pt.columns.map((c) => [c.name, c]))
    const sqliteCols = new Set(st.columns.map((c) => c.name))
    const columns: ColumnMapping[] = []
    let refused = false
    for (const sc of st.columns) {
      const pc = pgCols.get(sc.name)
      if (!pc) {
        refusals.push({ table: st.name, column: sc.name, reason: 'a SQLite column with no PostgreSQL column' })
        refused = true
        continue
      }
      columns.push({ name: sc.name, pgType: pc.type, flag: pc.flag, fromRowid: false })
    }
    const leftToDatabase: string[] = []
    const identityColumns: string[] = []
    for (const pc of pt.columns) {
      if (pc.identity) identityColumns.push(pc.name)
      if (sqliteCols.has(pc.name)) continue
      if (ROWID_SEQ_COLUMNS[st.name] === pc.name) {
        columns.push({ name: pc.name, pgType: pc.type, flag: false, fromRowid: true })
        continue
      }
      if (pc.identity || pc.generated || pc.hasDefault) {
        leftToDatabase.push(pc.name)
        continue
      }
      refusals.push({ table: st.name, column: pc.name, reason: 'a PostgreSQL column with no SQLite column that is not an identity, generated or defaulted' })
      refused = true
    }
    if (!refused) mappings.push({ name: st.name, columns, leftToDatabase, identityColumns })
  }

  // the runner's own bookkeeping is not data: it is written by the migration runner, never by the copy
  const pgOnlyTables = pg.map((t) => t.name).filter((n) => !sqliteNames.has(n) && !PG_RUNNER_TABLES.includes(n))
  return { mappings, skipped, pgOnlyTables, refusals }
}

export type TableOrder = { order: string[] } | { cycle: string[] }

/**
 * The write order of the tables: every table after the tables it references (parents first). Self references are ignored
 * (a row may point at an earlier row of its own table; the copy writes in rowid order). A cycle is refused with its tables.
 * Kahn's algorithm; ties are broken by name so the order is stable from run to run.
 */
export function orderTables(tables: string[], references: Map<string, string[]>): TableOrder {
  const names = new Set(tables)
  const indegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const t of tables) indegree.set(t, 0)
  for (const t of tables) {
    for (const parent of references.get(t) ?? []) {
      if (parent === t || !names.has(parent)) continue
      indegree.set(t, (indegree.get(t) ?? 0) + 1)
      const list = children.get(parent) ?? []
      list.push(t)
      children.set(parent, list)
    }
  }
  const ready = tables.filter((t) => indegree.get(t) === 0).sort()
  const order: string[] = []
  while (ready.length > 0) {
    ready.sort()
    const next = ready.shift()!
    order.push(next)
    for (const child of children.get(next) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1
      indegree.set(child, left)
      if (left === 0) ready.push(child)
    }
  }
  if (order.length !== tables.length) {
    return { cycle: tables.filter((t) => !order.includes(t)).sort() }
  }
  return { order }
}

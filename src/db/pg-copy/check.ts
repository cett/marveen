// `check` of the copy tool (P-G1): every precondition of a copy, no write. Each refusal names a table or a column (or the
// role, or the database as a whole) and the reason. A value is never printed: a row is never named, only counted.
//
// The checks, in order: the SQLite file is sound (integrity_check on the snapshot), the SQLite schema version is the one the
// PostgreSQL chain was cut from, the schema of the two sides agrees (planSchema), the connected role is the owner (not a
// superuser, not a role that bypasses row-level security), the PostgreSQL schema is current (the serving boot's own check),
// the target is empty (every non-seed table), the foreign keys form an order (no cycle), and the orphan rows: a child whose
// parent is missing, found by the foreign keys of the catalog, and a row-level policy edge that no foreign key backs.
//
// preconditions() is the part `copy` runs first as well: the copy starts only from a green plan.

import pg from 'pg'
import type Database from 'better-sqlite3'
import { pgTypes } from '../pg/types.js'
import { PG_SET_CONTEXT_SQL, pgContextValues } from '../pg/dbx.js'
import { assertPgSchemaCurrent } from '../../db-migrations-pg.js'
import { sanitizeError } from '../pg-boot.js'
import { integrityProblems, openSnapshot, readSqliteTables, schemaVersionMax } from './sqlite-source.js'
import { orderTables, planSchema, SEED_TABLES, type PgPolicyEdge, type PgTable, type Refusal, type SchemaPlan } from './schema.js'
import { readForeignKeys, readPgRole, readPgRowCounts, readPgTables, readPolicyEdges, readTableOwners } from './pg-target.js'
import {
  orphanRefusals,
  pinnedParentKeys,
  policyEdgesWithoutForeignKey,
  scanOrphans,
  unpinnedPolicyEdges,
  unpinnedPolicyRefusals,
  type OrphanFinding,
  type OrphanMode,
} from './orphans.js'
import { planSelfOrder } from './selforder.js'
import { readUserTriggers } from './triggers.js'

/** The SQLite schema version the PostgreSQL chain was cut from (the baseline 0001 and the seed of 0002 come from it). */
export const PG_CHAIN_SQLITE_CUT = 96

/** The highest SQLite schema version this copy loader knows. A newer SQLite is refused until the PostgreSQL chain has its twin. */
export const COPY_LOADER_SQLITE_MAX = 96

export interface CheckReport {
  /** the first line of the report when it says something the counts do not: orphans left out by `--orphans skip` */
  notice: string
  ok: boolean
  refusals: Refusal[]
  plan: {
    sqliteSchemaVersion?: number
    copied: Array<{ table: string; columns: number }>
    skipped: Array<{ table: string; reason: string }>
    /** PostgreSQL columns left to the database (identity, generated, default): named, not copied */
    leftToDatabase: Array<{ table: string; columns: string[] }>
    /** PostgreSQL tables with no SQLite table: must be empty, filled by the embeddings stage */
    pgOnlyTables: string[]
    seedTables: string[]
    writeOrder?: string[]
    /** the orphan rows the foreign keys find on the snapshot (one per key that has any) */
    orphans: OrphanFinding[]
    /** row-level policy edges that no foreign key backs and the orphan catalog does not pin: each one is refused */
    uncoveredPolicyEdges: PgPolicyEdge[]
  }
}

/** What the preconditions established, for the stages that come after them (the copy writes what the plan says). */
export interface Preconditions {
  report: CheckReport
  plan: SchemaPlan
  pgTables: PgTable[]
  /** the tables in write order (parents first); undefined when the foreign keys have a cycle (then the report refuses) */
  writeOrder?: string[]
  /** per copied table, the rowids of its orphan rows (the closure): the rows that skip mode leaves out */
  orphanRowids: Map<string, Set<bigint>>
  /** per copied table with a self reference, the temporary (rid, depth) table the copy reads its rows by */
  depthTables: Map<string, string>
}

export interface PreconditionOptions {
  /** what to do with orphan rows (default refuse) */
  orphans?: OrphanMode
}

function planSummary(plan: SchemaPlan): CheckReport['plan'] {
  return {
    copied: plan.mappings.map((m) => ({ table: m.name, columns: m.columns.length })),
    skipped: plan.skipped,
    leftToDatabase: plan.mappings
      .filter((m) => m.leftToDatabase.length > 0)
      .map((m) => ({ table: m.name, columns: m.leftToDatabase })),
    pgOnlyTables: plan.pgOnlyTables,
    seedTables: SEED_TABLES.filter((t) => plan.mappings.some((m) => m.name === t)),
    orphans: [],
    uncoveredPolicyEdges: [],
  }
}

/** Every precondition, on an open snapshot and a connected client. Reads only; writes nothing (its temporary tables aside). */
export async function preconditions(db: Database.Database, client: pg.Client, opts: PreconditionOptions = {}): Promise<Preconditions> {
  const orphanMode: OrphanMode = opts.orphans ?? 'refuse'
  const refusals: Refusal[] = []
  const problems = integrityProblems(db)
  if (problems.length > 0) {
    refusals.push({ table: '(database)', reason: `PRAGMA integrity_check reports ${problems.length} problem(s) on the snapshot` })
  }

  const version = schemaVersionMax(db)
  if (version === undefined) {
    refusals.push({ table: '(database)', reason: 'no schema_version rows: not a database built by the SQLite migration chain' })
  } else if (version < PG_CHAIN_SQLITE_CUT) {
    refusals.push({ table: '(database)', reason: `the SQLite schema is ${version}, older than the PostgreSQL chain (${PG_CHAIN_SQLITE_CUT}): run the SQLite migrations first` })
  } else if (version > COPY_LOADER_SQLITE_MAX) {
    refusals.push({ table: '(database)', reason: `the SQLite schema is ${version}, newer than this copy loader knows (${COPY_LOADER_SQLITE_MAX}): the PostgreSQL chain has no twin yet` })
  }

  const sqliteTables = readSqliteTables(db)
  const pgTables = await readPgTables(client)
  const plan = planSchema(sqliteTables, pgTables)
  refusals.push(...plan.refusals)

  const role = await readPgRole(client)
  if (role.superuser) {
    refusals.push({ table: '(role)', reason: 'the connected role is a superuser: it skips row-level security and would hide a missing system context' })
  }
  if (role.bypassRls) {
    refusals.push({ table: '(role)', reason: 'the connected role bypasses row-level security: connect as the owner role' })
  }
  const owners = await readTableOwners(client)
  // the suspension of the user triggers is ALTER TABLE, which needs the owner: a table with triggers is refused by name (H5)
  const userTriggers = await readUserTriggers(client, plan.mappings.map((m) => m.name))
  for (const m of plan.mappings) {
    if (owners.get(m.name) !== role.name) {
      const names = userTriggers.filter((t) => t.table === m.name).map((t) => t.name)
      refusals.push({
        table: m.name,
        reason:
          names.length > 0
            ? `copy role ${role.name} does not own ${m.name}, which has triggers: ${names.join(', ')}: connect as the owner role`
            : 'the connected role does not own the table: connect as the owner role',
      })
    }
  }

  try {
    await assertPgSchemaCurrent(client as unknown as pg.Pool)
  } catch (err) {
    refusals.push({ table: '(database)', reason: (err as Error).message })
  }

  // the orphan rows: the foreign keys of the PostgreSQL catalog, plus the pinned parent links of the policy edges that no
  // key backs (the scan is blind on those without the catalog), against the snapshot
  const declaredFks = await readForeignKeys(client)
  const uncovered = policyEdgesWithoutForeignKey(await readPolicyEdges(client), declaredFks)
  const fks = [...declaredFks, ...pinnedParentKeys(uncovered)]
  const scan = scanOrphans(db, plan.mappings, fks)
  if (orphanMode === 'refuse') refusals.push(...orphanRefusals(scan.findings))
  refusals.push(...scan.problems)
  // fail-closed: an uncovered policy edge that the catalog does not pin is refused, never silently scanned or ignored
  const unpinned = unpinnedPolicyEdges(uncovered)
  refusals.push(...unpinnedPolicyRefusals(unpinned))
  const self = planSelfOrder(db, plan.mappings, fks, scan.orphans)
  refusals.push(...self.refusals)
  const orphanRows = scan.findings.reduce((n, f) => n + f.count, 0)
  const notice =
    orphanMode === 'skip' && scan.findings.length > 0
      ? `orphans skipped (--orphans skip): ${orphanRows} row(s) in ${new Set(scan.findings.map((f) => f.table)).size} table(s) are not written; plan.orphans names them`
      : ''

  const targetTables = [...plan.mappings.map((m) => m.name), ...plan.pgOnlyTables]
  const nonSeed = targetTables.filter((t) => !SEED_TABLES.includes(t))
  if (nonSeed.length > 0) {
    // a table the role cannot read is refused by name and not counted: a count on it would abort the whole check
    const readable = await readableTables(client, nonSeed)
    for (const t of nonSeed) {
      if (!readable.has(t)) refusals.push({ table: t, reason: 'the connected role cannot read the table: grant SELECT or connect as the owner role' })
    }
    const countable = nonSeed.filter((t) => readable.has(t))
    // the counts run as the system context: under FORCE row-level security an owner without a context sees no rows
    if (countable.length > 0) {
      await client.query('BEGIN')
      try {
        await client.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'system', name: 'pg-copy-check' }) })
        const counts = await readPgRowCounts(client, countable)
        for (const [table, n] of counts) {
          if (n > 0) refusals.push({ table, reason: `the target table is not empty (${n} row(s)): the copy writes into an empty target` })
        }
      } finally {
        await client.query('ROLLBACK')
      }
    }
  }

  const references = new Map(pgTables.map((t) => [t.name, t.references]))
  const order = orderTables(plan.mappings.map((m) => m.name), references)
  if ('cycle' in order) {
    refusals.push({ table: order.cycle[0] ?? '(cycle)', reason: `a foreign-key cycle between ${order.cycle.length} tables (foreign keys and row-level policy references): the copy has no order for them` })
  }

  const report: CheckReport = {
    notice,
    ok: refusals.length === 0,
    refusals,
    plan: {
      ...planSummary(plan),
      sqliteSchemaVersion: version,
      writeOrder: 'order' in order ? order.order : undefined,
      orphans: scan.findings,
      uncoveredPolicyEdges: unpinned,
    },
  }
  return {
    report,
    plan,
    pgTables,
    writeOrder: 'order' in order ? order.order : undefined,
    orphanRowids: scan.orphans,
    depthTables: self.depthTables,
  }
}

/** The tables of `tables` the connected role may SELECT from. */
async function readableTables(client: pg.Client, tables: string[]): Promise<Set<string>> {
  const r = await client.query<{ table_name: string }>(
    "SELECT t AS table_name FROM unnest($1::text[]) AS t WHERE has_table_privilege(current_user, t, 'SELECT')",
    [tables],
  )
  return new Set(r.rows.map((row) => row.table_name))
}

/** Runs every precondition of a copy from `sqlitePath` into the PostgreSQL database at `pgUrl`. Writes nothing. */
export async function runCheck(opts: { sqlitePath: string; pgUrl: string; orphans?: OrphanMode }): Promise<CheckReport> {
  const snapshot = await openSnapshot(opts.sqlitePath)
  try {
    const client = await connect(opts.pgUrl)
    try {
      return (await preconditions(snapshot.db, client, { orphans: opts.orphans })).report
    } finally {
      await client.end()
    }
  } finally {
    snapshot.close()
  }
}

/** A connected client for the copy tool; a connection error is returned without the URL in it. */
export async function connect(pgUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: pgUrl, types: pgTypes })
  try {
    await client.connect()
  } catch (err) {
    throw sanitizeError(err, pgUrl)
  }
  return client
}

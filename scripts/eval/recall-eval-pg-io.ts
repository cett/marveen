// The I/O side of the PostgreSQL recall harness: copies the SQLite eval copy into a PostgreSQL
// database and runs the full-text stage of every query through the production facade on that backend.
//
// The SQLite side is read only (the eval copy, opened readonly); the PostgreSQL side is always a scratch database
// (assertScratchDatabaseName), created here. Nothing reads the live database.
import type BetterSqlite3 from 'better-sqlite3'
import pg from 'pg'
import { createPgDbx, pgPoolConfig } from '../../src/db/pg/index.js'
import { useDbxBackend } from '../../src/db/facade.js'
import { loadSystemConfigCacheAsync } from '../../src/db/config-cache.js'
import { loadModelProfileMapCacheAsync } from '../../src/db/model-profile-map-cache.js'
import { loadAgentSettingsCacheAsync } from '../../src/db/agent-settings-cache.js'
import { searchAgentMemories } from '../../src/db/memory.js'
import { searchWorkspaceDocs } from '../../src/db/workspace.js'
import { listArtifacts } from '../../src/db/artifacts.js'
import { assertScratchDatabaseName, planCopy, toPgValue, type CopyPlan, type PgColumnInfo } from './recall-eval-fts-stage.js'
import { FINAL_LIMIT } from './recall-eval-run.js'
import type { QueryCase, QueryRun } from './recall-eval-lib.js'

/** The tables the full-text stage reads. The vector-side tables are not copied yet. */
export const EVAL_TABLES = ['memories', 'workspace_docs', 'artifacts'] as const
export type EvalTable = (typeof EVAL_TABLES)[number]

/** Rows per multi-row INSERT: keeps the parameter count under PostgreSQL's 65535 limit with a margin. */
const PARAM_BUDGET = 60_000

export interface CopyReport {
  tables: Record<EvalTable, { rows: number; plan: CopyPlan }>
}

/** The admin URL of a PostgreSQL server (a database name in the path is replaced). */
export function withDatabase(adminUrl: string, database: string): string {
  const u = new URL(adminUrl)
  u.pathname = `/${database}`
  return u.toString()
}

/** Creates an empty scratch database on the server behind the admin URL. The name is checked first. */
export async function createScratchDatabase(adminUrl: string, database: string): Promise<void> {
  assertScratchDatabaseName(database)
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE "${database}"`)
  } finally {
    await admin.end()
  }
}

/** A pool on a database, with the same limits the production PostgreSQL adapter will use (pool.ts). */
export function evalPool(url: string): pg.Pool {
  return new pg.Pool(pgPoolConfig(url, { max: 4 }))
}

/**
 * Copies the three tables of the SQLite eval copy into the PostgreSQL database behind `pool`, in one transaction.
 * The columns come from the two schemas: a column only SQLite has is dropped (named in the report), a column
 * PostgreSQL computes (the fts index) is skipped, a text value bound for a bytea column is stored as its UTF-8 bytes.
 * The target must already have the baseline schema (the migrations applied): the copy never creates tables.
 */
export async function copyEvalTables(src: BetterSqlite3.Database, pool: pg.Pool): Promise<CopyReport> {
  const client = await pool.connect()
  const tables = {} as CopyReport['tables']
  try {
    await client.query('BEGIN')
    for (const table of EVAL_TABLES) {
      const sqliteColumns = (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
      const pgRows = await client.query<{ name: string; dataType: string; gen: string }>(
        `SELECT column_name AS name, data_type AS "dataType", is_generated AS gen
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [table],
      )
      const pgColumns: PgColumnInfo[] = pgRows.rows.map((r) => ({ name: r.name, dataType: r.dataType, generated: r.gen === 'ALWAYS' }))
      const plan = planCopy(sqliteColumns, pgColumns)
      if (plan.columns.length === 0) throw new Error(`no column of ${table} is shared by the SQLite copy and the PostgreSQL schema`)

      const selectList = plan.columns.map((c) => `"${c}"`).join(', ')
      const rows = src.prepare(`SELECT ${selectList} FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]
      const byteaSet = new Set(plan.byteaColumns)
      const perBatch = Math.max(1, Math.floor(PARAM_BUDGET / plan.columns.length))
      const colSql = plan.columns.map((c) => `"${c}"`).join(', ')
      for (let start = 0; start < rows.length; start += perBatch) {
        const batch = rows.slice(start, start + perBatch)
        const params: unknown[] = []
        const tuples = batch.map((row) => {
          const marks = plan.columns.map((c) => {
            params.push(toPgValue(row[c], byteaSet.has(c)))
            return `$${params.length}`
          })
          return `(${marks.join(', ')})`
        })
        // OVERRIDING SYSTEM VALUE: the ids of the copy are kept as they are (identity columns included)
        await client.query(`INSERT INTO ${table} (${colSql}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`, params)
      }
      tables[table] = { rows: rows.length, plan }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
  return { tables }
}

/** Row counts of the copied tables on the PostgreSQL side (the corpus of the snapshot meta). */
export async function countCorpus(pool: pg.Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of EVAL_TABLES) {
    const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)
    out[table] = Number(r.rows[0]?.n ?? 0)
  }
  return out
}

/**
 * Runs the full-text stage of every case through the PRODUCTION search functions on the PostgreSQL backend, with the
 * frozen clock (the recency re-rank reads Date.now). Each case gets one stage, `fts`:
 *   memory    searchAgentMemories (content and keywords, own and shared rows, tenant in SQL)
 *   doc       searchWorkspaceDocs (phrase, tenant and agent in SQL)
 *   artifact  listArtifacts with the query as `q` (the full-text filter on the artifact table)
 * The facade backend is set for the duration of the call and reset afterwards.
 */
export async function runFtsStagePg(pool: pg.Pool, cases: QueryCase[], nowSec: number): Promise<QueryRun[]> {
  const realNow = Date.now
  Date.now = () => nowSec * 1000
  useDbxBackend(createPgDbx(pool), 'pg')
  try {
    await loadSystemConfigCacheAsync()
    await loadModelProfileMapCacheAsync()
    await loadAgentSettingsCacheAsync()
    const runs: QueryRun[] = []
    for (const c of cases) {
      let ids: string[]
      if (c.kind === 'memory') {
        ids = (await searchAgentMemories(c.agentId!, c.text, FINAL_LIMIT * 2, c.tenantId)).map((m) => String(m.id))
      } else if (c.kind === 'doc') {
        const o = { agentId: c.agentId, tenantId: c.tenantId }
        ids = (await searchWorkspaceDocs(c.text, { ...o, limit: FINAL_LIMIT * 2 })).map((d) => d.id)
      } else {
        ids = (await listArtifacts({ q: c.text, limit: FINAL_LIMIT })).map((a) => a.id)
      }
      runs.push({ id: c.id, kind: c.kind, stages: { fts: ids } })
    }
    return runs
  } finally {
    useDbxBackend(null)
    Date.now = realNow
  }
}

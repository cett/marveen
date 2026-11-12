// SPIKE (data, not product code): what does it cost to give every statement its tenant context in PostgreSQL, and which
// way leaks the least? It runs in the pg-parity job and prints one line per measurement (grep the log for "SPIKE ").
//
//   S3  no context (the baseline cost of a statement)
//   S1  every statement in its own transaction, the context set with set_config(..., true) (= SET LOCAL) inside the
//       statement itself (a CTE), so the context needs no round trip of its own; BEGIN and COMMIT do
//   S2  session level: set_config(..., false) when the connection is borrowed, RESET when it is given back
//
// Ops: select by pk, update by pk, and a 3-statement transaction. Pool 1, 4 and 10 (the number of workers is the pool
// size). 3 runs of PG_SPIKE_QUERIES (default 10000) per cell. Latency per op in ms: p50 / p95 / p99. The leak cells
// below are assertions: they say what the NEXT borrower sees after a statement failed before the connection was given
// back. Round trips per op (statements the server answers one after the other) are in the "rtt" field.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createPgTestDb, pgTypes, type PgTestDb } from '../helpers/pg-test-db.js'

const N = Number(process.env['PG_SPIKE_QUERIES'] ?? 10000)
const RUNS = 3
const ROWS = 1000
const GUC = 'app.tenant_id'
const TENANT = 'tenant-a'

type Variant = 'S1' | 'S2' | 'S3'
type Op = 'select' | 'update' | 'tx3'
const VARIANTS: Variant[] = ['S3', 'S1', 'S2']
const OPS: Op[] = ['select', 'update', 'tx3']
const POOLS = [1, 4, 10]

let db: PgTestDb

beforeAll(async () => {
  db = await createPgTestDb()
  await db.pool.query('CREATE TABLE spike_t (id bigint PRIMARY KEY, v bigint NOT NULL, tenant text)')
  await db.pool.query('CREATE TABLE spike_log (id bigserial PRIMARY KEY, t_id bigint NOT NULL)')
  await db.pool.query('INSERT INTO spike_t SELECT g, 0, $1 FROM generate_series(1, $2) g', [TENANT, ROWS])
}, 60000)

afterAll(async () => { if (db) await db.close() })

const setLocalCte = `WITH c AS (SELECT set_config('${GUC}', $2, true))`

/** One op of one variant on a borrowed client. Returns the number of server round trips it took. */
async function runOp(client: pg.PoolClient, variant: Variant, op: Op, id: number): Promise<number> {
  if (op === 'tx3') {
    let rtt = 0
    const q = async (sql: string, params?: unknown[]): Promise<void> => { await client.query(sql, params); rtt++ }
    if (variant === 'S2') await q(`SELECT set_config('${GUC}', $1, false)`, [TENANT])
    await q('BEGIN')
    if (variant === 'S1') await q(`SELECT set_config('${GUC}', $1, true)`, [TENANT])
    await q('SELECT v FROM spike_t WHERE id = $1', [id])
    await q('UPDATE spike_t SET v = v + 1 WHERE id = $1', [id])
    await q('INSERT INTO spike_log (t_id) VALUES ($1)', [id])
    await q('COMMIT')
    if (variant === 'S2') await q(`RESET ${GUC}`)
    return rtt
  }
  const select = 'SELECT v FROM spike_t WHERE id = $1'
  const update = 'UPDATE spike_t SET v = v + 1 WHERE id = $1'
  if (variant === 'S3') { await client.query(op === 'select' ? select : update, [id]); return 1 }
  if (variant === 'S1') {
    await client.query('BEGIN')
    await client.query(op === 'select'
      ? `${setLocalCte} SELECT v FROM spike_t, c WHERE id = $1`
      : `${setLocalCte} UPDATE spike_t SET v = v + 1 FROM c WHERE id = $1`, [id, TENANT])
    await client.query('COMMIT')
    return 3
  }
  await client.query(`SELECT set_config('${GUC}', $1, false)`, [TENANT])
  await client.query(op === 'select' ? select : update, [id])
  await client.query(`RESET ${GUC}`)
  return 3
}

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!

async function measure(variant: Variant, op: Op, poolSize: number, run: number): Promise<void> {
  const pool = new pg.Pool({ connectionString: db.url, types: pgTypes, max: poolSize })
  try {
    // warm up the connections and the plans outside the measurement
    await Promise.all(Array.from({ length: poolSize }, async () => { const c = await pool.connect(); await runOp(c, variant, op, 1); c.release() }))
    const lat: number[] = []
    let next = 0
    let rtt = 0
    const t0 = process.hrtime.bigint()
    const worker = async (): Promise<void> => {
      while (next < N) {
        const i = next++
        const c = await pool.connect()
        const s = process.hrtime.bigint()
        try { rtt = await runOp(c, variant, op, (i % ROWS) + 1) } finally { c.release() }
        lat.push(Number(process.hrtime.bigint() - s) / 1e6)
      }
    }
    await Promise.all(Array.from({ length: poolSize }, () => worker()))
    const total = Number(process.hrtime.bigint() - t0) / 1e6
    lat.sort((a, b) => a - b)
    const f = (x: number): string => x.toFixed(3)
    console.log(`SPIKE variant=${variant} op=${op} pool=${poolSize} run=${run} n=${N} rtt=${rtt} p50=${f(pct(lat, 50))}ms p95=${f(pct(lat, 95))}ms p99=${f(pct(lat, 99))}ms mean=${f(lat.reduce((a, b) => a + b, 0) / lat.length)}ms total=${f(total)}ms qps=${Math.round((N / total) * 1000)}`)
  } finally {
    await pool.end()
  }
}

describe('latency', () => {
  for (const variant of VARIANTS) {
    for (const op of OPS) {
      for (const poolSize of POOLS) {
        it(`${variant} ${op} pool=${poolSize} (${RUNS} runs)`, async () => {
          for (let run = 1; run <= RUNS; run++) await measure(variant, op, poolSize, run)
          expect(true).toBe(true)
        }, 600000)
      }
    }
  }
})

describe('what the next borrower sees after a failure before the connection is given back', () => {
  const seen = async (pool: pg.Pool): Promise<string | null> =>
    (await pool.query<{ v: string | null }>(`SELECT current_setting('${GUC}', true) AS v`)).rows[0]!.v

  it('S1: SET LOCAL dies with the transaction, even when the statement failed and the transaction was rolled back', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      const c = await pool.connect()
      await c.query('BEGIN')
      await c.query(`SELECT set_config('${GUC}', $1, true)`, [TENANT])
      await expect(c.query('SELECT * FROM no_such_table')).rejects.toThrow()
      await c.query('ROLLBACK')
      c.release()
      expect([null, '']).toContain(await seen(pool))
    } finally { await pool.end() }
  })

  it('S1: even a connection given back with the transaction still aborted-open does not carry the value into a committed statement of the next borrower', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      const c = await pool.connect()
      await c.query('BEGIN')
      await c.query(`SELECT set_config('${GUC}', $1, true)`, [TENANT])
      c.release() // the careless path: given back inside the transaction
      // the next borrower is still inside that transaction: it SEES the value. This is the one way S1 leaks: a release without ROLLBACK
      const inherited = await pool.query<{ v: string | null }>(`SELECT current_setting('${GUC}', true) AS v`)
      expect(inherited.rows[0]!.v).toBe(TENANT)
      await pool.query('ROLLBACK')
      expect([null, '']).toContain(await seen(pool))
    } finally { await pool.end() }
  })

  it('S2: a release without the RESET (the error path forgot it) hands the tenant to the next borrower; with the RESET in a finally it does not', async () => {
    const pool = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      const c = await pool.connect()
      await c.query(`SELECT set_config('${GUC}', $1, false)`, [TENANT])
      await expect(c.query('SELECT * FROM no_such_table')).rejects.toThrow()
      c.release() // no RESET
      expect(await seen(pool)).toBe(TENANT)

      const c2 = await pool.connect()
      try { await c2.query(`RESET ${GUC}`) } finally { c2.release() }
      expect([null, '']).toContain(await seen(pool))
    } finally { await pool.end() }
  })
})

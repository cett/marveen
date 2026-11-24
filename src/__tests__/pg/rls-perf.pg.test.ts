// Row-level-security cost: the plan-shape cells (always on). The timing cells follow in this file (PG_RLS_PERF=1).
//
// The policies of migration 0009 put a filter on every statement, and the planner treats it as a security barrier: an
// operator that is not leakproof (`@@` on a tsvector, LIKE) may not be an index condition on a table that has row-level
// security. These cells take the hot statements of the app (src/__tests__/helpers/rls-perf-data.ts, PERF_STATEMENTS) and
// compare the plan of each as the app role with a tenant context against the same statement as the superuser (policies
// bypassed): the set of index names and the Seq Scans over a table of more than 5 000 rows must be equal, except for the
// entries of the allowlists below, each with a reason and a pinned characterisation. A new regression is a red cell.
//
// Class C (a child checked through its parent) differs by design: the policy adds the parent's primary-key lookup, so its
// rule is "the bypass indexes are all still used, and the only extra index is the parent's key".
//
// The fixtures are synthetic and neutral; the data is VACUUMed so the GIN pending list does not distort the cost estimate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createPgTestDb, pgTypes, type PgTestDb } from '../helpers/pg-test-db.js'
import { explainAs, inlineLiterals, PERF_CONTEXTS, PERF_SMALL, PERF_STATEMENTS, PERF_WRITES, liveScale, seedPerf, tenantName, uniformScale, type PerfFacts, type PerfStatement, type PlanFacts } from '../helpers/rls-perf-data.js'
import { withDbContext, type DbContext } from '../../db/context.js'
import { createPgDbx } from '../../db/pg/dbx.js'

const ROWS = 12000
const BIG = 5000

let db: PgTestDb
let facts: PerfFacts
let bigTables: Set<string>

/** The relations a plan reads with a Seq Scan, of the tables above BIG rows. */
const seqOnBig = (p: PlanFacts): string[] => p.seqScans.filter((t) => bigTables.has(t))

beforeAll(async () => {
  db = await createPgTestDb()
  const s = await seedPerf(db.pool, uniformScale(3, ROWS))
  facts = { ...s, tenant: tenantName(1), tenants: 3, rows: ROWS, uid: 'plan' }
  const r = await db.pool.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relkind = 'r' AND reltuples > ${BIG}`)
  bigTables = new Set(r.rows.map((x) => x.relname))
}, 300000)
afterAll(async () => { if (db) await db.close() })

const stmt = (id: string): PerfStatement => PERF_STATEMENTS.find((s) => s.id === id)!
const planApp = (st: PerfStatement, ctx: DbContext = PERF_CONTEXTS.tenant) => explainAs(db.appPool, ctx, inlineLiterals(st.sql, st.params(facts, 0)))
const planBypass = (st: PerfStatement) => explainAs(db.pool, undefined, inlineLiterals(st.sql, st.params(facts, 0)))

// --- the allowlists --------------------------------------------------------------------------------------------------
// F1: a full-text search. `ts_match_vq` is not leakproof, so under row-level security the GIN index is not usable and the
// planner falls back to the tenant index or a Seq Scan. Each entry names the GIN index the bypassed plan uses.
const F1: Record<string, { gin: string; reason: string }> = {
  'memories-fts-tenant': { gin: 'memories_fts_gin', reason: 'the match operator is not leakproof: with the policy filter the GIN index is not an index condition' },
  'memories-fts-notenant': { gin: 'memories_fts_gin', reason: 'the same, and without the explicit tenant filter nothing narrows the scan: a Seq Scan' },
  'artifacts-fts-tenant': { gin: 'artifacts_fts_gin', reason: 'the same on artifacts' },
  'artifacts-fts-notenant': { gin: 'artifacts_fts_gin', reason: 'the same on artifacts, no tenant filter' },
  'workspace-fts-tenant': { gin: 'workspace_docs_fts_gin', reason: 'the same on workspace_docs (no tenant-leading index fits the statement, so a Seq Scan)' },
  'workspace-fts-notenant': { gin: 'workspace_docs_fts_gin', reason: 'the same on workspace_docs, no tenant filter' },
}
// F2: a class C child read in bulk. The policy of memory_embeddings is `EXISTS (SELECT 1 FROM memories p WHERE p.id =
// memory_id)`; when the statement reads many child rows the planner runs it as a HASHED SubPlan: one Seq Scan of the whole
// parent per statement (its own policy filter `tenant_id = tenant OR privileged` cannot use an index), then a hash probe per
// child row. A statement that reads a few children by key keeps a primary-key lookup (see PARENT_KEY). The cost grows with the
// parent, not with the result: the timing cells put a number on it.
const F2: Record<string, { seq: string; reason: string }> = {
  'embedding-similarity': { seq: 'memories', reason: 'the child policy is a hashed SubPlan: one Seq Scan of the whole parent (memories) per statement' },
}
// the parent's primary key, the one index class C adds on purpose
const PARENT_KEY: Record<string, string> = { 'comments-by-card': 'kanban_cards_pkey', 'links-by-src': 'memories_pkey', 'links-two-hop': 'memories_pkey' }
// A statement whose bypassed plan is a Seq Scan of a big table too: the policy is not the cause, an index is missing.
const GAPS: Record<string, { table: string; reason: string }> = {
  'conversation-list-tenant': { table: 'conversation_log', reason: 'no index leads with tenant_id (idx_convlog_agent is agent_id first): a listing by tenant alone scans the table, policy or not' },
}

// The indexes the bypassed plan of each remaining statement must use. Equality of the two plans alone would stay green when an
// index is dropped (both plans degrade alike): the name is pinned too, so a missing index is a red cell, not a silent Seq Scan.
// The conversation log by tenant is the known gap (no index at all, pinned in its own cell below).
const EXPECTED_INDEXES: Record<string, string[]> = {
  'kanban-pk': ['kanban_cards_pkey'],
  'kanban-list': ['idx_kanban_status_sort'],
  'memories-list-agent': ['idx_memories_tenant'],
  'workspace-list': ['idx_workspace_docs_tenant_created'],
  'conversation-list-agent': ['idx_convlog_agent'],
  'conversation-list-tenant': [],
  'audit-list-agent': ['idx_aal_created'],
  'audit-list-recent': ['idx_aal_created'],
  'audit-list-tenant': ['idx_aal_created'],
  'comments-by-card': ['idx_kanban_comments_card'],
  'links-by-src': ['idx_memory_links_src'],
}
// Statements whose plan flips between two near-equal index paths from run to run: one of the family, never none.
const ANY_OF: Record<string, string[]> = { 'links-two-hop': ['idx_memory_links_src', 'memory_links_src_id_dst_id_link_type_key'] }

describe('plan shape: the same index choice and no new Seq Scan of a big table, as the app role versus the bypass', () => {
  for (const st of PERF_STATEMENTS.filter((s) => !(s.id in F1) && !(s.id in F2))) {
    it(`${st.id} (class ${st.cls})`, async () => {
      const [a, b] = [await planApp(st), await planBypass(st)]
      const family = ANY_OF[st.id]
      if (family) {
        // two near-equal paths (the planner flips between them with the sampled statistics): the links index family is pinned,
        // not one name; the policy adds the parent's key and nothing else
        expect(b.indexes.length).toBeGreaterThan(0)
        expect(b.indexes.filter((i) => !family.includes(i))).toEqual([])
        expect(a.indexes.filter((i) => family.includes(i)).length).toBeGreaterThan(0)
        expect(a.indexes.filter((i) => !family.includes(i))).toEqual([PARENT_KEY[st.id]])
        expect(seqOnBig(a)).toEqual(seqOnBig(b))
        return
      }
      expect(b.indexes).toEqual(EXPECTED_INDEXES[st.id])
      if (st.cls === 'C') {
        const extra = a.indexes.filter((i) => !b.indexes.includes(i))
        expect(a.indexes).toEqual(expect.arrayContaining(b.indexes))
        expect(extra).toEqual([PARENT_KEY[st.id]])
      } else {
        expect(a.indexes).toEqual(b.indexes)
      }
      expect(seqOnBig(a)).toEqual(seqOnBig(b))
    })
  }
})

describe('F1: a full-text search loses its GIN index under row-level security (pinned characterisation)', () => {
  // If one of these goes red, the fix landed (a LEAKPROOF match function, or a search function that reads the tenant
  // itself): flip the cell to the equality rule above and delete the entry.
  for (const [id, e] of Object.entries(F1)) {
    it(`${id}: the bypass uses ${e.gin}, the app role does not (${e.reason})`, async () => {
      const [a, b] = [await planApp(stmt(id)), await planBypass(stmt(id))]
      expect(b.indexes).toContain(e.gin)
      expect(a.indexes).not.toContain(e.gin)
    })
  }

  it('the privileged context (admin) loses it too: its policy branch is the same filter', async () => {
    const a = await planApp(stmt('memories-fts-notenant'), PERF_CONTEXTS.admin)
    expect(a.indexes).not.toContain('memories_fts_gin')
    expect(seqOnBig(a)).toContain('memories')
  })

  it('every allowlist entry names a statement of the list (a stale entry is a failure)', () => {
    for (const id of [...Object.keys(F1), ...Object.keys(F2), ...Object.keys(GAPS), ...Object.keys(PARENT_KEY)]) expect(PERF_STATEMENTS.map((s) => s.id)).toContain(id)
  })
})

describe('F2: the similarity query plans a Seq Scan of memories under row-level security (pinned characterisation)', () => {
  for (const [id, e] of Object.entries(F2)) {
    it(`${id}: ${e.reason}`, async () => {
      const [a, b] = [await planApp(stmt(id)), await planBypass(stmt(id))]
      expect(seqOnBig(b)).not.toContain(e.seq)
      expect(seqOnBig(a)).toContain(e.seq)
    })
  }
})

describe('a missing index is not the policy: statements that scan a big table in the bypassed plan too (pinned)', () => {
  // The candidates of a 0010 index. If a cell goes red because the statement now uses an index, the gap is closed: flip it.
  for (const [id, e] of Object.entries(GAPS)) {
    it(`${id}: ${e.reason}`, async () => {
      const [a, b] = [await planApp(stmt(id)), await planBypass(stmt(id))]
      expect(seqOnBig(b)).toContain(e.table)
      expect(seqOnBig(a)).toContain(e.table)
    })
  }
})

describe('the policy filter is ONE InitPlan, not a per-row call of app.tenant()', () => {
  // One representative statement per policy class: A (kanban_cards), B (conversation_log), C (kanban_comments, through the
  // parent's own policy). The wrapper `(SELECT app.tenant())` is what turns the STABLE function into an InitPlan evaluated
  // once; without it the plan inlines the function and calls it per row.
  for (const id of ['kanban-pk', 'conversation-list-agent', 'comments-by-card']) {
    it(`${id} (class ${stmt(id).cls})`, async () => {
      const a = await planApp(stmt(id))
      expect(a.initPlans).toBeGreaterThanOrEqual(1)
      expect(a.text).not.toMatch(/app\.tenant|app\.privileged|current_setting/)
      expect(a.text).toMatch(/InitPlan/)
    })
  }
})

// =====================================================================================================================
// Timing cells (report only). OFF unless PG_RLS_PERF=1: they print one `RLSPERF` line per measurement (grep the log for
// "RLSPERF") and assert nothing but `expect(true)`: a CI runner is too noisy to gate on, the numbers are for the report.
//
//   T   today: the superuser connection, no context (what the app does before row-level security)
//   P0  the app role with the context statement through the real dbx path, policies DISABLED on the tables under test
//       (a second database with the same data): the cost of the context alone
//   P1  the same with the policies of migration 0009 enabled and forced: policy cost = P1 against P0, total = P1 against T
//   P2  informational: P1 without the explicit tenant filter (what a forgotten filter costs: the policy alone filters)
//
// Variants are interleaved inside one run (so machine drift hits all four alike), 3 runs, pool 1 / 4 / 10. A finding line is
// printed when the median per-run P1/P0 p95 ratio is over 1.15 AND the absolute difference is at least 0.15 ms (below that
// the shared runner is noise), and when P1 is over twice T and more than 1 ms slower.
//   PG_RLS_PERF_QUERIES  queries per measurement (default 500; a search statement runs a tenth, at least 20)
//   PG_RLS_PERF_ROWS     rows per big table (default 20000), or "live": max(live rows x 10, 20000) per table, capped at 200000
//   PG_RLS_PERF_TENANTS  the scenarios, comma separated tenant counts (default "1,20": one tenant holds everything / twenty)
// =====================================================================================================================
const PERF = process.env['PG_RLS_PERF'] === '1'
const QUERIES = Number(process.env['PG_RLS_PERF_QUERIES'] ?? 500)
const PERF_ROWS = process.env['PG_RLS_PERF_ROWS'] ?? '20000'
const SCENARIOS = (process.env['PG_RLS_PERF_TENANTS'] ?? '1,20').split(',').map(Number)
const RUNS = 3
const POOLS = [1, 4, 10]
// the tables the policies are switched off on in the P0 database
const P0_TABLES = ['kanban_cards', 'memories', 'artifacts', 'workspace_docs', 'conversation_log', 'agent_audit_log', 'kanban_comments', 'memory_links', 'memory_embeddings',
  'homoglyph_findings', 'autonomy_categories', 'system_config', 'tenants', 'skills']

type Variant = 'T' | 'P0' | 'P1' | 'P2'
const VARIANTS: Variant[] = ['T', 'P0', 'P1', 'P2']
/** `rows`: what the probe call (call number 0) returned: a variant that does different work (an empty result) is not comparable. */
interface Sample { p50: number; p95: number; p99: number; qps: number; rows: number }
const rowsOf = (r: unknown): number => {
  if (Array.isArray(r)) return r.length // dbx.all
  const x = r as { rows?: unknown[]; rowCount?: number | null; changes?: number }
  return x.changes ?? ((x.rows?.length ?? 0) || (x.rowCount ?? 0)) // dbx.run / pool.query
}

const toPg = (sql: string): string => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`) }
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
const f3 = (x: number): string => x.toFixed(3)

describe.skipIf(!PERF)('timing (report only)', () => {
  for (const tenants of SCENARIOS) {
    describe(`${tenants} tenant(s), ${PERF_ROWS} rows per table`, () => {
      let p1: PgTestDb
      let p0: PgTestDb
      let tf: PerfFacts
      beforeAll(async () => {
        const scale = PERF_ROWS === 'live' ? liveScale(tenants) : uniformScale(tenants, Number(PERF_ROWS))
        p1 = await createPgTestDb()
        p0 = await createPgTestDb()
        const seeded = await seedPerf(p1.pool, scale)
        await seedPerf(p0.pool, scale)
        for (const d of [p1, p0]) {
          for (let i = 1; i <= tenants; i++) await d.pool.query('INSERT INTO tenants (id, display_name, created_at) VALUES ($1, $1, 1) ON CONFLICT DO NOTHING', [tenantName(i)])
        }
        for (const t of P0_TABLES) await p0.ownerPool.query(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`)
        tf = { ...seeded, tenant: tenantName(1), tenants, rows: scale.rows.kanban_cards, uid: `perf${tenants}` }
      }, 1800000)
      afterAll(async () => { await Promise.all([p1?.close(), p0?.close()]) })

      /** One measurement: `n` calls spread over `poolSize` workers. */
      async function measure(variant: Variant, st: PerfStatement, ctxName: keyof typeof PERF_CONTEXTS, poolSize: number, run: number): Promise<Sample> {
        const noTenant = variant === 'P2'
        const sql = noTenant ? st.noTenant!.sql : st.sql
        const paramsFn = noTenant ? st.noTenant!.params : st.params
        const ctx: DbContext = PERF_CONTEXTS[ctxName]
        const n = st.op === 'search' ? Math.max(20, Math.floor(QUERIES / 10)) : QUERIES
        const facts = { ...tf, uid: `${tf.uid}-${variant}-${run}-${poolSize}` }
        const isWrite = st.op === 'insert' || st.op === 'update'
        let call: (i: number) => Promise<unknown>
        let pool: pg.Pool
        if (variant === 'T') {
          pool = new pg.Pool({ connectionString: p1.url, types: pgTypes, max: poolSize })
          const text = toPg(sql)
          call = (i) => pool.query(text, paramsFn(facts, i))
        } else {
          const db = variant === 'P0' ? p0 : p1
          pool = new pg.Pool({ connectionString: db.appUrl, types: pgTypes, max: poolSize })
          const dbx = createPgDbx(pool)
          call = (i) => withDbContext(ctx, () => (isWrite ? dbx.run(sql, ...paramsFn(facts, i)) : dbx.all(sql, ...paramsFn(facts, i))))
        }
        try {
          // warm up the connections and the plans outside the measurement
          await Promise.all(Array.from({ length: poolSize }, (_, k) => call(1000000 + k)))
          const rows = rowsOf(await call(2000000))
          const lat: number[] = []
          let next = 0
          const t0 = process.hrtime.bigint()
          const worker = async (): Promise<void> => {
            while (next < n) {
              const i = next++
              const s = process.hrtime.bigint()
              await call(i)
              lat.push(Number(process.hrtime.bigint() - s) / 1e6)
            }
          }
          await Promise.all(Array.from({ length: poolSize }, () => worker()))
          const total = Number(process.hrtime.bigint() - t0) / 1e6
          lat.sort((a, b) => a - b)
          const sample = { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), qps: Math.round((n / total) * 1000), rows }
          console.log(`RLSPERF tenants=${tenants} rows=${PERF_ROWS} stmt=${st.id} class=${st.cls} op=${st.op} ctx=${ctxName} variant=${variant} pool=${poolSize} run=${run} n=${n} p50=${f3(sample.p50)}ms p95=${f3(sample.p95)}ms p99=${f3(sample.p99)}ms qps=${sample.qps} rows=${rows}`)
          return sample
        } finally {
          await pool.end()
        }
      }

      /** All variants, pools and runs of one statement in one context; then the verdict lines. */
      async function report(st: PerfStatement, ctxName: keyof typeof PERF_CONTEXTS, pools: number[]): Promise<void> {
        const variants = VARIANTS.filter((v) => v !== 'P2' || st.noTenant)
        for (const poolSize of pools) {
          const got: Record<string, Sample[]> = {}
          for (let run = 1; run <= RUNS; run++) {
            // rotate the starting variant so none is always first after a pause
            for (const v of [...variants.slice(run % variants.length), ...variants.slice(0, run % variants.length)]) {
              (got[v] ??= []).push(await measure(v, st, ctxName, poolSize, run))
            }
          }
          // the tenant context must see what the superuser sees, or the variants did different work (viewer: zero is the point)
          if (ctxName !== 'viewer' && ctxName !== 'admin' && st.ctxs?.[0] !== 'admin' && got['T']![0]!.rows !== got['P1']![0]!.rows) {
            console.log(`RLSPERF-WARN rows differ stmt=${st.id} ctx=${ctxName} pool=${poolSize}: T=${got['T']![0]!.rows} P1=${got['P1']![0]!.rows}`)
          }
          const ratios = got['P1']!.map((s, k) => s.p95 / got['P0']![k]!.p95)
          const diffs = got['P1']!.map((s, k) => s.p95 - got['P0']![k]!.p95)
          const ratio = median(ratios)
          const diff = median(diffs)
          const t95 = median(got['T']!.map((s) => s.p95))
          const p195 = median(got['P1']!.map((s) => s.p95))
          console.log(`RLSPERF-SUMMARY tenants=${tenants} stmt=${st.id} class=${st.cls} op=${st.op} ctx=${ctxName} pool=${poolSize} T=${f3(t95)}ms P0=${f3(median(got['P0']!.map((s) => s.p95)))}ms P1=${f3(p195)}ms${got['P2'] ? ` P2=${f3(median(got['P2']!.map((s) => s.p95)))}ms` : ''} policy-ratio=${ratio.toFixed(2)} policy-diff=${f3(diff)}ms total-ratio=${(p195 / t95).toFixed(2)}`)
          if (ratio > 1.15 && diff >= 0.15) console.log(`RLSPERF-FINDING policy tenants=${tenants} stmt=${st.id} ctx=${ctxName} pool=${poolSize} P1/P0 p95 ratio=${ratio.toFixed(2)} diff=${f3(diff)}ms`)
          if (p195 > 2 * t95 && p195 - t95 > 1) console.log(`RLSPERF-FINDING total tenants=${tenants} stmt=${st.id} ctx=${ctxName} pool=${poolSize} P1 ${f3(p195)}ms against T ${f3(t95)}ms`)
        }
      }

      // statements the plan cells use, minus the duplicates that only exist as the tenant-less variant of another
      for (const st of PERF_STATEMENTS.filter((s) => !s.noTenantFilter)) {
        it(`${st.id}`, async () => { await report(st, 'tenant', POOLS); expect(true).toBe(true) }, 3600000)
      }
      for (const st of PERF_WRITES) {
        it(`${st.id}`, async () => { await report(st, 'tenant', POOLS); expect(true).toBe(true) }, 3600000)
      }
      for (const st of PERF_SMALL) {
        for (const c of st.ctxs ?? ['tenant']) it(`${st.id} as ${c}`, async () => { await report(st, c, [4]); expect(true).toBe(true) }, 3600000)
      }
      // the other contexts: the privileged OR branch (admin), an agent, and the tenant-less viewer (zero rows)
      for (const id of ['kanban-pk', 'kanban-list', 'memories-list-agent']) {
        for (const c of ['agent', 'admin', 'viewer'] as const) {
          it(`${id} as ${c}`, async () => { await report(PERF_STATEMENTS.find((s) => s.id === id)!, c, [4]); expect(true).toBe(true) }, 3600000)
        }
      }
    })
  }
})

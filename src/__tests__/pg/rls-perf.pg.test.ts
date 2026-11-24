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
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { explainAs, inlineLiterals, PERF_CONTEXTS, PERF_STATEMENTS, seedPerf, tenantName, uniformScale, type PerfFacts, type PerfStatement, type PlanFacts } from '../helpers/rls-perf-data.js'
import type { DbContext } from '../../db/context.js'

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
  facts = { ...s, tenant: tenantName(1) }
  const r = await db.pool.query<{ relname: string }>(`SELECT relname FROM pg_class WHERE relkind = 'r' AND reltuples > ${BIG}`)
  bigTables = new Set(r.rows.map((x) => x.relname))
}, 300000)
afterAll(async () => { if (db) await db.close() })

const stmt = (id: string): PerfStatement => PERF_STATEMENTS.find((s) => s.id === id)!
const planApp = (st: PerfStatement, ctx: DbContext = PERF_CONTEXTS.tenant) => explainAs(db.appPool, ctx, inlineLiterals(st.sql, st.params(facts)))
const planBypass = (st: PerfStatement) => explainAs(db.pool, undefined, inlineLiterals(st.sql, st.params(facts)))

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
// F2: the similarity query joins memory_embeddings to memories; the policy filter on the memories side changes the join order
// to a Seq Scan of memories. The distance calculation over the embeddings is an exact scan either way: the timing cells say
// whether the plan change costs anything.
const F2: Record<string, { seq: string; reason: string }> = {
  'embedding-similarity': { seq: 'memories', reason: 'the policy filter on the parent changes the join: Seq Scan of memories instead of a primary-key lookup per embedding' },
}
// the parent's primary key, the one index class C adds on purpose
const PARENT_KEY: Record<string, string> = { 'comments-by-card': 'kanban_cards_pkey', 'links-by-src': 'memories_pkey', 'links-two-hop': 'memories_pkey' }
// A statement whose bypassed plan is a Seq Scan of a big table too: the policy is not the cause, an index is missing.
const GAPS: Record<string, { table: string; reason: string }> = {
  'conversation-list-tenant': { table: 'conversation_log', reason: 'no index leads with tenant_id (idx_convlog_agent is agent_id first): a listing by tenant alone scans the table, policy or not' },
}

describe('plan shape: the same index choice and no new Seq Scan of a big table, as the app role versus the bypass', () => {
  for (const st of PERF_STATEMENTS.filter((s) => !(s.id in F1) && !(s.id in F2))) {
    it(`${st.id} (class ${st.cls})`, async () => {
      const [a, b] = [await planApp(st), await planBypass(st)]
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

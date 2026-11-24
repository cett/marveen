// Synthetic data and plan helpers of the row-level-security performance cells (src/__tests__/pg/rls-perf.pg.test.ts).
//
// The fixtures are neutral (tenant-t1.., agent-a, plain words): the cells measure the policies of the REAL migration 0009 on
// tables of a size the caller chooses, so nothing here copies live content. Rows are bulk-inserted by the admin pool
// (the oracle: the policies do not apply to it), then ANALYZEd, so the planner sees the real statistics.
import type pg from 'pg'
import { PG_SET_CONTEXT_SQL, pgContextValues } from '../../db/pg/dbx.js'
import type { DbContext } from '../../db/context.js'

export const PERF_TABLES = ['kanban_cards', 'memories', 'conversation_log', 'agent_audit_log', 'artifacts', 'workspace_docs'] as const
export type PerfTable = (typeof PERF_TABLES)[number]

export interface PerfScale {
  /** How many tenants share the rows (1 = today's installation: one tenant holds everything). */
  tenants: number
  /** Rows per table. */
  rows: Readonly<Record<PerfTable, number>>
}

export const tenantName = (i: number): string => `tenant-t${i}`
/** The words the full-text cells search for: `alpha` is in one row of every ten, `omega` in one row of a thousand. */
export const PERF_WORDS = { common: 'alpha', rare: 'omega' } as const

/** A uniform scale: `rows` rows in every table. */
export function uniformScale(tenants: number, rows: number): PerfScale {
  return { tenants, rows: Object.fromEntries(PERF_TABLES.map((t) => [t, rows])) as Record<PerfTable, number> }
}

// the text of row g: a few filler words, `alpha` every 10th row, `omega` every 1000th
const WORDS = (g: string): string =>
  `'row ' || ${g} || ' filler words of a neutral text' || CASE WHEN ${g} % 10 = 0 THEN ' alpha' ELSE '' END || CASE WHEN ${g} % 1000 = 0 THEN ' omega' ELSE '' END`

/**
 * Inserts the rows. The tenant of row g is tenant-t(1 + g % tenants), the agent agent-a / agent-b by parity, `created_at`
 * grows with g (so a recent-first list is a backward index scan). Child tables follow: ten comments per card for the first
 * 1000 cards, a link chain over the first 5000 memories, one 768-dimension embedding for the first 5000 memories.
 */
export async function seedPerf(admin: pg.Pool, scale: PerfScale): Promise<{ memLo: number; memCount: number }> {
  const T = scale.tenants
  const tenant = `'tenant-t' || (1 + g % ${T})`
  const agent = `CASE WHEN g % 2 = 0 THEN 'agent-a' ELSE 'agent-b' END`
  const r = scale.rows
  await admin.query(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, tenant_id)
    SELECT 'card-' || g, 'card title ' || g, CASE WHEN g % 3 = 0 THEN 'planned' WHEN g % 3 = 1 THEN 'in_progress' ELSE 'done' END, 'normal', g, 1700000000 + g, 1700000000 + g, ${tenant}
    FROM generate_series(1, ${r.kanban_cards}) g`)
  await admin.query(`INSERT INTO memories (chat_id, content, keywords, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, tenant_id)
    SELECT 'chat-' || (g % 20), ${WORDS('g')}, 'kw' || (g % 50), 'semantic', 1.0, 1700000000 + g, 1700000000 + g, ${agent}, CASE WHEN g % 7 = 0 THEN 'shared' ELSE 'warm' END, 0, ${tenant}
    FROM generate_series(1, ${r.memories}) g`)
  await admin.query(`INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at, tenant_id)
    SELECT ${agent}, 'chat-' || (g % 20), 'in', g::text, 'message ' || g, 1700000000 + g, 1700000000 + g, ${tenant}
    FROM generate_series(1, ${r.conversation_log}) g`)
  await admin.query(`INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail, created_at, tenant_id)
    SELECT ${agent}, 'message', 'create', g::text, '{}', 1700000000 + g, ${tenant}
    FROM generate_series(1, ${r.agent_audit_log}) g`)
  await admin.query(`INSERT INTO artifacts (agent_id, title, kind, mime, content, meta, created_at, updated_at, tenant_id)
    SELECT ${agent}, 'artifact title ' || g, 'markdown', 'text/markdown', convert_to(${WORDS('g')}, 'UTF8'), '{}', 1700000000 + g, 1700000000 + g, ${tenant}
    FROM generate_series(1, ${r.artifacts}) g`)
  await admin.query(`INSERT INTO workspace_docs (id, agent_id, tenant_id, doc_key, title, content, type, size_bytes, created_at, updated_at)
    SELECT 'doc-' || g, ${agent}, ${tenant}, 'plan/doc-' || g, 'doc title ' || g, ${WORDS('g')}, 'plan', 100, 1700000000 + g, 1700000000 + g
    FROM generate_series(1, ${r.workspace_docs}) g`)
  // children (class C): comments per card, a link chain and embeddings over the first memories
  const cards = Math.min(1000, r.kanban_cards)
  await admin.query(`INSERT INTO kanban_comments (card_id, author, content, created_at)
    SELECT 'card-' || c, 'agent-a', 'comment ' || k, 1700000000 + k FROM generate_series(1, ${cards}) c, generate_series(1, 10) k`)
  const mems = Math.min(5000, r.memories)
  const ids = await admin.query<{ min: number }>('SELECT min(id)::int AS min FROM memories')
  const lo = ids.rows[0]!.min
  await admin.query(`INSERT INTO memory_links (src_id, dst_id, link_type, weight, created_at)
    SELECT ${lo} + g - 1, ${lo} + (g % ${mems}), 'semantic', 1.0, 1700000000 FROM generate_series(1, ${mems}) g`)
  await admin.query(`INSERT INTO memory_embeddings (memory_id, embedding)
    SELECT ${lo} + g - 1, ('[' || array_to_string(ARRAY(SELECT round(((g * 31 + d * 17) % 100)::numeric / 100, 3) FROM generate_series(1, 768) d), ',') || ']')::vector
    FROM generate_series(1, ${mems}) g`)
  // VACUUM, not only ANALYZE: a bulk-loaded GIN index keeps its entries in the pending list, and the planner prices that list
  // into every search, so an unvacuumed fixture would never plan the GIN index (a steady-state table has it flushed)
  for (const t of [...PERF_TABLES, 'kanban_comments', 'memory_links', 'memory_embeddings']) await admin.query(`VACUUM (ANALYZE) ${t}`)
  return { memLo: lo, memCount: mems }
}

/** The contexts the cells run as (neutral names). */
export const PERF_CONTEXTS = {
  tenant: { role: 'tenant', tenantId: tenantName(1) },
  agent: { role: 'agent', tenantId: tenantName(1), agentId: 'agent-a' },
  admin: { role: 'admin', name: 'perf' },
  viewer: { role: 'viewer', name: 'perf' },
} as const satisfies Record<string, DbContext>

// ---------------------------------------------------------------------------------------------------------------------
// The statements. Written the way the app sends them (`?` placeholders, the dbx dialect), so the plan cells inline the
// literals and the timing cells send them through the real facade. The shapes follow src/db/*; where the app builds a longer
// text (the phrase verification of a full-text search), the cell keeps the part that decides the plan (the `@@` on `fts`).
// ---------------------------------------------------------------------------------------------------------------------
export type PerfClass = 'A' | 'B' | 'C'
export interface PerfFacts { memLo: number; memCount: number; tenant: string }
export interface PerfStatement {
  id: string
  cls: PerfClass
  op: 'select' | 'list' | 'search'
  sql: string
  params: (f: PerfFacts) => unknown[]
  /** True when the statement has no explicit tenant filter (what a forgotten filter costs: the policy alone filters). */
  noTenantFilter?: boolean
}

const FTS = "'public.marveen_fts'"

export const PERF_STATEMENTS: PerfStatement[] = [
  { id: 'kanban-pk', cls: 'A', op: 'select', sql: 'SELECT * FROM kanban_cards WHERE id = ?', params: () => ['card-100'] },
  { id: 'kanban-list', cls: 'A', op: 'list', sql: "SELECT * FROM kanban_cards WHERE tenant_id = ? AND status = 'in_progress' AND archived_at IS NULL ORDER BY sort_order LIMIT 50", params: (f) => [f.tenant] },
  { id: 'memories-list-agent', cls: 'A', op: 'list', sql: 'SELECT * FROM memories WHERE tenant_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 50', params: (f) => [f.tenant, 'agent-a'] },
  { id: 'memories-fts-tenant', cls: 'A', op: 'search', sql: `SELECT m.id FROM memories m WHERE m.fts @@ to_tsquery(${FTS}, ?) AND m.chat_id = ? AND m.tenant_id = ? ORDER BY m.id LIMIT 20`, params: (f) => [PERF_WORDS.rare, 'chat-1', f.tenant] },
  { id: 'memories-fts-notenant', cls: 'A', op: 'search', noTenantFilter: true, sql: `SELECT m.id FROM memories m WHERE m.fts @@ to_tsquery(${FTS}, ?) AND m.chat_id = ? ORDER BY m.id LIMIT 20`, params: () => [PERF_WORDS.rare, 'chat-1'] },
  { id: 'artifacts-fts-tenant', cls: 'A', op: 'search', sql: `SELECT a.id FROM artifacts a WHERE a.fts @@ to_tsquery(${FTS}, ?) AND a.tenant_id = ? ORDER BY a.id LIMIT 20`, params: (f) => [PERF_WORDS.rare, f.tenant] },
  { id: 'artifacts-fts-notenant', cls: 'A', op: 'search', noTenantFilter: true, sql: `SELECT a.id FROM artifacts a WHERE a.fts @@ to_tsquery(${FTS}, ?) ORDER BY a.id LIMIT 20`, params: () => [PERF_WORDS.rare] },
  { id: 'workspace-fts-tenant', cls: 'A', op: 'search', sql: `SELECT wd.id FROM workspace_docs wd WHERE wd.fts @@ to_tsquery(${FTS}, ?) AND wd.tenant_id = ? ORDER BY wd.id LIMIT 20`, params: (f) => [PERF_WORDS.rare, f.tenant] },
  { id: 'workspace-fts-notenant', cls: 'A', op: 'search', noTenantFilter: true, sql: `SELECT wd.id FROM workspace_docs wd WHERE wd.fts @@ to_tsquery(${FTS}, ?) ORDER BY wd.id LIMIT 20`, params: () => [PERF_WORDS.rare] },
  { id: 'workspace-list', cls: 'A', op: 'list', sql: 'SELECT id, title FROM workspace_docs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50', params: (f) => [f.tenant] },
  { id: 'conversation-list-agent', cls: 'B', op: 'list', sql: 'SELECT * FROM conversation_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50', params: () => ['agent-a'] },
  { id: 'conversation-list-tenant', cls: 'B', op: 'list', sql: 'SELECT * FROM conversation_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50', params: (f) => [f.tenant] },
  { id: 'audit-list-agent', cls: 'B', op: 'list', sql: 'SELECT * FROM agent_audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50', params: () => ['agent-a'] },
  { id: 'audit-list-recent', cls: 'B', op: 'list', noTenantFilter: true, sql: 'SELECT * FROM agent_audit_log ORDER BY created_at DESC LIMIT 50', params: () => [] },
  { id: 'audit-list-tenant', cls: 'B', op: 'list', sql: 'SELECT * FROM agent_audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50', params: (f) => [f.tenant] },
  { id: 'comments-by-card', cls: 'C', op: 'list', sql: 'SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at', params: () => ['card-5'] },
  { id: 'links-by-src', cls: 'C', op: 'select', sql: 'SELECT * FROM memory_links WHERE src_id = ?', params: (f) => [f.memLo + 10] },
  { id: 'links-two-hop', cls: 'C', op: 'select', sql: 'SELECT l2.dst_id FROM memory_links l1 JOIN memory_links l2 ON l2.src_id = l1.dst_id WHERE l1.src_id = ?', params: (f) => [f.memLo + 10] },
  { id: 'embedding-similarity', cls: 'C', op: 'search', sql: "SELECT m.id, e.embedding <-> ?::vector AS distance FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id WHERE (m.agent_id = ? OR m.category = 'shared') AND m.tenant_id = ? ORDER BY distance, m.id LIMIT 10", params: (f) => [PERF_QUERY_VECTOR, 'agent-a', f.tenant] },
]

/** Inlines `?` placeholders as SQL literals (strings quoted, numbers as they are): only for EXPLAIN text, never for a live call. */
export function inlineLiterals(sql: string, params: readonly unknown[]): string {
  let i = 0
  return sql.replace(/\?/g, () => {
    const v = params[i++]
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
  })
}

/** The `[dim]` text of one 768-dimension query vector. */
export const PERF_QUERY_VECTOR = `[${Array.from({ length: 768 }, (_, d) => ((d * 7) % 100) / 100).join(',')}]`

/** Runs `fn` on one client inside a transaction with the five context settings of `ctx` (what dbx sends per call). */
export async function inContext<T>(pool: pg.Pool, ctx: DbContext | undefined, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues(ctx) })
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    c.release()
  }
}

export interface PlanFacts {
  /** Index names used anywhere in the plan, sorted. */
  indexes: string[]
  /** Relations read by a Seq Scan, sorted. */
  seqScans: string[]
  /** How many InitPlan nodes the plan has. */
  initPlans: number
  /** The whole plan as text (for a substring check). */
  text: string
}

interface PlanNode { 'Node Type'?: string; 'Index Name'?: string; 'Relation Name'?: string; 'Parent Relationship'?: string; Plans?: PlanNode[] }

/** Reads the JSON of `EXPLAIN (FORMAT JSON, COSTS OFF)` into the facts the cells compare. */
export function planFacts(explainRow: unknown): PlanFacts {
  const root = (explainRow as Array<{ Plan: PlanNode }>)[0]!.Plan
  const indexes = new Set<string>()
  const seq = new Set<string>()
  let initPlans = 0
  const walk = (n: PlanNode): void => {
    if (n['Index Name']) indexes.add(n['Index Name'])
    if (n['Node Type'] === 'Seq Scan' && n['Relation Name']) seq.add(n['Relation Name'])
    if (n['Parent Relationship'] === 'InitPlan') initPlans++
    for (const p of n.Plans ?? []) walk(p)
  }
  walk(root)
  return { indexes: [...indexes].sort(), seqScans: [...seq].sort(), initPlans, text: JSON.stringify(explainRow) }
}

/** EXPLAIN of `sql` (literals inlined) as `ctx`, on `pool`. */
export async function explainAs(pool: pg.Pool, ctx: DbContext | undefined, sql: string): Promise<PlanFacts> {
  return inContext(pool, ctx, async (c) => {
    const r = await c.query(`EXPLAIN (FORMAT JSON, COSTS OFF) ${sql}`)
    return planFacts(r.rows[0]['QUERY PLAN'])
  })
}

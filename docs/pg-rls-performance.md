# Row-level security: what it costs and when to look again

Measured on PostgreSQL 16 with the real policies of migration `0009` (the plan cells and the report-only timing cells of
`src/__tests__/pg/rls-perf.pg.test.ts`). This page records the result, the decisions taken on it and the trigger that reopens them.

## Result

- The policy expression is one InitPlan per statement and costs about 0.0 to 0.2 ms at the median (p50) on pk lookups, lists, inserts,
  updates, the append tables and the small tables. No index choice changes for them.
- The per-call context (`BEGIN`, `set_config`, `COMMIT` in `dbx`) costs about 0.3 ms per statement. That is not row-level security;
  it is the same with the policies off.
- **Full-text search loses its GIN index** under row-level security (`memories`, `artifacts`, `workspace_docs`): the match operator
  (`ts_match_vq`) is not leakproof, so it cannot be an index condition on a table with row-level security. The cost grows with the rows
  one tenant owns: memories, one tenant, p50 0.34 ms at 2 000 rows, about 4 ms at 20 000 to 50 000, about 10 ms at 100 000. With many
  tenants the same totals appear at 5 to 10 times more rows. The explicit tenant filter in every search stays mandatory (without it the
  cost is 5 to 10 times higher with many tenants).
- **A child table read in bulk scans its parent once per statement** (class C, for example the similarity query over
  `memory_embeddings`): the policy `EXISTS (SELECT 1 FROM memories ...)` is planned as a hashed SubPlan over the whole parent. About
  +9 ms at 20 000 memories and +58 ms at 200 000 (one tenant, p50). The same shape applies to `artifact_embeddings` and
  `workspace_doc_embeddings`.
- `conversation_log` listed by tenant alone scans the table with or without the policy (no index leads with `tenant_id`). No production
  read does that: every read is agent first, the rest is the prune. It is pinned in a cell and left as it is.

## Decisions

1. Full-text search (F1): accept. No policy, role or function change. A search function with its own bypass role, or declaring the match
   functions leakproof (a superuser catalog change outside the migrations), are not done now; if the trigger below is reached, the
   search function with a separate reviewed role is the first choice and needs its own plan.
2. Child tables read in bulk (F2): accept. At the same trigger, the plan is to carry `tenant_id` into the embedding tables (backfilled from
   the parent, kept consistent by the database with a composite key and foreign key) and give them the tenant-row policy; that is a schema
   and policy change with its own plan.
3. No new index on `conversation_log` now. If a tenant-wide log view appears, add `(tenant_id, created_at DESC)` in a PG-only migration and
   flip the pinned gap cell in the same change.
4. The p95 of a single cell is not a verdict on a shared machine. A finding is a changed plan, or a p50 difference that is more than 15%
   and more than 0.15 ms. The CI step is orientation only and never gates a merge.

## Trigger to look again

One tenant reaches about **20 000 rows** in `memories`, `artifacts` or `workspace_docs`, **or** a full-text request passes **10 ms at p95**
in production. Today the largest of the three is `memories` with about 1 900 rows. Count per tenant:

```sql
SELECT tenant_id, count(*) FROM memories GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
```

(the same for `artifacts` and `workspace_docs`).

## Running the cells

The plan cells always run in `npm run test:pg`. The timing cells are off unless `PG_RLS_PERF=1`; they print one `RLSPERF` line per
measurement. `PG_RLS_PERF_QUERIES` (default 500; use 2000 or more for numbers you quote), `PG_RLS_PERF_ROWS` (default 20000, or `live`
for max(live rows x 10, 20000) per table, capped at 200000), `PG_RLS_PERF_TENANTS` (default `1,20`). Select cells with
`-t <statement id>`. The CI step "PostgreSQL RLS overhead (report only)" runs it with 200 queries and 20 000 rows and never fails the job.

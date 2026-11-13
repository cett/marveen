// The partition of the `useTestDb` test files for the PostgreSQL module run (`npm run test:pg-modules`).
//
// Every test file that imports helpers/with-test-db is in exactly ONE list: `PORTED` (it also runs in PG mode,
// MARVEEN_TEST_DB=pg, next to its SQLite run in the default suite: the double CI) or `EXCLUDED` with a reason code.
// A new useTestDb file in neither list is a red test (pg-modules-partition.test.ts), so the PG run cannot lose a file
// without anybody deciding it, and the number of EXCLUDED files may only go down (EXCLUDED_BASELINE, lowered by hand in
// the commit that ports a module).
//
// Reason codes:
//   fts               needs FTS5 (MATCH, the *_fts tables): Phase 3
//   vec               needs sqlite-vec / vec0: Phase 3
//   p2-4-concurrency  the test is about SQLite's one-connection concurrency semantics: replaced in P2-4
//   boot-twin         the boot chain (synchronous, 14 twins): P2-5
//   sqlite-only       the files whose SUBJECT is the SQLite facade, handle or migration chain itself (db-facade*,
//                     with-test-db: own DDL, AUTOINCREMENT, transaction semantics), and a file that asserts the SQLite
//                     query planner or catalog (audit-log-trace-filter: EXPLAIN QUERY PLAN): they stay SQLite by design
//   sync-cache        the synchronous in-memory cache and its loader (db-config-cache, db-model-profile-map-cache):
//                     they move with the async cache load, not with a module
//   (the codes of the first run are assigned from the file text and the failure classes, not file by file: a
//   wave that takes a module revisits its files)
//   raw-db            the test or the module under test still reads the raw SQLite handle or a synchronous cache
//   unported-sql      SQL that has no common text for both dialects yet (a module still to be ported)
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type ExcludeReason = 'fts' | 'vec' | 'p2-4-concurrency' | 'boot-twin' | 'sqlite-only' | 'sync-cache' | 'raw-db' | 'unported-sql'

/** Test files (relative to the repository root, `/` separators) that also run in PG mode. */
export const PORTED: readonly string[] = [
  'src/__tests__/db-context-route.test.ts',
  'src/__tests__/db-cost-budgets-month.test.ts',
  'src/__tests__/db-dashboard-user-delete-case.test.ts',
  'src/__tests__/db-like-case-vault.test.ts',
  'src/__tests__/db-like-case-sessions.test.ts',
  'src/__tests__/db-like-case-agents.test.ts',
  'src/__tests__/db-like-case-import.test.ts',
  'src/__tests__/db-like-case-workspace.test.ts',
  'src/__tests__/db-token-usage-prune-local-day.test.ts',
  'src/__tests__/hook-audit-body-trace.test.ts',
  'src/__tests__/schedules-author-db.test.ts',
  'src/__tests__/agent-state-route.test.ts',
  'src/__tests__/auth-path-failure-modes.test.ts',
  'src/__tests__/egress-allowlist-quarantine-seed-supplement.test.ts',
  'src/__tests__/import-crawler-blank-source.test.ts',
  'src/__tests__/import-db-helpers.test.ts',
  'src/__tests__/import-strip-markup-entities.test.ts',
  'src/__tests__/refuse-write.test.ts',
  'src/__tests__/fleet-import-rows-handle.test.ts',
  'src/__tests__/fleet-import-body-handle.test.ts',
  'src/__tests__/fleet-import-apply-both-engines.test.ts',
  'src/__tests__/kanban-seq.test.ts',
  'src/__tests__/otel-span-upsert-export-mark.test.ts',
  'src/__tests__/tool-calls-insertion-order.test.ts',
  'src/__tests__/token-usage-sums.test.ts',
  'src/__tests__/token-shadow-totals.test.ts',
  'src/__tests__/task-run-history-tokens.test.ts',
  'src/__tests__/api-tokens-tx-handle.test.ts',
  'src/__tests__/db-context.test.ts',
  'src/__tests__/db-read-then-write-transactions.test.ts',
  'src/__tests__/retention-sweep-tx-handle.test.ts',
  'src/__tests__/prune-token-usage-tx-handle.test.ts',
  'src/__tests__/approval-human-only.test.ts',
  'src/__tests__/otel-logs-trace.test.ts',
  'src/__tests__/kanban-correlate-usage.test.ts',
  'src/__tests__/like-escape-remaining-searches.test.ts',
  'src/__tests__/audit-retention-prune-journals.test.ts',
  'src/__tests__/db-overview.test.ts',
  'src/__tests__/import-crawler-run-due.test.ts',
  'src/__tests__/import-crawler-tenant.test.ts',
  'src/__tests__/kanban-tx-handle-audit.test.ts',
  'src/__tests__/memories-content-not-blank.test.ts',
  'src/__tests__/tenant-gate-status-route.test.ts',
  'src/__tests__/db-device-keys.test.ts',
  'src/__tests__/observability-model-tool-stats.test.ts',
]

/** Test files (same form) that do not, each with the reason. */
export const EXCLUDED: Readonly<Record<string, ExcludeReason>> = {
  'src/__tests__/db-import-transactions.test.ts': 'vec',
  'src/__tests__/import-tx-handle.test.ts': 'vec',
  'src/__tests__/like-escape-memory-searches.test.ts': 'vec',
  'src/__tests__/tenant-scoped-db.test.ts': 'vec',
  'src/__tests__/vector-memory-facade.test.ts': 'vec',
  'src/__tests__/vector-memory-reads.test.ts': 'vec',
  'src/__tests__/agents-w36-concurrency.test.ts': 'p2-4-concurrency',
  'src/__tests__/approval-vault-concurrency.test.ts': 'p2-4-concurrency',
  'src/__tests__/approval-vault-statements.test.ts': 'p2-4-concurrency',
  'src/__tests__/audit-async-writers.test.ts': 'p2-4-concurrency',
  'src/__tests__/audit-retention-prune.test.ts': 'p2-4-concurrency',
  'src/__tests__/auth-session-lane.test.ts': 'p2-4-concurrency',
  'src/__tests__/db-api-tokens-rotate.test.ts': 'p2-4-concurrency',
  'src/__tests__/import-crawler-overlap.test.ts': 'p2-4-concurrency',
  'src/__tests__/kanban-audit-after-commit.test.ts': 'p2-4-concurrency',
  'src/__tests__/misc-concurrency.test.ts': 'p2-4-concurrency',
  'src/__tests__/sessions-async-facade.test.ts': 'p2-4-concurrency',
  'src/__tests__/telemetry-facade-overlap.test.ts': 'p2-4-concurrency',
  'src/__tests__/tenant-bindings-facade.test.ts': 'p2-4-concurrency',
  'src/__tests__/vault-facade-overlap.test.ts': 'p2-4-concurrency',
  'src/__tests__/audit-trace-columns.test.ts': 'boot-twin',
  'src/__tests__/db-config-cache.test.ts': 'sync-cache',
  'src/__tests__/db-facade-backend.test.ts': 'sqlite-only',
  'src/__tests__/db-facade-tx.test.ts': 'sqlite-only',
  'src/__tests__/db-facade.test.ts': 'sqlite-only',
  'src/__tests__/db-model-profile-map-cache.test.ts': 'sync-cache',
  'src/__tests__/with-test-db.test.ts': 'sqlite-only',
  'src/__tests__/db-api-tokens-enroll-twin.test.ts': 'raw-db',
  // two cells assert the SQLite planner (EXPLAIN QUERY PLAN) and the SQLite catalog (sqlite_master) of the trace indexes;
  // on PostgreSQL a tiny test table gets a sequential scan whatever the index says, so the same assertion would need a
  // planner switch (enable_seqscan) and would test the switch, not the filter
  'src/__tests__/audit-log-trace-filter.test.ts': 'sqlite-only',
  'src/__tests__/db-agent-state-facade.test.ts': 'unported-sql',
}

/** The number of EXCLUDED files the partition test accepts. It only goes down. */
export const EXCLUDED_BASELINE = 30

/** A file uses useTestDb when it imports the helper AND calls useTestDb( (a file that only imports resetDbTestState or testDbMode does not). */
const IMPORT = /from\s+['"][^'"]*helpers\/with-test-db(\.js)?['"]/
const CALL = /\buseTestDb\s*\(/
const MARKER = { test: (src: string): boolean => IMPORT.test(src) && CALL.test(src) }

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      walk(p, out)
    } else if (e.name.endsWith('.test.ts') && !e.name.endsWith('.pg.test.ts')) {
      out.push(p)
    }
  }
}

/** Every `*.test.ts` under src/ that imports the with-test-db helper (a mention in a comment does not count), sorted. */
export function listUseTestDbFiles(root: string): string[] {
  const all: string[] = []
  walk(path.join(root, 'src'), all)
  return all
    .filter((f) => MARKER.test(readFileSync(f, 'utf-8')))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort()
}

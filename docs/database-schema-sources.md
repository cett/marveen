# Where the database schema comes from

The schema of `store/claudeclaw.db` is defined by the numbered files in `src/migrations/`, applied by
`applyMigrations()` (`src/db-migrations.ts`). A schema built from those files alone is the baseline a
PostgreSQL port starts from, so DDL that lives anywhere else is listed here with the reason it is still
there. Add a line when you add such DDL; prefer a migration.

## One runner, two processes

The dashboard (`initDatabase()`) and the channel-coordinator (`initIngestDb()`) both run
`applyMigrations()` at start-up and may do so at the same moment on a boot. Each migration runs in an
`IMMEDIATE` transaction that re-checks `schema_version` under the lock, so the process that loses the
race waits (the connection's `busy_timeout`) and then skips what the winner applied.

## DDL outside the migrations

| Where | What | Why it stays |
|---|---|---|
| `src/db-migrations.ts` | `schema_version` | The runner's own bookkeeping table. |
| `src/db/vector.ts` | `vec_memories`, `vec_artifacts` (and its `vec_artifacts_ad` trigger), `vec_workspace_docs` (sqlite-vec `vec0` virtual tables) | They need the sqlite-vec extension, which may not be loaded; created only when it is. A pgvector column replaces them in the PostgreSQL phase. |
| `scripts/hooks/ledger_lib.py` | `conversation_log` and `idx_convlog_agent` | A hook can run before the dashboard has migrated (fresh boot, respawn), and Python cannot call the runner. The migration (`0001_baseline.sql`) is canonical; `conversation-ledger-schema.test.ts` fails when the two drift. |
| `src/intel-store.ts` | `known_facts_registry`, `watchlist`, `decision_log`, `active_focus` | A separate database file (`store/intel.db`, or `INTEL_DB`), not `claudeclaw.db`, opened only by the dashboard on first use. `scripts/intel_db.py` is a client of `/api/intel/*` and no longer opens it. |

Moved into the migrations: `incoming_events` and `poll_offset` (0073, previously created only by the
coordinator, together with a copy of the `agent_messages` DDL that had already drifted once), and the
`agent_messages_delivered_needs_ts` trigger (0074, previously created by `initDatabase()` on every start).

Migration numbers are not required to be contiguous (there is no 0014): the runner orders files by
version and applies everything above the highest recorded one.

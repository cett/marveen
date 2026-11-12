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

Moved into the migrations: `incoming_events` and `poll_offset` (0073, previously created only by the
coordinator, together with a copy of the `agent_messages` DDL that had already drifted once), and the
`agent_messages_delivered_needs_ts` trigger (0074, previously created by `initDatabase()` on every start).

## The PostgreSQL baseline

`src/migrations-pg/0001_baseline.sql` is the PostgreSQL end state of the chain above, cut at `schema_version` 95
(94 files; the cut point is the highest version the SQLite chain had when the port started). Nothing reads it at
runtime: the dashboard stays on SQLite, only the PG test harness builds a database from it. It was generated from
an empty database after `applyMigrations()`, not written by hand, and its header lists the type map and what it
leaves out.

- Types: `TEXT` is `text`, `INTEGER` is `bigint`, `REAL` is `double precision`, `BLOB` is `bytea`; the 18 columns that
  hold 0 or 1 are `smallint` with `CHECK (col IN (0, 1))` (not `boolean`, the code compares them with `= 1`);
  `unixepoch()` is `extract(epoch from now())::bigint`; `AUTOINCREMENT` (and the two rowid-alias keys) is an identity column.
- `kanban_cards` has no rowid in PostgreSQL: its running number is the identity column `seq`. Other rowid users
  (`otel_spans` ordering, the `artifacts` and `workspace_docs` rowid joins) are a later migration, not part of 0001.
- Left out until their phase: the FTS5 tables and their nine sync triggers, the `vec_*` tables (above), the two
  `kanban_cards_due_date_integer_*` triggers (`due_date` is a `bigint`; the application passes an epoch).
- Triggers with a twin keep their name: `agent_messages_delivered_needs_ts`, `artifacts_updated_at`,
  `kanban_cards_status_bumps_updated_at` and the two `homoglyph_*` finders. The two `memories_content_not_blank_*`
  triggers are one `CHECK` on `memories.content`.

`src/__tests__/pg/baseline-parity.pg.test.ts` holds the baseline to the chain, both ways, and the exceptions above are
constants in `src/__tests__/helpers/pg-parity.ts` with their reason. A new SQLite migration after the cut point
therefore fails the `pg-parity` CI job until the PostgreSQL side carries the same change (a new numbered file in
`src/migrations-pg/`, with its exception entry if it is not a plain mirror). Run it locally with a throwaway
server: `MARVEEN_PG_TEST_URL=postgres://... npm run test:pg` (see `docs/db-facade.md`).

Migration numbers are not required to be contiguous (there is no 0014): the runner orders files by
version and applies everything above the highest recorded one.

## The PostgreSQL runner

`src/db-migrations-pg.ts` applies the numbered files of `src/migrations-pg/` (`NNNN_description.sql`; a `.sql` file with
another name is an error, it would never run). The PostgreSQL number is its own line: 0001 is the SQLite baseline 95, 0002 is
SQLite 0096, so a SQLite migration `N` above 95 has its twin at `N - 94`, and a test (`pg-migration-twins.test.ts`, no
server needed) fails a new SQLite migration that has none.

- Each file runs in one transaction together with its `schema_version` row (`version`, `applied_at`, `description`,
  `checksum`, the shape the baseline gives the table). A file that fails leaves nothing behind, the files before it stay.
- A session advisory lock covers the whole run, so two processes that start together apply every file once between them.
  The wait for the lock is bounded (`lockTimeoutMs`, default 60 s): a stuck migrator fails the later start with a message
  that names the lock instead of blocking it for ever.
- An applied file that changed (its checksum), an applied version whose file is gone, and an unapplied file below an
  applied one (merged out of order) are errors. There is no tolerance for "already exists": PostgreSQL has
  `ADD COLUMN IF NOT EXISTS` natively and a file that wants it says so.
- `schema_version` is looked up on the `search_path`, not in `public`.
- Files are compared byte for byte, so `.gitattributes` keeps `*.sql` at LF on every checkout.
- A file runs inside a transaction, so `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM` and `CREATE DATABASE` cannot
  be in one; such a step is run by hand before the file that needs it, and the file says so in a comment.

Nothing in the production start-up calls the runner yet; the PG tests and the adapter work build on it.

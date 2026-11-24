# SQLite to PostgreSQL copy: runbook

The copy tool moves an installation's data from the SQLite file to an empty PostgreSQL database, verifies it, and then
fills the vector side tables. It is an operator command. It is not part of the dashboard boot, and a sub-agent never runs it.

    scripts/migrate-sqlite-to-pg.ts     check, copy
    scripts/with-config.ts              the runner; the embeddings stage goes through it

Provisioning of the roles and URLs is in `docs/pg-provisioning.md`. This page is the order of the operator steps and what each
step reports.

## The order at cutover

1. Freeze the writers (the fleet and the dashboard are stopped), then take a final SQLite archive with `backup.sh` and copy it aside.
2. `check`: every precondition, no write. Stop on any refusal.
3. `copy --dry-run`: the same transaction, rolled back, with the same report. It must be green.
4. `copy`: the transaction that moves the rows.
5. Set `MARVEEN_PG_URL` (and `MARVEEN_PG_MIGRATE_URL` only for the schema step, as in the provisioning page) on the install.
6. Start the dashboard. The boot refuses on any failed step.
7. `embeddings`: the side tables and the artifact vectors. It may run after the dashboard is already serving.

## The environment of each command

- `check` and `copy` connect as the owner. They need `MARVEEN_PG_MIGRATE_URL` (the owner role of the target). The URL is read from
  the secret mount, the environment, or `.env`, and is never printed.
- `embeddings` boots the serving backend as the app role. It needs `MARVEEN_PG_URL`. The embedder is the local Ollama
  (`OLLAMA_URL`, read from the system configuration or the `.env` file, not from the process environment).
- The runner (`with-config.ts`) sends the log lines of `migrate-sqlite-to-pg` to stderr, so the `embeddings` stdout is the JSON
  report only. For `check` and `copy`, set `LOG_TO_STDERR=1` yourself if their stdout is ever mixed with log lines.

```sh
MARVEEN_PG_MIGRATE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts check --sqlite /path/to/claudeclaw.db
MARVEEN_PG_MIGRATE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts copy --sqlite /path/to/claudeclaw.db --dry-run
MARVEEN_PG_MIGRATE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts copy --sqlite /path/to/claudeclaw.db
MARVEEN_PG_URL=...          npx tsx scripts/with-config.ts migrate-sqlite-to-pg embeddings
```

Exit codes: `0` green, `1` refused (the report lists every refusal, or the copy was rolled back), `2` usage or connection error.
The `embeddings` command exits `0` also when the embedder left rows pending.

## What `check` tests

It opens the SQLite file as a snapshot and runs `integrity_check`. It compares the SQLite schema version with the one the
PostgreSQL migration chain was cut from, and the two schemas table by table. It confirms that the connected role is the owner
(not a superuser, not a role that bypasses row-level security), that the PostgreSQL schema is current, that the target is empty
(every table except the seed tables), and that the foreign keys form an order (no cycle). It also finds the orphan rows
(see below) and refuses the row-level policy edges that no foreign key backs and the orphan catalog does not pin.

## Orphan rows

The SQLite side has no foreign keys, so a live database can hold a child row whose parent is gone. PostgreSQL refuses such a
row. The check finds them on the snapshot, before any write, from the foreign keys of the PostgreSQL catalog. A child row
breaks a key when every key column is set and no parent row matches it. A child of an orphan is an orphan too, and so is a
row below a missing parent in the same table.

`check` and `copy` refuse by default. The report has one refusal per foreign key: the constraint, the table, the columns, the
count, and the first rowids (at most 20). It never names a value.

`--orphans skip` leaves the orphan rows, and every row below them, out of the copy. The report's first key is a `notice`
that says how many rows in how many tables were left out, and `plan.orphans` (or `orphans` in the copy report) names them.
The copy is then verified against exactly the rows it wrote. The source is never modified. Use skip for a rehearsal, which
must be repeatable on a live file. Deleting the orphans from the live SQLite is a production data change; at cutover the owner
decides between skip and cleaning the live data (take a backup first).

The policy edges. A row-level policy that reads another table is a dependency the foreign keys may not show: the scan cannot
see a pair that no foreign key backs. Those pairs are pinned in the orphan catalog (`PINNED_POLICY_EDGES` in
`src/db/pg-copy/orphans.ts`): a `parent` entry is scanned like a foreign key, a `lookup` entry is pinned with a reason and is
not scanned. Any other policy edge that no foreign key backs is refused by name (`policy edge not in the orphan catalog:
<child> -> <parent>`), and nothing is written. The baseline has seven pinned edges and no refusal. A foreign key the scan
cannot model (MATCH FULL, a key column with no SQLite column) is refused by name, never passed.

The backstop: when PostgreSQL still refuses a row (SQLSTATE 42501, a row-level policy with no parent row), the copy names the
table and the rowid and says what the code means. The scan is the complete list; the backstop names the first row only.

## What `copy` does

The source is read once, before the first write. Every anomaly of the source is collected first: a value whose SQLite type
the PostgreSQL column cannot take. Any anomaly aborts the run with nothing written. Then every table is written in foreign-key
order inside one transaction, as the owner, in the system context. A table with a self reference (a row whose parent is in
the same table) is written by dependency depth, so a parent is written before its child whatever the rowids; a loop of parents
is refused by name with its rowids.

Before the commit, every copied table is read back inside the same transaction. The row count and a fingerprint of the rows
must equal what was written. A mismatch names the table and rolls the whole run back. The identity sequences are set past the
copied rows right before the commit, because `setval` is not transactional. A failure at any point rolls the transaction back,
so the rows and the sequences are as they were.

Columns the database computes are not written: generated columns, and identity columns that have no SQLite source column. Each
of them is named in the report.

## Triggers during the copy

The user triggers of every copied table are suspended for the write, inside the copy transaction (`ALTER TABLE ... DISABLE
TRIGGER USER`): a trigger that re-derives data from the rows would add rows the source does not hold. The report names them per
table (`suspendedTriggers`). Before the read-back each trigger is put back to its recorded state (origin, replica, always, or
disabled), and the catalog must equal the record, or the run stops and rolls back, naming the trigger. The foreign-key triggers
are internal and stay on. The copy role must own the tables with triggers: `check` refuses a role that does not, by name.

## The reports

Each command prints one JSON document on stdout. The report names tables, columns, rowids, SQLSTATE values and counts. It never
carries a value, and a PostgreSQL error is reported by its constraint name only.

`embeddings` prints the counts per target:

```json
{
  "memory": { "embedded": 0, "skipped": 0, "batches": 0 },
  "workspace_doc": { "embedded": 0, "skipped": 0, "batches": 0 },
  "artifacts": { "embedded": 0, "pending": 0, "skipped": 0, "batches": 0 }
}
```

- `memory`, `workspace_doc`: `embedded` rows got a side row in this run. `skipped` rows have a blob that is not a valid
  768-float embedding; they have no side row, so every run counts them again.
- `artifacts`: `embedded` got a vector in this run. `pending` the embedder did not answer for (Ollama down, or no usable answer);
  `skipped` have no text to embed (blank title and meta).

## The embeddings stage

It fills the `memory_embeddings` and `workspace_doc_embeddings` side tables from the blob columns that the copy carried over, and
re-embeds the artifacts, which have no blob on PostgreSQL, from their title and meta (the same text rule as the live write path).

The stage is idempotent and resumable. Only rows with no side row are read (`NOT EXISTS`), so an interrupted run continues where
the side rows stop, and a second run over a complete target embeds nothing. An unanswered artifact is `pending`, the run
continues and exits `0`; a later run tries those rows again. Until then the semantic artifact search has fewer hits, while the
lexical search is complete from the copy.

## Pitfalls

- The copy needs an empty target. `check` refuses a target that already holds rows; start from a fresh database.
- `embeddings` runs as the app role, the same role the dashboard serves with. A refusal here means the serving role cannot write
  the side tables: fix the grants. The stage stays on the app role.
- `--dry-run` proves the transaction and the report, not the timing. The timings come from a rehearsal on a copy of the data.

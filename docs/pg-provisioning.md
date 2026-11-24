# PostgreSQL provisioning: roles, URLs, and what the scrub does

This page covers the database side of a PostgreSQL install: the three roles, where the connection URLs live, the one-off migration run, and what the process does with the URLs at start. The placeholders below (`<...>`, `example`, `.invalid` hosts) are not real values. Replace them on your install, never in the repository.

## The three roles

Each role has one job. Create them as a superuser, in the order of the provisioning steps below.

| Role | Purpose | Attributes |
|------|---------|------------|
| `marveen_owner` | Owns the objects and runs the migrations. Used only for a migration run. | `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, owns the database |
| `marveen_app` | The serving role of the dashboard and the agents. Its data rights come from the migrations. | `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, owns nothing |
| `marveen_backup` | Read-only, for the dump. | `LOGIN`, `NOSUPERUSER`, `BYPASSRLS`, `SELECT` only |

The serving role must be one that row-level security binds. The boot refuses a serving role that is a superuser, has `BYPASSRLS`, or owns a table in the database, and it refuses this unconditionally. See the `role` step below.

## Provisioning, in order

Replace the placeholder names and passwords before running anything. Steps 1 to 3 run as a superuser. Step 4 is the migration run, with the owner's URL. The backup grants (step 5) come after the migrations.

### 1. Roles

```sql
CREATE ROLE marveen_owner LOGIN PASSWORD '<owner-password>' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE marveen_app LOGIN PASSWORD '<app-password>' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE marveen_backup LOGIN PASSWORD '<backup-password>' NOSUPERUSER BYPASSRLS;
```

The row-level-security migration refuses to run while `marveen_app` does not exist, so the roles come first.

### 2. Database

```sql
CREATE DATABASE <database-name> OWNER marveen_owner;
```

The owner holds the database, so the owner creates every schema object, including the `app` schema. On PostgreSQL 15 and later the `public` schema belongs to the database owner too. The serving role owns nothing.

### 3. Extensions

Connected to the new database, as a superuser:

```sql
CREATE EXTENSION vector;
CREATE EXTENSION unaccent;
```

The `vector` extension needs its files installed on the server first; `docs/local-pgvector.md` has the build steps. Create it as a superuser: pgvector is not a trusted extension (checked in the 0.8.0 control file, which has no `trusted` flag; check the version you install), so the owner cannot be relied on to create it. `unaccent` is trusted from PostgreSQL 13, so the owner could create it too; creating it here keeps both in one place. The migrations run `CREATE EXTENSION IF NOT EXISTS` for both, which does nothing when they are already there.

## Where the URLs live

Two keys matter:

- `MARVEEN_PG_URL`: the serving connection (`marveen_app`). Its presence switches the install from SQLite to PostgreSQL.
- `MARVEEN_PG_MIGRATE_URL`: the owner connection, used only for the schema step. Absent means the boot checks the schema and never changes it.

Each key is resolved through three layers, the first non-empty value wins:

1. The secret mount, `/run/secrets/<KEY>` (the directory is `SECRET_MOUNT_DIR` when set). The password then stays out of `.env`.
2. The process environment.
3. The `.env` file of the install.

On the macOS install there is no `/run/secrets`, so use `.env` or the environment. Keep `.env` at mode `0600`. `scripts/doctor.sh` fails when the `.env` file that holds either URL has a mode wider than `0600`, and warns when that file also holds the owner URL (`MARVEEN_PG_MIGRATE_URL`).

Put the URL in the secret mount or in the `0600` `.env` file, not only in the environment the process was launched with. A child process that Marveen starts (for example a scheduled command task, or the Marveen CLI through `scripts/with-config.ts`) no longer receives the URL from its parent's environment, so the only layers it can still read are the mount and `.env`. An install that keeps the URL only in the launch environment works for the main process and fails for those children.

## What the process does with the URLs

At start, before anything spawns a child, the process moves both keys out of its own environment (`capturePgCredentials()`, first step of `ensureConfigSnapshot()`). It also sets `MARVEEN_PG_CONFIGURED=1`, a marker with no value: a child that cannot read the URL then refuses the SQLite-only entry points instead of opening the stale SQLite file. The values are kept in the process for its resolvers, with the same precedence. What this buys and what it does not:

- It keeps the URLs out of the environment of the child processes: the agent sessions, tmux, and the helpers the process starts do not receive them.
- It does not hide the URLs from a hostile process of the same OS user. The `.env` file is still readable by that user, and the process memory is not protected by a delete. On Linux the initial environment block of a process (`/proc/<pid>/environ`) is also not changed by the delete. This is a child-process and log hygiene measure, not an access boundary.
- No log line contains a URL value. Errors name the key and the boot step, never the value.

## The migration run

The schema step is the only one that changes the database. It runs with the owner connection, once, deliberately (step 4):

1. Set `MARVEEN_PG_MIGRATE_URL` for one start (in `.env` or the environment of that start only).
2. Start the process and check the boot.
3. Remove `MARVEEN_PG_MIGRATE_URL` again and restart, so the serving process runs without the owner credentials.

The migrations grant the serving role its data rights; this page does not repeat them. The row-level-security migration (0009) creates the `app` schema and its helper functions, grants `marveen_app` DML on every table and sequence (with default privileges for the tables and sequences a later migration adds), and revokes the write rights on `schema_version`, which the serving role only reads. Do not grant table or sequence rights to `marveen_app` by hand: a hand grant on `schema_version` undoes that revoke.

Which migrations are in the build decides what the serving role can do. Until the row-level-security migration is in the build you run, `marveen_app` has no table rights, and its first query fails with a permission error.

The boot runs in these steps, in this order. A failure names the step:

- `url`: the URL is set and parses. Only the key name is reported.
- `pool`: the serving pool connects.
- `role`: the serving role is one that row-level security binds (not a superuser, no `BYPASSRLS`, owns no table). Checked before and after the schema step.
- `schema`: with `MARVEEN_PG_MIGRATE_URL` set, the shipped migrations apply through the owner connection (a pool of one, ended before anything is served). Without it, the boot only reads `schema_version` and refuses when a shipped file is not applied.
- `preflight`: the server encoding and the extensions the full-text search relies on. Fails closed; a locale warning is reported, not fatal.
- `caches`: the PostgreSQL backend is switched on and the three synchronous caches are loaded for it.

A refused step ends the process. It never continues on SQLite, because a silent fallback would open the old file instead of the database the install is configured for.

## Moving the data from SQLite

The data itself comes from the SQLite file, through the copy tool (`check`, `copy`, then the `embeddings` stage). The operator steps, their order and the reports are in `docs/pg-copy.md`. The copy runs against an empty target, before `MARVEEN_PG_URL` is set on the install.

## After the migration run

Run this as the owner (or a superuser) once the tables exist. The migrations grant the backup role nothing. `pg_dump` reads the sequence values as well as the tables, so both get `SELECT`:

```sql
GRANT USAGE ON SCHEMA public, app TO marveen_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO marveen_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO marveen_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE marveen_owner IN SCHEMA public GRANT SELECT ON TABLES TO marveen_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE marveen_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO marveen_backup;
```

## Deploy note

The tmux server that runs the agent sessions keeps the environment of whichever process started it. After the first deploy with the URL scrub, restart the tmux server once (restart the agent sessions), or the old server keeps passing the keys to new sessions.

The override `MARVEEN_PG_ALLOW_NEWER_DATABASE=1` lets the process start on a database that is newer than the build (after a rollback). It is read from the process environment only, never from the `.env` file or the secret mount. With it on, nothing is migrated and every boot logs a warning; the state is shown at the admin endpoint `GET /api/admin/pg-runtime-status`. Turn it off again once the build matches the database. The marker `MARVEEN_PG_CONFIGURED` is inherited the same way: if you later switch the install back to SQLite (the URL removed), a long-lived tmux server still passes the marker, so new sessions refuse to open SQLite until the tmux server is restarted.

## Open items

- The owner URL stays in the module memory for the life of the process after the schema step. It is the same exposure as before the scrub. A later change can drop it after the step.

<!-- throwaway CI cell: a docs-only change, pg-parity must be skipped and test green -->

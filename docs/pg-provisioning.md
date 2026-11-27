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

## The weekly restore drill

`scripts/pg-restore-drill.sh` (see F03, "The weekly restore drill on PostgreSQL") restores the newest nightly dump into a
throwaway database next to the live one. It needs a role and a template the provisioning above does not create. The script checks each
one before it creates anything and says which is missing. Run as a superuser:

```sql
-- 1. the drill's own role: it creates and drops the throwaway database and nothing else. It is NOT marveen_owner, owns
--    nothing of the live database and holds no grant and no membership that reaches it
CREATE ROLE marveen_drill LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD '<drill-password>';

-- 2. a template that only holds the two extensions: pgvector is not a trusted extension, so the drill role cannot create it
--    in the throwaway database; the restore skips the dump's EXTENSION entries and the clone already has them
CREATE DATABASE marveen_drill_tpl;
\c marveen_drill_tpl
CREATE EXTENSION vector;
CREATE EXTENSION unaccent;
\c postgres
ALTER DATABASE marveen_drill_tpl IS_TEMPLATE true;
```

3. The drill role's password file, outside the repository, owner-only: `~/.pgpass-marveen-drill`, mode `0600`, one line
   `127.0.0.1:5432:*:marveen_drill:<drill-password>` (the database field is `*` because the throwaway name changes every run).
   The backup role's file (`~/.pgpass-marveen-backup`) is the one the nightly dump already uses, with ONE requirement: its
   database field (3rd field) must be `*`, not `marveen`. The script connects as the backup role to the throwaway database,
   whose name changes every run, and libpq knows only a complete `*` there (no `marveen_drill_*`); the nightly dump works
   with `*` as well. The script tries the template database with the backup role before it creates anything and names this
   fix when it fails. Check the field without reading the password: `awk -F: '{print $3}' ~/.pgpass-marveen-backup`.
The dump is restored with `--no-owner --no-acl` (no owner, grant or default privilege is replayed, so no other role has to
exist, and the drill role needs no membership in `marveen_owner`: the dump's `ALTER DEFAULT PRIVILEGES FOR ROLE
marveen_owner` entries are not replayed). Row-level security and policies are restored with the schema. Both sides are counted
through the read-only backup role (BYPASSRLS): the drill role owns the restored tables, which are under forced row-level
security, and would count 0. Because `--no-acl` leaves the backup role without a grant on the copy, the script runs one
`GRANT USAGE ON SCHEMA public` / `GRANT SELECT ON ALL TABLES IN SCHEMA public` to the backup role, as the drill role, right
after the restore. The script refuses to run when the drill role is a superuser, has BYPASSRLS, or can read any table of the
live database.

Client version: the `pg_restore` the script uses must be the SAME major as the server (a 17 client sets
`transaction_timeout`, which a 16 server rejects, so every restore fails), and the dump's header ("Dumped by pg_dump version")
must not name a newer major than the server. The script checks both before it creates anything and names the fix; it looks in
`PG_DRILL_BIN_DIR` (default `/opt/homebrew/opt/postgresql@16/bin`) first, then on `PATH`.

Orphans: the EXIT trap drops the throwaway database on every ending but SIGKILL (the command task's `timeoutMs` may send
it). So each run starts by dropping databases named `marveen_drill_<14 digit UTC stamp>_<pid>` that the drill role OWNS and
whose stamp is older than 24 hours; the summary line says how many. A younger one, and one of another owner, is never
touched. By hand, as a superuser: `SELECT datname FROM pg_database WHERE datname LIKE 'marveen\_drill\_2%'`.
The drop is a plain `DROP DATABASE` first (PostgreSQL cancels an autovacuum worker the restore woke up), `WITH (FORCE)`
only as the second try: the drill role is not a superuser and may not terminate an autovacuum worker.

Security note: no existing role is widened. `marveen_owner` keeps its attributes; the new role has one extra attribute
(CREATEDB) and, on the live database, only what PUBLIC gives every role (CONNECT), which reads nothing.

## The channel coordinator

The channel coordinator (`dist/channel-coordinator.js`, its own launchd unit) is a backfill poller for inbound Telegram updates: it polls only while the native channel is down. It runs on the same backend as the dashboard.

- **The URL** is resolved exactly as the dashboard resolves it (the three layers above). The installer does not copy it anywhere: the state directory `.env` of the coordinator holds the bot token and nothing else, and the launchd plist never holds a URL. Put the URL in the secret mount or the `0600` `.env` of the install and the unit finds it.
- **The role** is the application role (`MARVEEN_PG_URL`), the same as the dashboard, so row-level security applies. The coordinator has no tenant context: every database call it makes runs as one named system job (`channel-coordinator-ingest`).
- **It never migrates.** On PostgreSQL the coordinator boots with the migration URL switched off, even when `MARVEEN_PG_MIGRATE_URL` (the owner role) is in the `.env`: it only checks that the schema is current. A coordinator that starts before the dashboard on a database that is behind refuses to boot with the step named in the log, and creates no table. The unit's `KeepAlive` starts it again, so it comes up once the dashboard has migrated.
- **On SQLite** it opens the same file with the same pragmas and the same migration runner as the dashboard, and nothing else (no WAL truncate, no startup passes).
- **Who is let in.** The coordinator drops every update whose sender is not in the access list of the native Telegram plugin (`access.json` in `TELEGRAM_STATE_DIR`, default `~/.claude/channels/telegram`: `allowFrom` for a DM, `groups` for a group, `dmPolicy: "disabled"` lets nothing in). The list is read on every batch, so a change applies without a restart, and it is the one list: there is no second one in the database. A dropped update writes nothing, is handed off to nobody, and is not answered: there is NO pairing reply, and the coordinator never writes the file. A missing, unreadable or malformed list lets nothing through (one log line per failure), and it is no verdict on the sender: the update is not settled, so the poll offset does not move, the batch waits with the loop's backoff like at a failed insert (no poison limit applies), and the message is asked for again and passes once the list is readable (a plugin that rewrites the file, or a half-written JSON, delays the owner's message and does not lose it). A sender that is simply not on a readable list is different: the update is settled (not asked for again). The stored events of a sender that is not listed are closed as failed; with an unreadable list they stay pending. EVERY message of a configured group passes, from every member the group's list allows, WITHOUT the mention check the plugin applies (the coordinator cannot judge a mention from a stored row): configure only groups whose every message the main agent may see, the body stays untrusted. If the plugin runs with another `TELEGRAM_STATE_DIR`, give the coordinator unit the same variable.
- **Tenants.** Every row the coordinator writes belongs to the default tenant: all coordinator rows belong to the default tenant; another tenant's user on the same bot is not handled by this process. `incoming_events` and `poll_offset` have no tenant column; the handoff row in `agent_messages` carries the default tenant as an explicit value.
- **Cutover and rollback.** The unit can stay loaded across the cutover. Check on the rehearsal copy: the unit starts on PostgreSQL and stays up; an injected update is written to `incoming_events` and handed off; the poll offset advances and survives a restart; the otel gauge counts the event. Rolling back to SQLite is the same binary on the SQLite file, there is no schema difference.

## Deploy note

The tmux server that runs the agent sessions keeps the environment of whichever process started it. After the first deploy with the URL scrub, restart the tmux server once (restart the agent sessions), or the old server keeps passing the keys to new sessions.

The override `MARVEEN_PG_ALLOW_NEWER_DATABASE=1` lets the process start on a database that is newer than the build (after a rollback). It is read from the process environment only, never from the `.env` file or the secret mount. With it on, nothing is migrated and every boot logs a warning; the state is shown at the admin endpoint `GET /api/admin/pg-runtime-status`. Turn it off again once the build matches the database. The marker `MARVEEN_PG_CONFIGURED` is inherited the same way: if you later switch the install back to SQLite (the URL removed), a long-lived tmux server still passes the marker, so new sessions refuse to open SQLite until the tmux server is restarted.

## Open items

- The owner URL stays in the module memory for the life of the process after the schema step. It is the same exposure as before the scrub. A later change can drop it after the step.

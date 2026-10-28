# The async db facade (`dbx`)

The PostgreSQL preparation turns the db layer asynchronous one module at a time. This page says
how to write a database operation while that is going on. The facade lives in `src/db/facade.ts`, its lock in
`src/db/tx-lock.ts`, the caller context in `src/db/context.ts`, the config cache in `src/db/config-cache.ts`.

## The rules

1. **A db operation is a function in `src/db/`.** Code outside `src/db/` does not write SQL and does not call
   `getDb()` / `db.prepare()`; the ratchets (`scripts/db-outside-sql-ratchet.py`, `scripts/sqlite-dialect-ratchet.py`)
   fail the build when those counts grow.
2. **A module that is on the facade uses `dbx`, not the raw `db` handle.** `dbx` has `get`, `all`, `run`, `exec`
   and `tx`; every one returns a Promise. A function that moves onto it returns a Promise, and every caller
   `await`s it. The lint (`no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await`)
   fails the build for production `src/` when a caller forgets.
3. **Parameters** are positional `?` values (any number of arguments) or one object for `@name` placeholders.
4. **Do not count on atomicity between two calls.** Two `await`ed calls can have another caller's statement
   between them. What must be atomic is either ONE statement or one `dbx.tx(...)`. A read-modify-write over two
   calls is only safe when something else guarantees a single caller (write down which, as the agent-state
   pilot does). That guarantee covers the context restart gate's own sweep only: `PUT /api/agent-state` can
   write the same key (`gate_run_state`) between the gate's read and its write.
5. **A transaction body holds the connection lock.** Inside `dbx.tx(async (tx) => { ... })` use `tx.get/all/run/exec`
   and nothing else that waits: no LLM call, HTTP request, file I/O or `sleep`. Every other statement on the
   connection queues behind the open transaction. A transaction open longer than `DB_TX_WARN_MS` (default 2000,
   0 turns it off) is logged with the line that opened it. A transaction inside a transaction is a `SAVEPOINT`;
   `dbx.tx(fn, { mode: 'immediate' })` is `BEGIN IMMEDIATE`; the `mode` of a nested transaction is ignored,
   because a savepoint joins the transaction that is already open.
6. **Run inside a context.** `runAs.system('job-name', fn)`, `runAs.tenant(tenantId, fn)` or
   `runAs.agent(agentId, tenantId, fn)` around the work that touches the database. For now a call without one
   is counted and warned about (`getDbContextStats()`), not refused. A timer created before `runAs` does not
   inherit it: a tick that touches the database opens its own `runAs`.
7. **No database write per request for a counter.** The facade has no write buffer yet; a per-request counter
   waits for one (batched flushes) instead of adding a write to the request path.

## Configuration reads stay synchronous

`getSystemConfig` / `listSystemConfig` (and so `getEffectiveSettingValue`), `model_profile_map` and
`agent_settings` (`getAgentSetting`, `listAgentSettingsByKey`) read a write-through cache that `initDatabase()`
fills, because their callers (runners, route guards, startup reconciliation) sit on a synchronous path and must
not become asynchronous. The pattern, for any table that moves onto the facade this way:

- **Reads are synchronous and come from memory.** No statement is prepared on a cache hit.
- **Writes are asynchronous and go to the database FIRST, then the cache.** The cache is refreshed from the row
  the database now holds (not from the value the caller passed), so a clamped or defaulted column is cached as stored.
- **A writer that bypasses the facade reloads the cache.** Code that writes the table on the raw connection (a
  transaction that touches several tables, `deleteTenant` for `agent_settings`) calls the module's reload
  function after the commit (`reloadSystemConfigCache()`, `reloadAgentSettingsCache()`). The test that proves it
  reads through the cache, after priming it with a facade write: a read of the table cannot see a stale cache.
- **The cache lives in the dashboard process.** A value changed by hand in the database (manual SQL, another
  process) is not seen until the dashboard restarts or the reload function runs.

## Boot code stays synchronous

`initDatabase()` is synchronous for now and cannot await. The one-time importers and the migrators it runs
use the synchronous twins of a migrated module, kept on the raw connection. The twins are:

| Twin | Module |
|---|---|
| `getAgentStateSync`, `setAgentStateSync`, `importAgentStateFromFile` | `db/agent-state.ts` |
| `migrateCostBudgetsFromFile` | `db/cost-budgets.ts` |
| `migrateVaultBindingsFromFile` | `db/vault-bindings.ts` |
| `importAgentSettingsFromFile` (takes the synchronous `resolveAgentOwningTenantIdSync` callback) | `db/agent-settings.ts` |
| `resolveAgentOwningTenantIdSync` (the same two lookups as `resolveAgentOwningTenantId` on the raw handle, in the same order: keep the two in step) | `db/agents.ts`, called from `db/index.ts` |
| `enrollDashboardApiTokenSync` (the file token is enrolled before `startWebServer` listens; it cannot await) | `db/api-tokens.ts`, called from `web/token-bootstrap.ts` |
| `migrateScheduleLastRunFromFile` (the one-time import of the last-run file; it stays on the raw handle when the module goes async) | `db/tasks.ts` |

The table lists the twins only, not every boot-time migrator: `migrateFederationConfigFromFile` belongs to a module
that is still entirely synchronous, so it is not a twin of anything yet.

The rule: **a twin is called from the boot chain (`src/db/index.ts`, or the bootstrap helper that `startWebServer` calls) and from nowhere else.** A caller anywhere else would run on
the raw connection beside the facade's transaction lock, which is what the facade exists to prevent, and which
has no equivalent on PostgreSQL. `src/__tests__/db-boot-sync-twins.test.ts` enforces it for every twin at once:
`BOOT_SYNC_TWINS` maps a twin to the only files that may mention it (its own module and its boot caller), and the
test fails when any other production file does, or when a listed file no longer does (a stale row would
permit a future caller). A twin carries a `// @boot-sync-twin` line above its declaration and the test checks the table against those tags, so a deleted row fails too. A new twin is a tag and one more row in that table, not a new guard test. A later step makes
`initDatabase()` asynchronous and the twins go away.

## Read-then-write is one transaction

A select followed by a write on the same rows (select-then-delete, read the state then update it, delete-then-insert
that must replace a list) is `dbx.tx` with every statement on the `tx` handle. Two `await`ed facade calls leave a
window for another caller's statement. `src/__tests__/db-read-then-write-transactions.test.ts` is the table of the
functions that must have this shape: it counts the transactions opened and the statements run on `dbx` itself
during the call (`helpers/single-transaction.ts`), and expects exactly one transaction and no outside statement. It sees the `dbx` facade only: a raw
`getDb().prepare(...)` in such a function is covered by the `db-outside-sql` ratchet, not by this test.
A new read-then-write function is one more case in that table.

## The fleet import is two-phase

`importFleet` (`web/fleet-transfer.ts`) writes files and database rows, and a failing import must leave nothing half
applied. The rule: **files are staged before the transaction and renamed after it; every database write is in one
transaction; the vault step and the `.env` mirror come last.**

1. Everything pure is decided first (the cost budgets and the federation document are validated, the `.env` identity
   is picked, the skill rows are listed).
2. Each file is written as `<path>.import-new`; a file it would replace is copied to `<path>.import-bak`. No final
   path changes (only directories that did not exist are created, and removed again on a failure).
3. ONE `dbx.tx` holds all the database writes: the settings (autonomy, model profiles, auto-restart, desired agents,
   model fallback, terminal input, federation, cost budgets, egress allowlist), the skill rows (an error there fails
   the import) and the per-table rows. The body holds no file I/O, network or timer. `seedSkillIfAbsent()` still
   writes on the raw connection; on the one SQLite connection that statement runs inside the open transaction and
   rolls back with it (see the raw-writer limit below), which `fleet-transfer-two-phase.test.ts` pins.
4. After the commit: the staged files are renamed into place, the model-profile, agent-settings and system-config
   caches are re-read (and the federation cache dropped), then the vault step (its two files and the bindings), then
   the `.env` mirror.

A failure before the commit removes the staged files and the backups and re-reads the caches (a write-through cache
shows a new value inside the transaction and keeps it after the rollback); every final path is as it was. A failure
after the commit cannot roll the database back: each renamed file is restored from its `.import-bak` copy, and that
backup is removed once the restored file was read again and equals it; the error says that the database changes
remain. A file whose restore fails (or reads back different) keeps its backup, is named in the message, and its
backup is what makes the next import refuse to stage that file (`StaleBackupError`); the backups of the other files
are gone, so a cleanly restored failure blocks nothing. A successful import removes every backup. The remaining risk
is that second case: a process killed between the commit and the last rename leaves the database applied and some
files not.

The staged files have fixed names, so one apply runs at a time in the process: a second apply (a double click on the
import button) is refused at once with `ImportInProgressError`, answered as 409 `conflict`; it does not wait and
touches nothing. The flag is released when the first apply ends, whether it succeeded or failed. A dry run writes
nothing and is not limited. Two dashboard processes on one store are not covered.

An import also refuses to start staging a file whose `.import-bak` already exists (`StaleBackupError`, 409
`conflict`): that backup was left by an import that could not restore the file, it may be the only copy of the
previous content, and the backup of the new import would overwrite it. Restore it onto its file or remove it, then
import again. A `.import-new` left behind by a crashed process is harmless (the next import overwrites it) but is not
cleaned up on its own; a cleanup at start-up is a separate card.

## The authentication path fails closed

A function that decides who a caller is (`resolveAuth`, the device-key and API-token lookups) answers *deny* when
it cannot read the database: the rejection reaches the request handler (a 500), and it is never turned into a
"no such token, carry on" that would reach the legacy file-token fallback and grant admin. Nothing on this path
catches a database error and continues. When such a function becomes asynchronous, every call site `await`s it:
a Promise that is not awaited is truthy, so a forgotten `await` would let every request through. The lint
(`no-floating-promises`, `no-misused-promises`) and the tests in `auth-gate.test.ts` (token lane, revoke on the very next request) and
`auth-path-failure-modes.test.ts` (device-key lane, the SSE `?token=` lane, a single failed statement, the attempt cap, the `await` in
`web.ts`) are the guard.

Revocation of an API token is immediate because its lookup has no cache: each request reads `api_tokens`. A device
key keeps an in-process cache (`auth-device-keys.ts`). A revoke made through the dashboard process clears the row
and the cache entry together, and a lookup that read the row across that revoke does not put it back in the cache
(`removalEpoch`; `auth-device-keys.test.ts` pins it). A revoke made by ANOTHER process (`dashboard-user
security:reset`) cannot reach the cache and is noticed by the next debounced `last_used` write: within
`LAST_USED_DEBOUNCE_SEC` (60 s).

The browser session lane follows the same rules (`web/auth-sessions.ts`, `db/sessions.ts`). A table error in the
session lookup, the user lookup or the `last_seen` write rejects (no fall-through to another lane). A revoke deletes
the table row FIRST and the cache entry after it, and a revoke counter (`revokeEpoch`) keeps a lookup that was
reading the same row from putting a revoked session back in the cache; `auth-session-lane.test.ts` pins both
orders of the overlap for all three revoke paths. A session revoked by ANOTHER process is noticed at the next
debounced `last_seen` write (`touchAuthSessionLastSeen` returns the changed-row count, so it must be awaited).

## Transactions with a rule of their own

**The system-config document (read-modify-write).** A change to one stored document (the federation config is the
example, `mutateFederationConfig`) reads the cached document, changes it and writes it back inside ONE `dbx.tx`:
two overlapping requests that each read the old document and each wrote a changed copy would lose one change. The
write goes to the database first and the cache is refreshed from the row afterwards (see "Configuration reads stay
synchronous").

**The vault approvals.** The body of `consumeApproval`, `claimApproval` and `createApprovalOnce` holds database
calls on the `tx` handle and pure policy, nothing else (no `fetch`, no file, no `setTimeout`, no model call): the
transaction lock is held for as long as the body runs. The guarded `UPDATE ... WHERE` is the line that decides; the
lock only keeps other FACADE callers out of the body, so the WHERE is the only protection against another
connection or process (`approval-vault-statements.test.ts` breaks one condition per row, and runs a second writer
between the deciding read and the write). The transaction modes are those of the synchronous transactions that
were replaced: `consumeApproval` and `claimApproval` run in the default (deferred) mode, `createApprovalOnce` in
`immediate` mode (an earlier plan said "all immediate"; that was a mistake, and the modes are pinned). The refusal
journal and the `created_deduplicated` event are best-effort and run AFTER the transaction, with the write awaited
INSIDE the `try`: a started-but-not-awaited write rejects outside the `catch` as an unhandled rejection.

**Schedules and the skill files (sequences that span `await`s).** A schedule is read, merged, written to the database
and mirrored into `SKILL.md` and `task-config.json` as one step, and the old synchronous db made that step
uninterruptible. With the async facade every `await` lets a second caller start, so two edits of one schedule would
both read the old row (the later write drops the earlier change) and the mirror files could hold the older content.
`src/web/keyed-serializer.ts` restores the guarantee inside the process: a per-key FIFO on the `AsyncLock` of the
transaction layer, re-entrant through an `AsyncLocalStorage` (code that already holds a key takes it again without
waiting for itself), and a failing caller rejects for itself only. It is used in four places:
`writeScheduledTask` (key = schedule name, through `src/web/schedule-lock.ts`); the activate, edit (PUT), toggle and
delete routes of `src/web/routes/schedules.ts`, which hold the same key for their whole decision (read, hash and
review check, write, mirror), so an edit that arrives between the hash check of an activation and the activation
itself waits; the create and reconcile of the tenant starter task (key = starter task name, so a double click ends in
one create and one reconcile); and the five writers and the two removers of `src/web/skill-regen.ts`, which share one queue
(`serialized`), so a bulk regen that read its rows before a dashboard edit cannot write them after the single regen of
that edit, and a single regen that read a row cannot write the file back after the delete removed it. `activateSchedule` and `patchSchedule` write only the columns they own and take "the row exists" from the
match count of their own `UPDATE`: two overlapping patches of different columns both survive, a delete in between gives
`null` (the routes answer 404) and nothing is re-created. The edit and toggle routes re-read the row under the lock and
never create one: before, a schedule deleted between the check and the write came back as a fresh row.

## What holds an `await`

Three kinds of guard exist, and a statement about an `await` must say which one holds it:

- **A test that fails without it.** Behavioural, for example a garbage session cookie getting 401 over HTTP, or a
  revoke refused on the very next request.
- **The lint** (`no-floating-promises`, `no-misused-promises`, `await-thenable`). It fails the build for
  production code, but only where the Promise is visibly dropped or used as a value.
- **A source pin** (a test that reads the file and expects `await` on every call line). It is the last resort where
  the synchronous SQLite facade cannot show the difference: the logout `revokeSession` and the password-change
  `revokeAllForUser` route calls are held this way and by the lint, and a behavioural test belongs to the step that
  moves the facade onto a pooled backend.

Held by the lint alone, or by a pin alone, and worth knowing: the `try/catch` of a timer body (the hourly session
sweep, the approval timeout sweeper, the other sweepers): the lint allows `void sweep()`, and without the
`catch` a failed sweep is only logged by the process-level unhandled rejection handler. A journal call turned into
`void journalConsumeRefusal(...)` is held by the source pin only; it is harmless (the helper never rejects, only the
order of the journal row against the answer would change).

**A measurement, not a rule.** `@typescript-eslint/no-unnecessary-condition` would flag `await x() !== null`
written without the `await` (a Promise is never `null`). Run over the production `src/` with
`tools/eslint/eslint.measure.mjs`, it gives 298 findings in 85 files (plus 4 messages about disable comments with no effect): 130 `??` on a non-nullish left side, 106
optional chains on a non-nullish value, and 60 about a value that is always truthy, always falsy or a comparison
without overlap (and 2 of other shapes). None of the 60 is on a line with an `await`, an `async` function or a Promise, so it would not
have found a missing `await` the four async rules miss, and the defensive `??` and `?.` of the codebase would
drown it. It is NOT enabled; the four async rules stay the lint guard.

## Known limits

These are behaviours of the code today, listed so that nobody mistakes them for a promise:

- **The fleet import cannot undo a failure after its commit.** Every database write is in the one transaction and a
  failure before it leaves nothing applied (see "The fleet import is two-phase"). What remains: a process killed
  between the commit and the last rename leaves the database applied and some files not; a file that could not be
  restored after a failed finish stays as it is and is named in the error (its `.import-bak` copy is kept); and a
  `.import-new` left by a crash is overwritten by the next import, not cleaned up on its own. A `.import-bak` left
  behind is never overwritten: the next import that would stage the same file is refused (409 `conflict`) until the
  backup is restored onto its file or removed by hand. The one-apply-at-a-time flag lives in the process memory and
  assumes a single dashboard process: PostgreSQL phase 2 with several processes (or a background worker running an
  import) needs a database-level lock instead (an advisory lock or a lock row), because the flag does not see another
  process.
- **A failed fleet import can leave empty parent directories.** The staging step tracks only the deepest directory it
  created (`trackedMkdir`), so after a failed import the missing parent directories above it may remain, empty. In
  practice this is harmless: `~/.claude` always exists, and an empty directory changes no behaviour.
- **The federation disable branches ignore the result of `setFederationEnabledPreservingFile`.** A `false` return
  (the file could not be written) is not looked at, so the switch can read as off while the gate stays on.
- **Creating a dashboard user twice in parallel** ends with a UNIQUE error answered as 500 for the second request
  (it should be 409). Only the first user becomes the global admin (one statement), so this is a status code issue.
- **The PUT import route** answers 500 when a concurrent request deletes a row between the import's read and its
  write (an old window that was kept, not widened by the facade).
- **The audit entries of a single kanban card create and update are written after the commit.** `createKanbanCard`
  and `updateKanbanCard` commit the card rows first and write the `agent_audit_log` entry afterwards, delayed at most
  by the facade lock wait. The entry is best effort: a crash between the commit and the write, or a failing audit
  insert, loses the entry and never undoes the card change. The multi-row writes do not have this window: a card
  delete, the auto-breakdown subtasks and an idea promotion write their entries inside the transaction, each in its
  own savepoint, so a failing audit is logged and rolls back only itself and the card change stays. A delete writes an
  entry only when a row was deleted, and two overlapping deletes of one card produce one entry (the second finds no
  card).
- **The scheduler's "waiting" mark applies to any non-archived kanban card, not only to `in_progress`.**
  `markScheduledTaskKanbanWaiting` moves the first non-archived card whose title matches a timed-out task to `waiting`,
  as it did before the facade, whatever its status (a `done` card included). The move is a compare-and-set on the
  status it read, so a card that left that status meanwhile is left alone. Restricting the mark to `in_progress` is a
  behaviour change, kept out of the facade wave on purpose (candidate for PostgreSQL phase 2).
- **The token shadow counter's daily row count is decided on a fresh read of `dayState.known` after each key lookup.**
  `recordTokenShadow` awaits the key lookup, so k overlapping first records of the same new shape all arrive with
  `known` empty; counting after the `await` without a second look made every one of them count a row while the table got
  one, and the daily row cap (`MAX_ROWS_PER_DAY`) moved earlier by k - 1 (measured: 40 overlaps, 3961 real rows instead
  of 4000). The second look removes that, and `token-shadow.test.ts` pins it with 40 same-tick records. What remains: two
  overlapping first records of a new UTC day each rebuild the state from the table, and the later one discards what the
  first added, so the count can lag by the rows in flight until the next rebuild (the cap then moves later, by the
  number of such rows). Under SQLite the `await`s are microtasks and separate HTTP handlers run in separate macrotasks,
  so this is not reachable through HTTP today; on PostgreSQL it is.
- **`startAgentProcess` checks `isAgentRunning` before an `await`.** The check in `agent-process-spawn.ts` comes before
  `await recoverActivePlanFromHandoff` and the `kill-session` plus spawn after it, so two overlapping starts of one agent
  both pass the check and the second `kill-session` kills the first one's new session. Under SQLite the `await` is only a
  microtask (not measured, read from the source); on PostgreSQL it is a real window. Not covered by a test.
- **One facade `await` is held by the type checker alone.** `resolveTenantDeliveryChats`
  (`src/web/schedule-runner.ts`) awaits `listChannelBindings`; dropping that `await` fails `tsc` (a Promise has no
  `length`) but no test. The `await`s of the channel-bindings routes (`src/web/routes/admin-b2b.ts`) are pinned by
  `admin-channel-bindings.test.ts`, which asserts the response bodies.
- **A `sweepExpiredSessions` or other timer body without its `catch`** is not noticed by a test (see above).
- **The schedule lock and the skill-file queue are per process.** They keep the callers of ONE dashboard process
  apart; another process writing the same schedule (a second dashboard, a PostgreSQL pool with several workers) is
  covered by the database statements only (the single `UPDATE` of `activateSchedule` and `patchSchedule`), not by
  the mirror files, whose last writer wins. PostgreSQL phase 2 with several processes needs a database-level lock
  (an advisory lock keyed by the schedule name) in `withScheduleLock`.
- **The tick timers of the schedule runner are callback boundaries, held by the lint alone.** The tick
  (`setInterval(() => { void runCheck() })`), the retry timers (`void resubmit(...)`) and the command-task starts
  (`void runCommandTask(...)`) are fire-and-forget by design: the lint allows `void`, and no test notices a different
  shape. `runCheck` resets its re-entrancy flag in a `finally`; an error that nothing inside a tick catches ends as an
  unhandled rejection, as a synchronous throw in the (already asynchronous) tick did before. The skip ledger row
  (`appendTaskRun(...).catch(log)`) and every statement whose result is not used are held by `no-floating-promises`,
  not by a test.
- **The skill-usage dedup is one `INSERT ... WHERE NOT EXISTS`, which holds on SQLite only.** `logSkillUsage`
  (`src/db/audit.ts`) skips a repeat of the same (agent, skill, session, source) inside 60 s. As a SELECT followed by
  an INSERT two concurrent calls both wrote a row; as one statement the SQLite connection runs it as a unit, so
  exactly one wins (`audit-async-writers.test.ts`, five concurrent calls). The dedup is a time window, not a unique
  key: on PostgreSQL under READ COMMITTED two such statements can still both insert, so phase 2 needs an advisory lock
  keyed by (agent, skill, session) or a bucketed unique key.
- **The RBAC decision row is written before a refusal goes out, and the write is best effort.** `runRbacGate`
  (`src/web/rbac-shadow-log.ts`) takes the decision (`checkPermission`), awaits the `rbac_shadow_log` row and only
  then lets `applyRbacGate` write the 401/403, so a refusal is recorded before the client sees it (the old hook order;
  `applyRbacGate`'s hooks are synchronous and cannot await a write). A failed insert or prune is logged and never
  changes the decision. The cost is that every refused or observed request waits for one insert.
- **The blackboard lock is in-process.** The read-judge-write sequences on one agent's blackboard row (the message
  assignment `assign: true`, the `complete: true` hook, the scheduled run's active post and its done write, the
  `POST /api/blackboard` route) run under `withBlackboardLock(agentId, ...)` (`src/web/blackboard-lock.ts`), one after
  the other per agent. `upsertBlackboard` itself is one immediate transaction (read, upsert by `agent_id`, history
  entry), so two overlapped posts of one agent end in one row, the later call wins, and both are in the history; the
  sweep `markBlackboardStale` updates only the row it read (`status` and `updated_at` unchanged), so a post made
  between its read and its write is kept, with a one-second resolution of `updated_at` backed by the status
  condition. PostgreSQL phase 2 with several processes needs the judgement inside the statement or a row lock: the
  lock does not see another process. `PATCH` of a row by id (`routes/blackboard.ts`, `updateBlackboardRowById`) is
  still read, merge, write without either guard (last write wins); it was not on the W3-6 list.
- **`getAgentConversationThreads` reads its peers one query at a time.** The peer list, the counts and the last
  message of each peer are separate reads, so a message created while it runs can show in the count of one peer and
  not in the last-message field of that peer. The synchronous version could not be interleaved. It is a dashboard
  sidebar; a snapshot read (one transaction, or one statement per peer with a window function) waits for phase 2.
- **`BEGIN IMMEDIATE` in `upsertBlackboard` is not observable on one connection.** The mode takes the write lock
  at the start so that a second connection (another process) cannot make the read stale; with the single dashboard
  connection the transaction lock already orders the callers, so no test can tell the modes apart.
- **`logToolCall` is held by the types and the lint only.** It writes through `upsertOtelSpan`
  (`src/db/observability.ts`), which still uses the raw connection inside an `async` function, so a driver-level test
  (slow or failing `dbx.run`) cannot reach it until that module moves onto `dbx`.

## Tests

```ts
import { useTestDb } from './helpers/with-test-db.js'

const { dbx } = useTestDb()

it('writes a row', async () => {
  await dbx.run('INSERT INTO ...', ...)
})
```

`useTestDb()` resets the lock, the context carrier and the config cache and opens a fresh `:memory:` database
before each test. The PostgreSQL step runs the same call against a template database, so the tests do not change.
The tests that open the database by hand are moved over module by module.

## What the facade does not cover

The migration runner (`db-migrations.ts`) and `config.ts` use their own connections and do not go through the
lock. The channel coordinator is a separate process. Neither is serialized by `dbx.tx`.

A write on the RAW connection (`db.prepare(...).run()`, `db.transaction(...)()`) is not serialized by the lock
either. On the one SQLite connection it does not wait: while a `dbx.tx` is open (between its awaits) such a write
runs INSIDE that transaction, a raw transaction becomes a savepoint of it, and both are rolled back with it.
`src/__tests__/approval-vault-statements.test.ts` pins this. Until the tenant delete (`deleteTenant` in
`db/observability.ts`, which still writes `approvals` on the raw connection) moves onto `dbx`, treat the approval
transactions (`consumeApproval`, `claimApproval`, `createApprovalOnce`) as exposed to it; on PostgreSQL (several
connections) the raw writer would no longer be inside the transaction at all.

The approval transactions keep the modes of the synchronous transactions they replaced: `consumeApproval` and
`claimApproval` the default (deferred) one, `createApprovalOnce` `immediate`. Their guarded `UPDATE ... WHERE` is
the line that decides when another connection or process writes between the read and the write; the lock only
keeps other facade callers out of the body.

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
| `importAgentSettingsFromFile` (takes a synchronous `resolveAgentOwningTenantId` callback) | `db/agent-settings.ts` |
| `enrollDashboardApiTokenSync` (the file token is enrolled before `startWebServer` listens; it cannot await) | `db/api-tokens.ts`, called from `web/token-bootstrap.ts` |

The table lists the twins only, not every boot-time migrator: `migrateFederationConfigFromFile` and
`migrateScheduleLastRunFromFile` belong to modules that are still entirely synchronous, so they are not twins of
anything yet.

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

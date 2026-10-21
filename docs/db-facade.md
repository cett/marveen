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

`getSystemConfig` / `listSystemConfig` (and so `getEffectiveSettingValue`) read a write-through cache that
`initDatabase()` fills. Writes go to the database first, then the cache. Code that writes the table directly
calls `reloadSystemConfigCache()`. The cache lives in the dashboard process: a value changed by hand in the
database (manual SQL, another process) is not seen until the dashboard restarts or `reloadSystemConfigCache()` runs.

## Boot code stays synchronous

`initDatabase()` is synchronous for now and cannot await. The one-time importers it runs use the
synchronous twins of a migrated module (`getAgentStateSync`, `setAgentStateSync`), which only `src/db/index.ts`
may call. A later step makes `initDatabase()` asynchronous and the twins go away.

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

// The single entry point of a test that needs the database.
//
//   const { dbx } = useTestDb()
//   it('...', async () => { await dbx.run(...) })
//
// Before each test: every piece of state the db layer keeps outside the connection is reset (the transaction
// lock and its scope, the db context carrier, the backend behind `dbx`) and `initDatabase(':memory:')` hands out a
// fresh database; that call also loads the system_config cache for it. After each test the connection is closed.
//
// PostgreSQL mode (MARVEEN_TEST_DB=pg, with MARVEEN_PG_TEST_URL, `npm run test:pg-modules`): the same call, the tests
// do not change. Before each test a database is cloned from the baseline template (pg-test-db.ts), `dbx` is pointed
// at the PG adapter on a pool of that database (useDbxBackend), and after the test the pool is closed and the
// database dropped. One clone per test, not one per file with a TRUNCATE: the measured cost of the two is the same
// (about 0.2 s a test on the development machine; see the PR notes) and a clone cannot leak a row or a sequence value.
//
// What PG mode does NOT have: the SQLite handle (`db` stays unset), so a test or a module that still reads the raw
// handle fails loudly instead of quietly running against a second database. The three synchronous caches
// (system_config, model_profile_map, agent_settings) ARE filled, through the facade (load*Async), right after the
// switch and outside any transaction; they belong to the backend epoch (cache-owner.ts), so the next test never reads
// this test's cache. (A run with the SQLite database opened beside the PG one was tried and dropped: it hides the
// leaks PG mode exists to find, and the rows a test writes through the raw handle are invisible to the reads that go
// to PG, so it separated nothing.)
//
// The tests that open the database by hand (288 files) are moved over module by module with the waves.

import { beforeEach, afterEach, expect } from 'vitest'
import { initDatabase, db, dbx, type Dbx } from '../../db.js'
import { useDbxBackend } from '../../db/facade.js'
import { createPgDbx } from '../../db/pg/index.js'
import { loadSystemConfigCacheAsync } from '../../db/config-cache.js'
import { loadModelProfileMapCacheAsync } from '../../db/model-profile-map-cache.js'
import { loadAgentSettingsCacheAsync } from '../../db/agent-settings-cache.js'
import { resetTxLockState } from '../../db/tx-lock.js'
import { noteDbCall, resetDbContextForTest } from '../../db/context.js'
import type { PgTestDb } from './pg-test-db.js'
import { testPgRole, withDefaultSystemContext } from './pg-app-role.js'
import { PG_TEST_APP_ROLE } from './pg-app-role.js'

export interface UseTestDbOptions {
  /** A database file instead of `:memory:` (a test of file permissions or of a second connection). Ignored in PG mode. */
  path?: string
}

export const TEST_DB_ENV = 'MARVEEN_TEST_DB'

/** `pg` when MARVEEN_TEST_DB=pg, `sqlite` when it is unset or `sqlite`; any other value is an error (a typo must not run SQLite quietly). */
export function testDbMode(env: NodeJS.ProcessEnv = process.env): 'sqlite' | 'pg' {
  const v = env[TEST_DB_ENV]
  if (v === undefined || v === '' || v === 'sqlite') return 'sqlite'
  if (v === 'pg') return 'pg'
  throw new Error(`${TEST_DB_ENV} must be "pg" or "sqlite" (or unset), got "${v}"`)
}

/** The error of the PG adapter's strict transaction rule (db/pg/dbx.ts): an ambient `dbx` call inside a transaction body. */
export const STRICT_TX_ERROR = /use the tx handle inside a transaction body/

/**
 * Runs a positive control: a test that makes an AMBIENT `dbx` call inside a `dbx.tx` body on purpose, to prove that the
 * spy of the test sees such a call. SQLite lets the call join the transaction through the async context; PostgreSQL
 * refuses it with the strict-tx error (the call would run on another connection, outside the transaction), so there
 * the control expects the refusal. The spy records the call before the guard throws, so what the test asserts on stays.
 */
export async function ambientInTx(run: () => Promise<unknown>): Promise<void> {
  if (testDbMode() === 'pg') await expect(run()).rejects.toThrow(STRICT_TX_ERROR)
  else await run()
}

/**
 * Reset the db layer state that lives outside the connection. This includes the backend behind `dbx`: a test that
 * pointed it at another implementation must not leave it there for the next test (a context leak between tests).
 */
export function resetDbTestState(): void {
  useDbxBackend(null)
  resetTxLockState()
  resetDbContextForTest()
}

export function useTestDb(opts: UseTestDbOptions = {}): { dbx: Dbx } {
  if (testDbMode() === 'pg') return usePgTestDb()
  beforeEach(() => {
    resetDbTestState()
    initDatabase(opts.path ?? ':memory:')
  })
  afterEach(() => {
    try { db?.close() } catch { /* already closed by the test */ }
    resetDbTestState()
  })
  return { dbx }
}

// The admin (superuser) view of the same test database, for seeding rows the app role could not write.
let seedAdminDbx: Dbx | undefined

/**
 * The Dbx a test SEEDS a row through when the row is one the policies would refuse to the context of the call, on
 * purpose: an orphan child (a log row whose parent never existed, to test a retention sweep or a search on the log
 * alone). In the app-role run (pg-app-role.ts) it is the superuser's view, which no policy applies to; everywhere else
 * it is the test's own `dbx`, unchanged. The code under test still runs as the app role; only the fixture bypasses.
 */
export function seedDbx(dbx: Dbx): Dbx {
  return seedAdminDbx && testPgRole() === 'app' ? seedAdminDbx : dbx
}

// The pool a test's own DDL runs on in the app-role run (a trigger, a function, ALTER TABLE: the app role owns nothing).
let ownerDdlPool: { query(sql: string): Promise<unknown> } | undefined

/**
 * DDL a test runs for its own setup (a failure-injection trigger, a dropped column). In the app-role run (see
 * pg-app-role.ts) it goes through the OWNER pool, because the app role cannot create or alter anything; the trigger or
 * the change then applies to the app role's statements all the same. Everywhere else it is `dbx.exec`, as before.
 */
export async function testDdl(dbx: Dbx, sql: string, opts: { tables?: string[] } = {}): Promise<void> {
  if (ownerDdlPool && testPgRole() === 'app') {
    // a table the owner creates carries no right for the app role: `tables` names the ones the test then reads and writes
    const grants = (opts.tables ?? []).map((t) => `; GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${PG_TEST_APP_ROLE}`).join('')
    // the statement is not a facade call here, but the one it replaces was: a test that counts the calls (db-context) sees the same number
    noteDbCall()
    await ownerDdlPool.query(sql + grants)
  } else await dbx.exec(sql)
}

function usePgTestDb(): { dbx: Dbx } {
  let current: PgTestDb | undefined
  beforeEach(async () => {
    resetDbTestState()
    // loaded here, not at the top: the default suite imports this helper too and must not pull the PG harness in
    const { createPgTestDb } = await import('./pg-test-db.js')
    current = await createPgTestDb()
    // MARVEEN_TEST_PG_ROLE=app: the same tests as the role the dashboard runs as (pg-app-role.ts), the admin pool otherwise
    useDbxBackend(createPgDbx(testPgRole() === 'app' ? withDefaultSystemContext(current.appPool) : current.pool), 'pg')
    ownerDdlPool = current.ownerPool
    seedAdminDbx = createPgDbx(current.pool) as unknown as Dbx
    // outside any transaction, after the clone: the three synchronous caches are filled for THIS backend (the epoch
    // the switch above just started), the counterpart of the cache loads at the end of initDatabase()
    await loadSystemConfigCacheAsync()
    await loadModelProfileMapCacheAsync()
    await loadAgentSettingsCacheAsync()
    // the loads above are db calls without a db context, and the context counters are something tests assert on
    // (db-context-route): SQLite's initDatabase() loads its caches without dbx, so the test starts with zero there
    resetDbContextForTest()
  })
  afterEach(async () => {
    resetDbTestState()
    try { db?.close() } catch { /* never opened, or closed by the test */ }
    const toClose = current
    current = undefined
    ownerDdlPool = undefined
    seedAdminDbx = undefined
    await toClose?.close()
  })
  return { dbx }
}

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
// handle fails loudly instead of quietly running against a second database, and the synchronous caches
// (system_config, model_profile_map, agent_settings) are not loaded: they are filled from the SQLite handle only
// (src/db/*-cache.ts), and an async fill is not part of this helper. (A run with the SQLite database opened beside the
// PG one was tried and dropped: it hides the leaks PG mode exists to find, and the rows a test writes through the raw
// handle are invisible to the reads that go to PG, so it separated nothing.)
//
// The tests that open the database by hand (288 files) are moved over module by module with the waves.

import { beforeEach, afterEach } from 'vitest'
import { initDatabase, db, dbx, type Dbx } from '../../db.js'
import { useDbxBackend } from '../../db/facade.js'
import { createPgDbx } from '../../db/pg/index.js'
import { resetTxLockState } from '../../db/tx-lock.js'
import { resetDbContextForTest } from '../../db/context.js'
import type { PgTestDb } from './pg-test-db.js'

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

function usePgTestDb(): { dbx: Dbx } {
  let current: PgTestDb | undefined
  beforeEach(async () => {
    resetDbTestState()
    // loaded here, not at the top: the default suite imports this helper too and must not pull the PG harness in
    const { createPgTestDb } = await import('./pg-test-db.js')
    current = await createPgTestDb()
    useDbxBackend(createPgDbx(current.pool), 'pg')
  })
  afterEach(async () => {
    resetDbTestState()
    try { db?.close() } catch { /* never opened, or closed by the test */ }
    const toClose = current
    current = undefined
    await toClose?.close()
  })
  return { dbx }
}

// The single entry point of a test that needs the database.
//
//   const { dbx } = useTestDb()
//   it('...', async () => { await dbx.run(...) })
//
// Before each test: every piece of state the db layer keeps outside the connection is reset (the transaction
// lock and its scope, the db context carrier and its counters) and `initDatabase(':memory:')` hands out a fresh
// database; that call also loads the system_config cache for it. After each test the connection is closed.
//
// The PostgreSQL step runs the same call against a template database (switched by an environment variable), so
// the tests that use it do not change. The tests that open the database by hand (218 of them) are moved over
// module by module with the waves.

import { beforeEach, afterEach } from 'vitest'
import { initDatabase, db, dbx, type Dbx } from '../../db.js'
import { resetTxLockState } from '../../db/tx-lock.js'
import { resetDbContextForTest } from '../../db/context.js'

export interface UseTestDbOptions {
  /** A database file instead of `:memory:` (a test of file permissions or of a second connection). */
  path?: string
}

/** Reset the db layer state that lives outside the connection. */
export function resetDbTestState(): void {
  resetTxLockState()
  resetDbContextForTest()
}

export function useTestDb(opts: UseTestDbOptions = {}): { dbx: Dbx } {
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

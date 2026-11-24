// The SQLite-only importers and sync twins (the initDatabase() chain of db/index.ts, and their helpers) are not part of
// the PostgreSQL boot: initDatabaseAsync() seeds the same data through the async variants where they exist. A sync
// twin reached on the PostgreSQL backend must not touch the PostgreSQL handle (it has no SQLite one) and must not throw
// a TypeError: it does nothing and logs one line naming the step.
import { dbxDialect } from './facade.js'
import { logger } from '../logger.js'

/** True when the SQLite-only step must be skipped (the PostgreSQL backend); logs one line naming the step. */
export function skipOnPg(step: string): boolean {
  if (dbxDialect() !== 'pg') return false
  logger.info({ step }, 'skipped on PostgreSQL')
  return true
}

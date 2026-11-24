// The file-retirement steps (retire*: rename a store JSON file to .deprecated once its importer ran) are SQLite-era.
// Their importers run on SQLite only, so on PostgreSQL the file's rows were never imported on that path: renaming the
// file would retire data nobody moved. On PostgreSQL every retire step does nothing and leaves the file in place.
import { dbxDialect } from './facade.js'
import { logger } from '../logger.js'

/** True when the retire step must be skipped (the PostgreSQL backend); logs one line naming the step. */
export function skipRetireOnPg(step: string): boolean {
  if (dbxDialect() !== 'pg') return false
  logger.info({ step }, 'retire step skipped on PostgreSQL: the source file stays in place')
  return true
}

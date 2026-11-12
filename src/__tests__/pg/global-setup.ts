// vitest.pg.config.ts globalSetup: the PG tests need a server, so a missing or unreachable one fails the run here
// with a clear message instead of failing every test (or, worse, skipping them).
import pg from 'pg'
import { PG_TEST_URL_ENV, pgTestUrl } from '../helpers/pg-test-db.js'

export default async function setup(): Promise<void> {
  const url = pgTestUrl()
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
  } catch (err) {
    throw new Error(`${PG_TEST_URL_ENV} is set but the server does not answer: ${(err as Error).message}`, { cause: err })
  } finally {
    await client.end().catch(() => undefined)
  }
}

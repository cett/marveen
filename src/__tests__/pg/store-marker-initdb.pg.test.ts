// The real process boot (initDatabaseAsync, the dashboard's entry) is the one caller that writes the PostgreSQL install
// marker (P-E, opt-in). Dropping the option at that call site turns this cell red. The store is a throwaway directory.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk, mkdirSync: mkd } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: jn } = require('node:path') as typeof import('node:path')
  const root = mk(jn(td(), 'store-marker-initdb-'))
  const store = jn(root, 'store')
  mkd(store, { recursive: true })
  return { STORE: store }
})

vi.mock('../../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../paths.js')>()), STORE_DIR: STORE }))

import { closePgBackend } from '../../db/pg-boot.js'
import { initDatabaseAsync } from '../../db/index.js'
import { resetPgCredentialCaptureForTests } from '../../db/pg/url.js'
import { PG_MARKER_FILE } from '../../db/pg/store-marker.js'

const made: PgTestDb[] = []
const markerPath = join(STORE, PG_MARKER_FILE)
const savedEnv = { url: process.env['MARVEEN_PG_URL'], migrate: process.env['MARVEEN_PG_MIGRATE_URL'] }

beforeEach(() => {
  rmSync(markerPath, { force: true })
})
afterEach(async () => {
  await closePgBackend()
  resetPgCredentialCaptureForTests()
  if (savedEnv.url === undefined) delete process.env['MARVEEN_PG_URL']
  else process.env['MARVEEN_PG_URL'] = savedEnv.url
  if (savedEnv.migrate === undefined) delete process.env['MARVEEN_PG_MIGRATE_URL']
  else process.env['MARVEEN_PG_MIGRATE_URL'] = savedEnv.migrate
})
afterAll(async () => {
  for (const d of made) await d.close()
  rmSync(join(STORE, '..'), { recursive: true, force: true })
})

async function db(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  return d
}

describe('the real process boot writes the install marker', () => {
  it('initDatabaseAsync on a PostgreSQL configuration writes the marker into the store dir', async () => {
    const d = await db()
    process.env['MARVEEN_PG_URL'] = d.appUrl
    process.env['MARVEEN_PG_MIGRATE_URL'] = ''
    expect(await initDatabaseAsync()).toBe('pg')
    expect(readFileSync(markerPath, 'utf-8')).toMatch(/^pg-installed \d{4}-\d{2}-\d{2}T/)
  })
})

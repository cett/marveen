// The shutdown marker on PostgreSQL: the SIGTERM flush of the marker (registerShutdownMarker) writes the clean_shutdown row
// in the boot-marker system job, so row-level security accepts it. Cell (app role, no extra context): boot the marker,
// run the SIGTERM flushes, assert the clean_shutdown row carries this boot's boot_id, then assert the next boot reads
// prev_shutdown = clean. Mutant: the flush without the system job (plain setSystemConfig) is refused by row-level
// security (42501), the row is missing, and the cell is red. Neutral fixtures only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'pg-shutdown-marker-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { initDatabaseAsync, closePgBackend, getSystemConfig } from '../../db.js'
import { startBootMarker, CLEAN_SHUTDOWN_KEY } from '../../web/boot-marker.js'
import { runSigtermFlushes } from '../../web/sigterm-flush.js'

let pgDb: PgTestDb

beforeAll(async () => {
  pgDb = await createPgTestDb()
  process.env.MARVEEN_PG_URL = pgDb.appUrl
  expect(await initDatabaseAsync()).toBe('pg')
}, 60000)

afterAll(async () => {
  await closePgBackend().catch(() => undefined)
  delete process.env.MARVEEN_PG_URL
  await pgDb?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('the shutdown marker lands on PostgreSQL', () => {
  it('the SIGTERM flush writes the clean_shutdown row with this boot id, and the next boot reads it as clean', async () => {
    const first = await startBootMarker()
    expect(first, 'the boot is recorded').not.toBeNull()
    await runSigtermFlushes(5000)
    const row = await runAs.system('shutdown-marker-readback', async () => getSystemConfig(CLEAN_SHUTDOWN_KEY))
    expect(row, 'clean_shutdown row written by the flush').toBeDefined()
    expect(JSON.parse(row!.value).boot_id).toBe(first!.boot_id)
    const next = await startBootMarker()
    expect(next!.prev_shutdown).toBe('clean')
  }, 60000)
})

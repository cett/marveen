// initDatabaseAsync on the PostgreSQL path runs the two importers of the sync chain that still matter there (phase 3, 6c-2):
// the cost-budgets file and the claude-plans seed. The cell boots through initDatabaseAsync on a throwaway database, with
// fixtures in a temp store, and reads the rows back. Mutant: the two awaits removed from initDatabaseAsync (db/index.ts): the
// budget and the plan are missing.
//
// Runs through `npm run test:pg` / the pg-parity CI job against a throwaway server (MARVEEN_PG_TEST_URL). Privacy: neutral
// fixtures only (boot-budget, boot-plan, config-boot).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'carl-boot-importers-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import { listCostBudgets } from '../../db/cost-budgets.js'
import { listClaudePlanRows } from '../../db/claude-plans.js'

let db: PgTestDb

beforeAll(async () => {
  writeFileSync(join(STORE, 'costops-config.json'), JSON.stringify({
    version: 1, currency: 'HUF', budgets: [{ id: 'boot-budget', amount: 500 }],
  }))
  writeFileSync(join(STORE, 'claude-plans.json'), JSON.stringify([
    { id: 'boot-plan', label: 'Boot plan', configDir: 'config-boot', planType: 'personal', channelsAllowed: false },
  ]))
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
}, 60000)

afterAll(async () => {
  await closePgBackend()
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('initDatabaseAsync on PostgreSQL runs the importers that still matter there', () => {
  it('the boot imports the cost budget of the file and seeds the plan of claude-plans.json into the database', async () => {
    // NO context around the boot call, as in src/main.ts: the importers open their own system context (job boot-importers).
    // Under row-level security an empty context is refused the cost budget insert, so a wrapper here would hide that gap.
    expect(await initDatabaseAsync()).toBe('pg')
    await runAs.system('boot-sequence', async () => {
      expect((await listCostBudgets('default')).map((b) => b.id)).toContain('boot-budget')
      expect((await listClaudePlanRows()).map((p) => p.id)).toContain('boot-plan')
    })
  })
})

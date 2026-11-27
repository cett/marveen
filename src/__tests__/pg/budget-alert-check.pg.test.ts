// The budget-alert check on PostgreSQL as the APPLICATION role (scripts/budget-alert-check.ts -> src/costops/budget-alert-job.ts).
//
// The check is fail-open (costops/budget-alert.ts): an empty context shows zero budgets and zero token rows, so a run without
// the system job exits 0 and alerts nothing. The cells show both sides:
//
//   - under the job (green): the warning is found, notified once, and the run logs one line with what it saw;
//   - without it (red, what a removed wrapper gives): zero budgets, no notification, no error;
//   - the agent and the tenant scopes each read their own slice, the raw table AND the monthly rollup;
//   - the entry point ends its pool (the app role holds no connection after the run), and a boot that cannot connect is a
//     thrown PgBootError naming the step, with no URL in it (the script turns it into a non-zero exit);
//   - the boot never migrates, even with a migrate URL configured (the coordinator boot, not initDatabaseAsync).
//
// Neutral fixtures only (agent-a, agent-b, tenant-t1, the default tenant). The store is a throwaway directory.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPgTestDb, PG_TEST_APP_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'

const { TMP_STORE, notify } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync: mkdirp } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require('node:path')
  const root = mkdtempSync(joinPath(tmpdir(), 'budget-alert-pg-'))
  const store = joinPath(root, 'store')
  mkdirp(store, { recursive: true })
  return { TMP_STORE: store, notify: vi.fn().mockResolvedValue(undefined) }
})

vi.mock('../../paths.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../paths.js')>()), STORE_DIR: TMP_STORE }))
vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../config.js')>()), STORE_DIR: TMP_STORE }))
vi.mock('../../notify.js', () => ({ notifyChannel: notify }))
vi.mock('../../db-migrations-pg.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db-migrations-pg.js')>()
  return { ...real, applyPgMigrations: vi.fn(real.applyPgMigrations) }
})

import { bootPgBackend, closePgBackend, PgBootError } from '../../db/pg-boot.js'
import { dbx } from '../../db/facade.js'
import { runAs } from '../../db/context.js'
import { runBudgetAlertCheck } from '../../costops/budget-alert-runner.js'
import { runBudgetAlertJob } from '../../costops/budget-alert-job.js'
import { applyPgMigrations } from '../../db-migrations-pg.js'
import { resetPgCredentialCaptureForTests } from '../../db/pg/url.js'
import { logger } from '../../logger.js'

// 2026-09-10 12:00 local: comfortably inside the month the rollup rows are keyed by ('2026-09').
const NOW_MS = new Date('2026-09-10T12:00:00').getTime()
const NOW_SEC = Math.floor(NOW_MS / 1000)
const HOUR_AGO = NOW_SEC - 3600
const STATE_PATH = join(TMP_STORE, 'budget-alert-state.json')

const made: PgTestDb[] = []
let seq = 0

afterAll(async () => { for (const d of made) await d.close() })
beforeEach(() => {
  rmSync(STATE_PATH, { force: true })
  mkdirSync(TMP_STORE, { recursive: true })
  vi.clearAllMocks()
})
afterEach(async () => {
  await closePgBackend()
  vi.unstubAllEnvs()
  resetPgCredentialCaptureForTests()
})

/** A database with the second tenant, the app URL in the environment (what the job boots on). */
async function seededDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  await db.pool.query("INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-t1', 'Tenant 1', 1) ON CONFLICT DO NOTHING")
  vi.stubEnv('MARVEEN_PG_URL', db.appUrl)
  return db
}

interface BudgetFixture { id: string; scope: 'global' | 'agent' | 'tenant'; scope_ref?: string; amount: number }

/** A default-tenant budget row, written as the owner of the data (the admin oracle bypasses the policies). */
async function addBudget(db: PgTestDb, b: BudgetFixture): Promise<void> {
  await db.pool.query(
    `INSERT INTO cost_budgets (id, name, scope, scope_ref, amount, currency, warning_threshold, hard_threshold, block_on_hard, tenant_id, created_at, updated_at)
     VALUES ($1, $1, $2, $3, $4, 'HUF', 0.8, 1.0, 0, 'default', 1, 1)`,
    [b.id, b.scope, b.scope_ref ?? null, b.amount],
  )
}

/** A raw token_usage row, one hour before the evaluation clock: the current month. */
async function addRaw(db: PgTestDb, tenant: string, agent: string, input: number, output: number): Promise<void> {
  seq += 1
  await db.pool.query(
    'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tenant_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [agent, `session-${seq}`, HOUR_AGO, input, output, tenant],
  )
}

/** A rolled-up token_usage_monthly row for the evaluation month. */
async function addRollup(db: PgTestDb, tenant: string, agent: string, input: number, output: number): Promise<void> {
  await db.pool.query(
    "INSERT INTO token_usage_monthly (month, agent, model, input_tokens, output_tokens, tenant_id) VALUES ('2026-09', $1, '', $2, $3, $4)",
    [agent, input, output, tenant],
  )
}

const countRows = async (db: PgTestDb, table: string): Promise<number> =>
  Number((await db.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n)

describe('under the system job (the wrapper of the job): the check sees the data and says what it saw', () => {
  it('the warning is found on the application role, notified once, and the run logs one line with the level of each budget', async () => {
    const db = await seededDb()
    await addBudget(db, { id: 'global-monthly', scope: 'global', amount: 1000 })
    await addRaw(db, 'default', 'agent-a', 600, 0)
    await addRaw(db, 'tenant-t1', 'agent-b', 300, 0)
    const info = vi.spyOn(logger, 'info')

    const out = await runBudgetAlertJob(NOW_MS)

    expect(out.backend).toBe('pg')
    expect(out.statuses).toHaveLength(1)
    expect(out.statuses[0]).toMatchObject({ level: 'warning', spent: 900 })
    expect(notify).toHaveBeenCalledTimes(1)
    const line = info.mock.calls.find((c) => c[1] === 'budget-alert-check: evaluated')
    // the exact shape, not a subset: the line carries the backend, the count, and per budget only the id, the level and the
    // rounded ratio. A spend, an amount or any other key added to it fails here (no spend and no amount in the line)
    expect(line?.[0]).toEqual({ backend: 'pg', budgets: 1, results: [{ id: 'global-monthly', level: 'warning', ratio: 0.9 }] })
  })
})

describe('without the system job the same data reads as nothing (what a removed wrapper gives)', () => {
  it('zero budgets, no alert and no error, while the rows exist (fail-open, so the blind run looks healthy)', async () => {
    const db = await seededDb()
    await addBudget(db, { id: 'global-monthly', scope: 'global', amount: 1000 })
    await addRaw(db, 'default', 'agent-a', 600, 0)
    await bootPgBackend({ migrateUrl: '' })

    expect(await runBudgetAlertCheck(NOW_MS)).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    expect(await countRows(db, 'cost_budgets')).toBe(1)
    expect(await runAs.tenant('tenant-t1', () => dbx.all('SELECT id FROM cost_budgets'))).toEqual([])
  })
})

describe('the agent and the tenant scopes read their own slice, the raw table and the monthly rollup together', () => {
  it('agent-a: 100 rolled up + 200 raw = 300 (ok); tenant-t1: 500 rolled up + 400 raw = 900 (warning)', async () => {
    const db = await seededDb()
    await addBudget(db, { id: 'agent-a-monthly', scope: 'agent', scope_ref: 'agent-a', amount: 1000 })
    await addBudget(db, { id: 'tenant-t1-monthly', scope: 'tenant', scope_ref: 'tenant-t1', amount: 1000 })
    await addRollup(db, 'default', 'agent-a', 100, 0)
    await addRaw(db, 'default', 'agent-a', 200, 0)
    await addRollup(db, 'tenant-t1', 'agent-b', 0, 500)
    await addRaw(db, 'tenant-t1', 'agent-b', 400, 0)
    await addRaw(db, 'default', 'agent-z', 9999, 0) // another agent of the default tenant: in neither budget

    const out = await runBudgetAlertJob(NOW_MS)
    const byId = Object.fromEntries(out.statuses.map((s) => [s.budget.id, s]))

    expect(byId['agent-a-monthly']).toMatchObject({ spent: 300, level: 'ok' })
    expect(byId['tenant-t1-monthly']).toMatchObject({ spent: 900, level: 'warning' })
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

/** The connections the app role holds on the test database right now. */
async function appConnections(db: PgTestDb): Promise<number> {
  return Number((await db.pool.query(
    'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE usename = $1 AND datname = current_database()',
    [PG_TEST_APP_ROLE],
  )).rows[0].n)
}

/** Waits (up to 3 s) until the app role is back to `before` connections: a closed pool leaves at once, an open one stays for the idle timeout. */
async function settlesTo(db: PgTestDb, before: number): Promise<number> {
  const deadline = Date.now() + 3000
  let now = await appConnections(db)
  while (now > before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    now = await appConnections(db)
  }
  return now
}

describe('the entry point: the pool is ended, and a boot failure is a named, URL-free error', () => {
  it('the app role holds no connection after the run (a job that keeps its pool would hold one for the idle timeout)', async () => {
    const db = await seededDb()
    await addBudget(db, { id: 'global-monthly', scope: 'global', amount: 1000 })
    await addRaw(db, 'default', 'agent-a', 600, 0)
    const before = await appConnections(db)

    await runBudgetAlertJob(NOW_MS)

    expect(await settlesTo(db, before)).toBe(before)
  })

  it('a job that fails AFTER the boot still ends its pool (the close is on the error path too, not only on success)', async () => {
    const db = await seededDb()
    await addBudget(db, { id: 'global-monthly', scope: 'global', amount: 1000 })
    await addRaw(db, 'default', 'agent-a', 600, 0)
    // the budgets read succeeds, the spend read that follows it fails: the boot is complete when the job throws
    await db.pool.query('ALTER TABLE token_usage_monthly RENAME TO token_usage_monthly_gone')
    const before = await appConnections(db)

    const err = await runBudgetAlertJob(NOW_MS).then(() => undefined, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PgBootError)
    expect(String((err as Error).message)).toMatch(/token_usage_monthly/)
    expect(await settlesTo(db, before)).toBe(before)
  })

  it('a connection that cannot be made refuses at the pool step, and the error holds no password', async () => {
    vi.stubEnv('MARVEEN_PG_URL', 'postgres://marveen_app:not-a-real-secret@127.0.0.1:1/none?connect_timeout=2')

    const err = await runBudgetAlertJob(NOW_MS).then(() => undefined, (e: unknown) => e)

    expect(err).toBeInstanceOf(PgBootError)
    expect((err as PgBootError).step).toBe('pool')
    expect(String((err as Error).message)).not.toContain('not-a-real-secret')
  })
})

describe('the boot is the coordinator boot: it never migrates', () => {
  it('a migrate URL in the environment is not used by the job (no applyPgMigrations call)', async () => {
    const db = await seededDb()
    await addBudget(db, { id: 'global-monthly', scope: 'global', amount: 1000 })
    await addRaw(db, 'default', 'agent-a', 600, 0)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', db.ownerUrl)

    const out = await runBudgetAlertJob(NOW_MS)

    expect(out.backend).toBe('pg')
    expect(vi.mocked(applyPgMigrations)).not.toHaveBeenCalled()
  })
})

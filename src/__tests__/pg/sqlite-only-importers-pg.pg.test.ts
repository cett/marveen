// The SQLite-only importers and sync twins on PostgreSQL:
// fourteen sync functions of the initDatabase() chain do nothing on the PostgreSQL backend and log one line
// ("skipped on PostgreSQL", with the step name). Each returns its neutral value (0, false, undefined, void);
// resolveAgentOwningTenantIdSync refuses loudly instead of returning a default tenant. The cell boots through
// initDatabaseAsync on a throwaway database, calls each function, and checks the return and the log line.
// Mutant: skipOnPg returns false (the sync bodies run on PostgreSQL) -> they reach the missing SQLite handle, TypeError, red.
// Neutral fixtures only (agent-a, plan-a, kanban_audit_last_audit_at).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'pg-sqlite-only-pg-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import { logger } from '../../logger.js'
import { setSystemConfigSync, migrateConfigOverridesToSystemConfig, migrateGroup5StateFromFiles } from '../../db/system-config.js'
import { migrateScheduleLastRunFromFile } from '../../db/tasks.js'
import { getAgentStateSync, setAgentStateSync, importAgentStateFromFile } from '../../db/agent-state.js'
import { resolveAgentOwningTenantIdSync } from '../../db/agents.js'
import { importAgentSettingsFromFile } from '../../db/agent-settings.js'
import { migrateCostBudgetsFromFile } from '../../db/cost-budgets.js'
import { migrateFederationConfigFromFile } from '../../db/federation.js'
import { migrateVaultBindingsFromFile } from '../../db/vault-bindings.js'
import { replaceClaudePlanRowsSync, activatePlanForAgentSync } from '../../db/claude-plans.js'

let db: PgTestDb

beforeAll(async () => {
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
  expect(await initDatabaseAsync()).toBe('pg')
}, 60000)

afterAll(async () => {
  await closePgBackend()
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('the SQLite-only importers and sync twins do nothing on PostgreSQL', () => {
  it('the void twins return without a write and log one line each', () => {
    const info = vi.spyOn(logger, 'info')
    setSystemConfigSync('fixture-key', 'fixture-value')
    setAgentStateSync('agent-a', 'kanban_audit_last_audit_at', 1)
    replaceClaudePlanRowsSync([])
    activatePlanForAgentSync('agent-a', 'plan-a', 'manual')
    const steps = info.mock.calls.filter((c) => c[1] === 'skipped on PostgreSQL').map((c) => (c[0] as { step: string }).step)
    expect(steps).toEqual(expect.arrayContaining([
      'setSystemConfigSync', 'setAgentStateSync', 'replaceClaudePlanRowsSync', 'activatePlanForAgentSync',
    ]))
    info.mockRestore()
  })

  it('the number and boolean importers return 0 or false', () => {
    expect(migrateConfigOverridesToSystemConfig()).toBe(0)
    expect(migrateGroup5StateFromFiles()).toBe(0)
    expect(migrateScheduleLastRunFromFile({})).toBe(0)
    expect(importAgentSettingsFromFile('context_guard', {}, () => 'default')).toBe(0)
    expect(importAgentStateFromFile('kanban_audit_last_audit_at', {})).toBe(0)
    expect(migrateCostBudgetsFromFile()).toBe(0)
    expect(migrateVaultBindingsFromFile()).toBe(0)
    expect(migrateFederationConfigFromFile()).toBe(false)
  })

  it('the state reader gives undefined (no row), never a TypeError', () => {
    expect(getAgentStateSync('agent-a', 'kanban_audit_last_audit_at')).toBeUndefined()
  })

  it('the tenant resolver refuses loudly on PostgreSQL instead of returning a default tenant', () => {
    expect(() => resolveAgentOwningTenantIdSync('agent-a')).toThrow(/SQLite-only/)
  })
})

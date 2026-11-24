// The eight file-retirement steps on PostgreSQL: on the
// PostgreSQL backend a retire step does nothing. Its importer is SQLite-only, so the file's rows were never imported on
// that path, and the rename would retire data nobody moved. Cell: boot through initDatabaseAsync on a throwaway database
// with every source file present in a temp store, call each retire step, assert the source file is still there and no
// .deprecated sibling was made. Mutant: skipRetireOnPg returns false (the rename runs on PostgreSQL) -> every row is red.
// Neutral fixtures only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'pg-retire-pg-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import {
  initDatabaseAsync,
  closePgBackend,
  retireConfigOverridesFile,
  retireScheduleStateFiles,
  retireAgentSettingsFiles,
  retireAgentStateFiles,
  retireKanbanAuditStateFile,
  retireVaultBindingsFile,
  retireFederationConfigFile,
  retireGroup5StateFiles,
} from '../../db.js'

let db: PgTestDb

// step name -> the retire function, and the source files it would rename (fixtures are neutral JSON objects)
const STEPS: Array<{ step: string; run: () => void; files: string[] }> = [
  { step: 'C1 retireConfigOverridesFile', run: retireConfigOverridesFile, files: ['config-overrides.json'] },
  { step: 'C2 retireScheduleStateFiles', run: retireScheduleStateFiles, files: ['schedule-last-run.json', 'schedule-tick-state.json'] },
  { step: 'C3 retireAgentSettingsFiles', run: retireAgentSettingsFiles, files: ['context-guard.json', 'auto-restart.json', 'context-restart-gate.json'] },
  { step: 'C4 retireAgentStateFiles', run: retireAgentStateFiles, files: ['context-restart-gate-state.json'] },
  { step: 'C5 retireKanbanAuditStateFile', run: retireKanbanAuditStateFile, files: ['kanban-audit-state.json'] },
  { step: 'C6 retireVaultBindingsFile', run: retireVaultBindingsFile, files: ['vault-bindings.json'] },
  { step: 'C7 retireFederationConfigFile', run: retireFederationConfigFile, files: ['federation.json'] },
  { step: 'C8 retireGroup5StateFiles', run: retireGroup5StateFiles, files: ['model-fallback.json', 'agents-desired.json', 'terminal-input.json'] },
]

beforeAll(async () => {
  for (const { files } of STEPS) {
    for (const f of files) writeFileSync(join(STORE, f), JSON.stringify({ fixture: 'retire-pg' }))
  }
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

describe('the retire steps do nothing on PostgreSQL', () => {
  for (const { step, run, files } of STEPS) {
    it(`${step}: every source file stays in place, no .deprecated sibling is made`, () => {
      run()
      for (const f of files) {
        expect(existsSync(join(STORE, f)), `${f} must stay in place on PostgreSQL`).toBe(true)
        expect(existsSync(join(STORE, `${f}.deprecated`)), `${f}.deprecated must not exist`).toBe(false)
      }
    })
  }
})

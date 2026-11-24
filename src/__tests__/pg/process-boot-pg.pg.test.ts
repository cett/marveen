// The deciding cell of the PG process: the database part of the real process
// boot (bootProcessDatabase, the function main() calls after the port takeover) runs on PostgreSQL as the app role up to
// ready. Assertions: the backend is PostgreSQL, no SQLite handle was opened, the settings caches answer, and every file the
// retire steps would rename is still in place. No listen, no timers, no runners are started (the cell does not call main()).
// Red without the guard removal AND the skips, checked by two mutants:
//   - the refusal (resolvePgUrl() !== undefined -> throw) put back at the top of bootProcessDatabase -> red at the first line
//   - skipRetireOnPg returns false (the renames run on PostgreSQL) -> the eight retire source files are renamed -> red
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
  return { STORE: mk(j(tmp(), 'pg-process-boot-pg-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { closePgBackend, listAgentSettingsByKey, listSystemConfig } from '../../db.js'
import { db as sqliteHandle } from '../../db/connection.js'
import { dbxDialect } from '../../db/facade.js'
import { bootProcessDatabase } from '../../process-db-boot.js'

let pgDb: PgTestDb

// every file one of the eight retire steps would rename (fixtures are neutral JSON)
const RETIRE_SOURCES = [
  'config-overrides.json', 'schedule-last-run.json', 'schedule-tick-state.json', 'context-guard.json', 'auto-restart.json',
  'context-restart-gate.json', 'context-restart-gate-state.json', 'kanban-audit-state.json', 'vault-bindings.json',
  'federation.json', 'model-fallback.json', 'agents-desired.json', 'terminal-input.json',
]

beforeAll(async () => {
  for (const f of RETIRE_SOURCES) writeFileSync(join(STORE, f), JSON.stringify({ fixture: 'process-boot-pg' }))
  pgDb = await createPgTestDb()
  process.env.MARVEEN_PG_URL = pgDb.appUrl
}, 60000)

afterAll(async () => {
  await closePgBackend().catch(() => undefined)
  delete process.env.MARVEEN_PG_URL
  await pgDb?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('the database part of the process boot reaches ready on PostgreSQL', () => {
  it('bootProcessDatabase resolves to pg, opens no SQLite handle, and the caches answer', async () => {
    const backend = await bootProcessDatabase()
    expect(backend).toBe('pg')
    expect(dbxDialect()).toBe('pg')
    expect(sqliteHandle).toBeUndefined()
    expect(() => listAgentSettingsByKey('context_guard')).not.toThrow()
    expect(() => listSystemConfig()).not.toThrow()
  }, 120000)

  it('no source file was renamed: every retire source is still in place with no .deprecated sibling', () => {
    // the boot must have run (not refused before it): without this, the file check passes vacuously
    expect(dbxDialect()).toBe('pg')
    for (const f of RETIRE_SOURCES) {
      expect(existsSync(join(STORE, f)), `${f} must stay in place on PostgreSQL`).toBe(true)
      expect(existsSync(join(STORE, `${f}.deprecated`)), `${f}.deprecated must not exist`).toBe(false)
    }
  })
})

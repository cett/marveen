// The settings readers of the PG process: getAgentSetting and
// listAgentSettingsByKey answer from the boot cache on PostgreSQL, and the three store readers that run on every tick
// (context-guard, context-restart-gate, auto-restart) plus the model-profile-map miss path must not throw for an agent
// or profile with no row. Cell: boot through initDatabaseAsync on a throwaway database (app role), seed one row, then read.
// Mutant: the loadAgentSettingsCacheAsync call removed from pg-boot caches -> the readers throw the not-loaded error.
// Neutral fixtures only (agent-a, unknown-agent-x, no-such-profile).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'pg-settings-readers-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import { getAgentSetting, listAgentSettingsByKey } from '../../db/agent-settings.js'
import { getModelProfileMapEntry, listModelProfileMap } from '../../db/model-profile-map.js'
import { DEFAULT_CONTEXT_GUARD } from '../../context-guard.js'
import {
  readAllContextGuardConfigs,
  readContextGuardConfig,
  writeContextGuardConfig,
} from '../../web/context-guard-store.js'
import { readGateConfig } from '../../web/context-restart-gate-store.js'
import { readAllAutoRestartConfigs, readAutoRestartConfig } from '../../web/auto-restart-store.js'

let db: PgTestDb

beforeAll(async () => {
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
  // NO context around the boot call, as in src/main.ts (see boot-importers.pg.test.ts)
  expect(await initDatabaseAsync()).toBe('pg')
  // seed one row through the real writer, inside the system context the writer's RLS check expects
  await runAs.system('settings-readers-seed', async () => {
    await writeContextGuardConfig('agent-a', { ...DEFAULT_CONTEXT_GUARD, enabled: true })
  })
}, 60000)

afterAll(async () => {
  await closePgBackend()
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('PostgreSQL settings readers answer from the boot cache', () => {
  it('an unknown agent and key give undefined, the list reader gives an object that holds the seeded agent', () => {
    expect(getAgentSetting('unknown-agent-x', 'context_guard')).toBeUndefined()
    const list = listAgentSettingsByKey('context_guard')
    expect(typeof list).toBe('object')
    expect(list).not.toBeNull()
    expect(Object.keys(list)).toContain('agent-a')
  })

  it('the context-guard reader gives the disabled default for an unknown agent and the seeded config for agent-a', () => {
    expect(readContextGuardConfig('unknown-agent-x')).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(readContextGuardConfig('agent-a').enabled).toBe(true)
    expect(Object.keys(readAllContextGuardConfigs())).toContain('agent-a')
  })

  it('the context-restart-gate and auto-restart readers do not throw on a tick, for an unknown agent', () => {
    for (let tick = 0; tick < 3; tick++) {
      expect(() => readGateConfig('unknown-agent-x')).not.toThrow()
      expect(() => readAutoRestartConfig('unknown-agent-x')).not.toThrow()
      expect(() => readAllAutoRestartConfigs()).not.toThrow()
    }
    expect(typeof readAllAutoRestartConfigs()).toBe('object')
  })

  it('the model-profile-map miss path gives undefined for an unknown profile, the list reader gives an array', () => {
    expect(getModelProfileMapEntry('no-such-profile')).toBeUndefined()
    expect(Array.isArray(listModelProfileMap())).toBe(true)
  })
})

// The OTLP gauge readers on PostgreSQL: the four functions of
// src/db/otel-gauges.ts are ported to dbx, and each one returns a number, an array or null on a PostgreSQL database,
// never a TypeError. The export calls them inside the system job otel-push-exporter; the cell reads them the same way
// (runAs.system) under the app role. One pending inter-agent message is seeded, so the count and the age are checked
// against a known row. Mutant: the pre-port file (getDb().prepare) on PostgreSQL throws, the cell is red.
// Neutral fixtures only (agent-a, agent-b).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'pg-otel-gauges-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { dbx } from '../../db/facade.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import {
  countPendingAgentMessages,
  oldestPendingAgentMessageAt,
  countIncomingEventsBySourceStatus,
  oldestPendingIncomingEventBySource,
} from '../../db/otel-gauges.js'

let db: PgTestDb
const SEEDED_CREATED_AT = 1700000000

beforeAll(async () => {
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
  expect(await initDatabaseAsync()).toBe('pg')
  await runAs.system('otel-gauges-seed', async () => {
    await dbx.run(
      "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      'agent-a', 'agent-b', 'fixture', SEEDED_CREATED_AT,
    )
  })
}, 60000)

afterAll(async () => {
  await closePgBackend()
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('the OTLP gauge readers answer on PostgreSQL', () => {
  it('the pending-message count and the oldest pending timestamp read the seeded row', async () => {
    await runAs.system('otel-push-exporter', async () => {
      const pending = await countPendingAgentMessages()
      expect(typeof pending).toBe('number')
      expect(pending).toBeGreaterThanOrEqual(1)
      const oldest = await oldestPendingAgentMessageAt()
      expect(oldest).toBe(SEEDED_CREATED_AT)
    })
  })

  it('the incoming-event readers give arrays (empty is fine), never a TypeError', async () => {
    await runAs.system('otel-push-exporter', async () => {
      const byStatus = await countIncomingEventsBySourceStatus()
      expect(Array.isArray(byStatus)).toBe(true)
      const oldestBySource = await oldestPendingIncomingEventBySource()
      expect(Array.isArray(oldestBySource)).toBe(true)
    })
  })
})

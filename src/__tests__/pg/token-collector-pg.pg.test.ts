// The token-usage collector on PostgreSQL: the dashboard boot calls
// collectTokenUsage() inside runAs.system('token-usage-collector') (web.ts), and the first probe reported a TypeError that
// turned out to be a probe artefact (SQLite handle unset, module instance outside the init). On a real PostgreSQL boot the
// collector completes: the first run inserts the two fixture calls, the second run is idempotent (cursor), and the backend
// stays PostgreSQL. The collector reads only the async dbx facade (no getDb, no *Sync). Cell under the app role, with a
// fixture transcript under a temp HOME, so the real ~/.claude/projects is never read.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { HOME_DIR, STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-token-collector-home-'))
  const projDir = path.join(home, '.claude', 'projects', '-fixture-agents-agent-a')
  fs.mkdirSync(projDir, { recursive: true })
  const line = JSON.stringify({
    type: 'assistant', sessionId: 'fixture-session', timestamp: new Date().toISOString(),
    message: { model: 'fixture-model', content: [{ type: 'text', text: 'fixture' }],
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })
  fs.writeFileSync(path.join(projDir, 'fixture-session.jsonl'), line + '\n' + line + '\n')
  process.env.HOME = home
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-token-collector-store-'))
  return { HOME_DIR: home, STORE: store }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'
import { collectTokenUsage } from '../../web/token-usage.js'

let db: PgTestDb

beforeAll(async () => {
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
  expect(await initDatabaseAsync()).toBe('pg')
}, 60000)

afterAll(async () => {
  await closePgBackend().catch(() => undefined)
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
  rmSync(HOME_DIR, { recursive: true, force: true })
})

describe('the token-usage collector runs on PostgreSQL at the dashboard boot', () => {
  it('the first run inserts the fixture calls, the second run is idempotent, the backend stays PostgreSQL', async () => {
    const first = await runAs.system('token-usage-collector', () => collectTokenUsage())
    expect(first.inserted).toBeGreaterThan(0)
    expect(dbxDialect()).toBe('pg')
    const second = await runAs.system('token-usage-collector', () => collectTokenUsage())
    expect(second.inserted).toBe(0)
    expect(dbxDialect()).toBe('pg')
  }, 120000)
})

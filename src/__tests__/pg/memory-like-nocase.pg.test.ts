// The memory LIKE fallbacks on PostgreSQL are case-insensitive: searchMemoriesLikeForAgent and searchMemoriesLike (src/db/memory.ts)
// use likeNoCase, the same fold the workspace, agents, kanban and vault readers use. A row whose content is 'Postgres tanulas'
// is found by a lower-case and an upper-case query. Mutant: the pre-fix plain content LIKE on PostgreSQL is case-sensitive, the
// cells find zero rows and are red. Neutral fixtures only (agent-a, fixture-chat).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { STORE } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: tmp } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path')
  return { STORE: mk(j(tmp(), 'pg-memory-like-nocase-')) as string }
})

vi.mock('../../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), STORE_DIR: STORE }))

import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { dbx } from '../../db/facade.js'
import { initDatabaseAsync, closePgBackend } from '../../db.js'
import { searchMemoriesLike, searchMemoriesLikeForAgent } from '../../db/memory.js'

let db: PgTestDb
const SEEDED_AT = 1700000000

beforeAll(async () => {
  db = await createPgTestDb()
  process.env.MARVEEN_PG_URL = db.appUrl
  expect(await initDatabaseAsync()).toBe('pg')
  await runAs.system('memory-like-nocase-seed', async () => {
    await dbx.run(
      "INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, keywords) VALUES (?, ?, 'semantic', ?, ?, 'agent-a', 'warm', ?)",
      'fixture-chat', 'Postgres tanulas', SEEDED_AT, SEEDED_AT, 'tanulas',
    )
  })
}, 60000)

afterAll(async () => {
  await closePgBackend()
  delete process.env.MARVEEN_PG_URL
  await db?.close()
  rmSync(STORE, { recursive: true, force: true })
})

describe('the memory LIKE fallbacks on PostgreSQL ignore ASCII case', () => {
  it('searchMemoriesLikeForAgent finds the seeded content with a lower-case query', async () => {
    await runAs.system('memory-like-nocase-read', async () => {
      const rows = await searchMemoriesLikeForAgent('agent-a', 'postgres', 10)
      expect(rows.map((r) => r.content)).toContain('Postgres tanulas')
    })
  })

  it('searchMemoriesLikeForAgent finds the seeded content with an upper-case query', async () => {
    await runAs.system('memory-like-nocase-read', async () => {
      const rows = await searchMemoriesLikeForAgent('agent-a', 'POSTGRES', 10)
      expect(rows.map((r) => r.content)).toContain('Postgres tanulas')
    })
  })

  it('searchMemoriesLike (unscoped) finds the seeded content with a lower-case query', async () => {
    await runAs.system('memory-like-nocase-read', async () => {
      const rows = await searchMemoriesLike('postgres', 10)
      expect(rows.map((r) => r.content)).toContain('Postgres tanulas')
    })
  })

  it('searchMemoriesLike (unscoped) finds the seeded content with an upper-case query', async () => {
    await runAs.system('memory-like-nocase-read', async () => {
      const rows = await searchMemoriesLike('POSTGRES', 10)
      expect(rows.map((r) => r.content)).toContain('Postgres tanulas')
    })
  })
})

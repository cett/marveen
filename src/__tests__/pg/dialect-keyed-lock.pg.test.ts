// The keyed advisory lock on a real PostgreSQL server (MARVEEN_PG_TEST_URL, `npm run test:pg`): the same key (prefix plus id)
// makes a second transaction wait; another id under the same prefix does not; the same id under another prefix does not.
// The waits are the interleave helper's (no timing). The text and the refusals are pinned in
// src/__tests__/dialect-keyed-lock.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgDbx, type PgDbx } from '../../db/pg/dbx.js'
import { advisoryLockKeyed } from '../../db/dialect.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { interleave, waitBlockedOnLock } from '../helpers/interleave.js'

let db: PgTestDb
let dbx: PgDbx

beforeAll(async () => {
  db = await createPgTestDb()
  dbx = createPgDbx(db.pool)
})

afterAll(async () => {
  if (db) await db.close()
})

/** Runs the keyed lock as the first statement of a transaction (the caller's pattern). */
async function lockKeyed(tx: { run: (sql: string, ...p: unknown[]) => Promise<unknown> }, prefix: 'bgtask:' | 'approval:', id: string): Promise<void> {
  const l = advisoryLockKeyed(prefix, id, 'pg')
  if (l) await tx.run(l.sql, ...l.params)
}

describe('keyed advisory lock: the same key waits, another key does not (PostgreSQL)', () => {
  it('a second transaction on the same prefix and id waits until the first one ends', async () => {
    const il = interleave()
    const log: string[] = []
    il.hold('held')
    const first = dbx.tx(async (tx) => {
      await lockKeyed(tx, 'bgtask:', 'agent-a')
      log.push('a1')
      await il.pass('held')
      log.push('a2')
    })
    await il.reached('held')
    const second = dbx.tx(async (tx) => {
      await lockKeyed(tx, 'bgtask:', 'agent-a')
      log.push('b1')
    })
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('held')
      await Promise.allSettled([first, second])
    }
    expect(log).toEqual(['a1', 'a2', 'b1'])
  })

  it('another id under the same prefix does not wait', async () => {
    const il = interleave()
    il.hold('held-other-id')
    const first = dbx.tx(async (tx) => {
      await lockKeyed(tx, 'bgtask:', 'agent-a')
      await il.pass('held-other-id')
    })
    await il.reached('held-other-id')
    try {
      // would hang here (failing on the test timeout) if the key ignored the id
      await dbx.tx((tx) => lockKeyed(tx, 'bgtask:', 'agent-b'))
    } finally {
      il.open('held-other-id')
      await Promise.allSettled([first])
    }
  })

  it('the same id under another prefix does not wait', async () => {
    const il = interleave()
    il.hold('held-other-prefix')
    const first = dbx.tx(async (tx) => {
      await lockKeyed(tx, 'bgtask:', 'agent-a')
      await il.pass('held-other-prefix')
    })
    await il.reached('held-other-prefix')
    try {
      await dbx.tx((tx) => lockKeyed(tx, 'approval:', 'agent-a'))
    } finally {
      il.open('held-other-prefix')
      await Promise.allSettled([first])
    }
  })
})

// The advisory lock and the row lock fragments on a real PostgreSQL server (MARVEEN_PG_TEST_URL, `npm run test:pg`).
// The text is pinned without a server in src/__tests__/dialect-lock.test.ts; here is what the server does with it:
// the second transaction on the same advisory key waits until the first one ends, another key does not wait, and
// FOR UPDATE makes a second transaction wait on the row. The waits are the interleave helper's (no timing).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgDbx, type PgDbx } from '../../db/pg/dbx.js'
import { advisoryLockSql, forUpdate } from '../../db/dialect.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { interleave, waitBlockedOnLock } from '../helpers/interleave.js'

let db: PgTestDb
let dbx: PgDbx

beforeAll(async () => {
  db = await createPgTestDb()
  dbx = createPgDbx(db.pool)
  await db.pool.query('CREATE TABLE dl_t (id bigint PRIMARY KEY, v bigint NOT NULL)')
  await db.pool.query('INSERT INTO dl_t (id, v) VALUES (1, 0)')
})

afterAll(async () => {
  if (db) await db.close()
})

describe('advisory lock: the second transaction on the same key waits for the first', () => {
  it('runs its body after the first transaction has ended', async () => {
    const il = interleave()
    const log: string[] = []
    il.hold('held')
    const first = dbx.tx(async (tx) => {
      await tx.run(advisoryLockSql('lock-key-a', 'pg'))
      log.push('a1')
      await il.pass('held')
      log.push('a2')
    })
    await il.reached('held')
    const second = dbx.tx(async (tx) => {
      await tx.run(advisoryLockSql('lock-key-a', 'pg'))
      log.push('b1')
    })
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      // a mutant that does not block must not leave the first transaction open: the gate opens either way
      il.open('held')
      await Promise.allSettled([first, second])
    }
    expect(log).toEqual(['a1', 'a2', 'b1'])
  })

  it('does not hold a different key: a transaction on another key finishes while the first one is held', async () => {
    const il = interleave()
    il.hold('held-other')
    const first = dbx.tx(async (tx) => {
      await tx.run(advisoryLockSql('lock-key-a', 'pg'))
      await il.pass('held-other')
    })
    await il.reached('held-other')
    // would hang here (and fail on the test timeout) if the key were shared
    await dbx.tx(async (tx) => {
      await tx.run(advisoryLockSql('lock-key-b', 'pg'))
    })
    il.open('held-other')
    await first
  })
})

describe('row lock: FOR UPDATE makes the second transaction wait for the row', () => {
  it('a second FOR UPDATE on the same row waits until the first commits', async () => {
    const il = interleave()
    const log: string[] = []
    il.hold('row-held')
    const first = dbx.tx(async (tx) => {
      await tx.get(`SELECT v FROM dl_t WHERE id = 1 ${forUpdate('pg')}`)
      log.push('a1')
      await il.pass('row-held')
      await tx.run('UPDATE dl_t SET v = 1 WHERE id = 1')
      log.push('a2')
    })
    await il.reached('row-held')
    const second = dbx.tx(async (tx) => {
      await tx.get(`SELECT v FROM dl_t WHERE id = 1 ${forUpdate('pg')}`)
      log.push('b1')
    })
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('row-held')
      await Promise.allSettled([first, second])
    }
    expect(log).toEqual(['a1', 'a2', 'b1'])
  })
})

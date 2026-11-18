// The interleaving helper (helpers/interleave.ts): a held point stops the body until the test opens it, and a point
// that is not held does not stop anything. The order of the two transactions is the engine's: on PostgreSQL the second
// transaction runs while the first one is stopped (it blocks on the row lock only when it reaches the UPDATE); on SQLite
// the second transaction waits in the connection lock until the first one commits.
//
// Mutant "barrier is a no-op" (pass() never stops): `reached` never resolves, the cells fail.
//
// Privacy: neutral fixtures only (user-a).

import { describe, it, expect } from 'vitest'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

async function userId(): Promise<number> {
  await dbx.run(
    "INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES ('user-a', 'hash', 'viewer', NULL, 1, 1)",
  )
  return ((await dbx.get('SELECT id FROM dashboard_users WHERE username = ?', 'user-a')) as { id: number }).id
}

describe('interleave: a held point', () => {
  it('stops the first transaction until the test opens it, and the second one runs in between where its engine allows', async () => {
    const id = await userId()
    const il = interleave()
    const log: string[] = []
    il.hold('mid')
    const first = dbx.tx(async (tx) => {
      await tx.run('UPDATE dashboard_users SET updated_at = 2 WHERE id = ?', id)
      log.push('a1')
      await il.pass('mid')
      log.push('a2')
    })
    await il.reached('mid')
    const second = dbx.tx(async (tx) => {
      log.push('b1')
      await tx.run('UPDATE dashboard_users SET updated_at = 3 WHERE id = ?', id)
      log.push('b2')
    })
    await waitBlockedOnLock(dbx)
    il.open('mid')
    await Promise.all([first, second])
    // PostgreSQL: b1 runs while a is stopped, b2 only after a commits. SQLite: one connection, b waits for a's commit.
    expect(log).toEqual(testDbMode() === 'pg' ? ['a1', 'b1', 'a2', 'b2'] : ['a1', 'a2', 'b1', 'b2'])
  })
})

describe('interleave: a point that is not held', () => {
  it('does not stop the body', async () => {
    const il = interleave()
    const log: string[] = []
    await dbx.tx(async () => {
      log.push('before')
      await il.pass('free')
      log.push('after')
    })
    expect(log).toEqual(['before', 'after'])
  })
})

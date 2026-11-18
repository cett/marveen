// Two skill usage logs of one invocation at once (db/audit.ts logSkillUsage, the (agent, skill) lock of the dedup): exactly one
// row is written. A holder transaction keeps the (agent, skill) key; the two logs queue behind it (PostgreSQL: seen in
// pg_stat_activity, interleave helper, no timing; SQLite: the connection lock). Then the first one writes, and the second one
// finds its row in the window and writes nothing.
//
// Privacy: neutral fixtures only (agent-a, skill-a, session-a).

import { describe, expect, it } from 'vitest'
import { advisoryKeyOf, advisoryLockKeyed } from '../db/dialect.js'
import { logSkillUsage } from '../db/audit.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

describe('skill usage dedup: two logs of one invocation', () => {
  it('exactly one is written', async () => {
    const il = interleave()
    il.hold('usage-key-held')
    const holder = dbx.tx(async (tx) => {
      const lock = advisoryLockKeyed('skill-usage:', advisoryKeyOf('agent-a', 'skill-a'), testDbMode())
      if (lock) await tx.run(lock.sql, ...lock.params)
      await il.pass('usage-key-held')
    })
    await il.reached('usage-key-held')
    const u1 = logSkillUsage('agent-a', 'skill-a', 'tool_call', 'session-a')
    const u2 = logSkillUsage('agent-a', 'skill-a', 'tool_call', 'session-a')
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('usage-key-held')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([u1, u2])
    await holder
    expect([r1, r2].sort()).toEqual([false, true])
    const rows = await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_usage WHERE agent_id = 'agent-a' AND skill_name = 'skill-a'")
    expect(rows?.n).toBe(1)
  })
})

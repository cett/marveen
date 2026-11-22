// createBackgroundTaskAtomic under concurrency (db/misc.ts, the per-agent advisory lock of the count-then-insert): two starts for
// one agent with a limit of one must not both run. A holder transaction takes the same per-agent key and waits on the
// interleave gate; the two starts queue behind it (PostgreSQL: seen in pg_stat_activity; SQLite: the connection lock).
// Afterwards exactly one task is running.
//
// Privacy: neutral fixtures only (agent-a, agent-b).

import { describe, expect, it } from 'vitest'
import { advisoryLockKeyed } from '../db/dialect.js'
import { createBackgroundTaskAtomic, finishBackgroundTask } from '../db/misc.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

describe('background task start: the per-agent limit under concurrency', () => {
  it('two starts for one agent with a limit of one: exactly one runs', async () => {
    const il = interleave()
    il.hold('agent-locked')
    const holder = dbx.tx(async (tx) => {
      const lock = advisoryLockKeyed('bgtask:', 'agent-a', testDbMode())
      if (lock) await tx.run(lock.sql, ...lock.params)
      await il.pass('agent-locked')
    })
    await il.reached('agent-locked')
    const s1 = createBackgroundTaskAtomic('task-1', 'agent-a', 'prompt', 'session-1', 1)
    const s2 = createBackgroundTaskAtomic('task-2', 'agent-a', 'prompt', 'session-2', 1)
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('agent-locked')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([s1, s2])
    await holder
    expect([r1 !== null, r2 !== null].sort()).toEqual([false, true])
    const running = await dbx.get<{ c: number }>("SELECT COUNT(*) AS c FROM background_tasks WHERE agent_id = 'agent-a' AND status = 'running'")
    expect(running?.c).toBe(1)
  })

  it('a finished task (done or failed) does not count as running against the limit', async () => {
    expect(await createBackgroundTaskAtomic('task-done', 'agent-a', 'prompt', 'session-d', 2)).not.toBeNull()
    expect(await createBackgroundTaskAtomic('task-failed', 'agent-a', 'prompt', 'session-f', 2)).not.toBeNull()
    await finishBackgroundTask('task-done', 'done', null)
    await finishBackgroundTask('task-failed', 'failed', null)
    expect(await createBackgroundTaskAtomic('task-new', 'agent-a', 'prompt', 'session-n', 1)).not.toBeNull()
  })

  it('a running task of another agent does not count against this agent', async () => {
    const other = await createBackgroundTaskAtomic('task-b', 'agent-b', 'prompt', 'session-b', 1)
    expect(other).not.toBeNull()
    const mine = await createBackgroundTaskAtomic('task-a', 'agent-a', 'prompt', 'session-a', 1)
    expect(mine).not.toBeNull()
  })
})

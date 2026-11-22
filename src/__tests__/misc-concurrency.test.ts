// db/misc.ts on the async facade: three places where two overlapping callers used to be serialised by the
// synchronous driver and are now interleaved at every await.
//   C8  upsertChannelRequest   one statement, exactly one winner, no exception for the loser
//   C9  finishBackgroundTask   only a 'running' task can be closed; the loser learns it lost
//   B   createBackgroundTaskAtomic   the count check and the insert share one transaction
// The overlaps are holders, not timings: a transaction takes the row or the lock first, parks, and the production call
// starts while it is parked (PostgreSQL, two real connections). Where a cell can only check the end state, it runs on both
// engines and is named weak.
import { describe, it, expect } from 'vitest'
import {
  dbx, upsertChannelRequest, listPendingChannelRequests, finishBackgroundTask, getBackgroundTask,
  createBackgroundTaskAtomic, getBackgroundTasks, updateChannelRequestStatus,
  revertIdeaFromKanban, addIdeaComment, getIdeaComments, updateIdeaWithStatusLog,
} from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'
import { advisoryLockKeyed } from '../db/dialect.js'

useTestDb()

const DAY = 86400
const nowS = () => Math.floor(Date.now() / 1000)

async function channelRows(agent: string, channel: string): Promise<{ status: string }[]> {
  return dbx.all<{ status: string }>('SELECT status FROM pending_channel_requests WHERE agent = ? AND channel_id = ?', agent, channel)
}

async function seedTask(id: string, agent = 'agent-a'): Promise<void> {
  await dbx.run("INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, 'p', 'running', ?, ?)",
    id, agent, `bg-${id}`, nowS())
}

describe('C8 upsertChannelRequest', () => {
  it.runIf(testDbMode() === 'pg')('two overlapping calls for one agent+channel: the one that waits returns false (two real connections)', async () => {
    const il = interleave()
    il.hold('row-parked')
    const holder = dbx.tx(async (tx) => {
      await tx.run("INSERT INTO pending_channel_requests (agent, channel_id, user_id, requested_at, status) VALUES ('agent-a', 'C1', 'U1', ?, 'pending')", nowS())
      await il.pass('row-parked')
    })
    await il.reached('row-parked')
    const waiting = upsertChannelRequest('agent-a', 'C1', 'U2')
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('row-parked')
      await holder
    }
    expect(await waiting).toBe(false)
    expect(await channelRows('agent-a', 'C1')).toEqual([{ status: 'pending' }])
  })

  // Weak (end state, both engines): the second of two calls for one agent and channel finds the pending row and returns false.
  it('two calls for one agent+channel: one creates the row, the other returns false, neither throws', async () => {
    const results = [await upsertChannelRequest('agent-a', 'C1', 'U1'), await upsertChannelRequest('agent-a', 'C1', 'U2')]
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await channelRows('agent-a', 'C1')).toEqual([{ status: 'pending' }])
  })

  // Weak (end state, both engines): five calls still leave exactly one pending row.
  it('five calls still leave exactly one pending row', async () => {
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) results.push(await upsertChannelRequest('agent-a', 'C1', `U${i}`))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await channelRows('agent-a', 'C1')).toHaveLength(1)
  })

  it('a request denied less than 7 days ago blocks a new one, a request denied longer ago does not', async () => {
    await dbx.run("INSERT INTO pending_channel_requests (agent, channel_id, requested_at, resolved_at, status) VALUES ('agent-a', 'RECENT', ?, ?, 'denied')", nowS() - 4 * DAY, nowS() - 3 * DAY)
    await dbx.run("INSERT INTO pending_channel_requests (agent, channel_id, requested_at, resolved_at, status) VALUES ('agent-a', 'OLD', ?, ?, 'denied')", nowS() - 10 * DAY, nowS() - 8 * DAY)

    expect(await upsertChannelRequest('agent-a', 'RECENT')).toBe(false)
    expect(await channelRows('agent-a', 'RECENT')).toEqual([{ status: 'denied' }])

    expect(await upsertChannelRequest('agent-a', 'OLD')).toBe(true)
    expect((await channelRows('agent-a', 'OLD')).map((r) => r.status).sort()).toEqual(['denied', 'pending'])
  })

  it('a denial without resolved_at counts from requested_at', async () => {
    await dbx.run("INSERT INTO pending_channel_requests (agent, channel_id, requested_at, status) VALUES ('agent-a', 'NR', ?, 'denied')", nowS() - 2 * DAY)
    expect(await upsertChannelRequest('agent-a', 'NR')).toBe(false)
  })

  it('an approved request does not block a new one (the channel was removed from the allowlist later)', async () => {
    await upsertChannelRequest('agent-a', 'C9')
    const [row] = await listPendingChannelRequests('agent-a')
    expect(await updateChannelRequestStatus(row!.id, 'approved')).toBe(true)
    expect(await upsertChannelRequest('agent-a', 'C9')).toBe(true)
  })
})

describe('C9 finishBackgroundTask', () => {
  // Holder (PostgreSQL): the poll's close is parked before its commit; the sweep waits on the task row, finds it closed after the
  // commit (the guard 'running' is re-checked), and returns false. The state and the output are the poll's.
  it.runIf(testDbMode() === 'pg')('poll "done" and timeout sweep racing for one task: the sweep waits and loses (two real connections)', async () => {
    await seedTask('T1')
    const il = interleave()
    il.hold('poll-parked')
    const holder = dbx.tx(async (tx) => {
      await tx.run("UPDATE background_tasks SET status = 'done', finished_at = ?, output = 'poll output' WHERE id = ? AND status = 'running'", nowS(), 'T1')
      await il.pass('poll-parked')
    })
    await il.reached('poll-parked')
    const sweep = finishBackgroundTask('T1', 'timeout', 'sweep output')
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('poll-parked')
      await holder
    }
    expect(await sweep).toBe(false)
    expect(await getBackgroundTask('T1')).toMatchObject({ status: 'done', output: 'poll output' })
  })

  it('a task that is already closed keeps its state and output, and the call returns false', async () => {
    await seedTask('T2')
    expect(await finishBackgroundTask('T2', 'done', 'first')).toBe(true)
    const closedAt = (await getBackgroundTask('T2'))?.finished_at

    expect(await finishBackgroundTask('T2', 'timeout', 'second')).toBe(false)
    const row = await getBackgroundTask('T2')
    expect(row).toMatchObject({ status: 'done', output: 'first', finished_at: closedAt })
  })

  it('an unknown id returns false', async () => {
    expect(await finishBackgroundTask('NOPE', 'failed', null)).toBe(false)
  })
})

describe('B createBackgroundTaskAtomic', () => {
  // Holder (PostgreSQL): the first start holds the per-agent lock (bgtask:) with one running task; the second start waits on the
  // lock and, after the commit, counts the running task and gets null.
  it.runIf(testDbMode() === 'pg')('maxConcurrent=1: a start that waits on the agent lock gets null once the first start has committed (two real connections)', async () => {
    const il = interleave()
    il.hold('start-parked')
    const lock = advisoryLockKeyed('bgtask:', 'agent-a')
    if (!lock) throw new Error('the per-agent lock is a PostgreSQL advisory lock')
    const holder = dbx.tx(async (tx) => {
      await tx.run(lock.sql, ...lock.params)
      await tx.run("INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES ('H1', 'agent-a', 'p', 'running', 'bg-H1', ?)", nowS())
      await il.pass('start-parked')
    })
    await il.reached('start-parked')
    const waiting = createBackgroundTaskAtomic('A2', 'agent-a', 'p2', 'bg-A2', 1)
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('start-parked')
      await holder
    }
    expect(await waiting).toBeNull()
    expect(await getBackgroundTasks('agent-a')).toHaveLength(1)
  })

  // Weak (end state, both engines): six starts in a row against a limit of three create exactly three. The overlapped version
  // (starts queued on the agent lock behind a holder) cannot be a cell in this suite: the PostgreSQL test pool has 4
  // connections (pg-test-db.ts, max 4). A holder takes one and each queued start one more, and the wait check needs one
  // more, so at most two starts can queue; a third start waits in the pool, not on the lock, and the wait check never
  // reaches six. Measured: 3 lock waiters + 1 idle-in-transaction holder seen in pg_stat_activity, the other 3 starts
  // queued in the pool; released, the outcome was true x3, false x3 (correct). The queue cell is the maxConcurrent=1 one.
  it('maxConcurrent=3 with six starts creates exactly three', async () => {
    const results: Array<unknown> = []
    for (let i = 0; i < 6; i++) results.push(await createBackgroundTaskAtomic(`B${i}`, 'agent-a', 'p', `bg-B${i}`, 3))
    expect(results.filter((r) => r !== null)).toHaveLength(3)
    expect(await getBackgroundTasks('agent-a')).toHaveLength(3)
  })

  it('the limit is per agent', async () => {
    const results = await Promise.all([
      createBackgroundTaskAtomic('P1', 'agent-a', 'p', 'bg-P1', 1),
      createBackgroundTaskAtomic('P2', 'agent-b', 'p', 'bg-P2', 1),
    ])
    expect(results.every((r) => r !== null)).toBe(true)
  })

  it('a finished task no longer counts against the limit', async () => {
    await createBackgroundTaskAtomic('F1', 'agent-a', 'p', 'bg-F1', 1)
    expect(await createBackgroundTaskAtomic('F2', 'agent-a', 'p', 'bg-F2', 1)).toBeNull()
    expect(await finishBackgroundTask('F1', 'done', 'x')).toBe(true)
    expect(await createBackgroundTaskAtomic('F3', 'agent-a', 'p', 'bg-F3', 1)).not.toBeNull()
  })
})

// ── idea box: multi-statement writes are one transaction ────────────────────────────────────────────────────────

async function seedIdea(id: string, status: 'new' | 'kanban' = 'kanban', kanbanId: string | null = 'card-1'): Promise<void> {
  await dbx.run(
    "INSERT INTO idea_box (id, title, category, status, source, kanban_id, tenant_id, created_at, updated_at) VALUES (?, 't', 'c', ?, 's', ?, 'default', 1, 1)",
    id, status, kanbanId,
  )
}

const logRows = (id: string) => dbx.all<{ from_status: string | null; to_status: string; actor: string }>(
  'SELECT from_status, to_status, actor FROM idea_status_log WHERE idea_id = ?', id,
)
const ideaRow = async (id: string) => (await dbx.get<{ status: string; kanban_id: string | null; updated_at: number }>(
  'SELECT status, kanban_id, updated_at FROM idea_box WHERE id = ?', id,
)) as { status: string; kanban_id: string | null; updated_at: number }

describe('revertIdeaFromKanban', () => {
  // Holder (PostgreSQL): the first revert is parked after its idea update and its log row. The second revert waits on the idea row;
  // after the commit its guarded update (status 'kanban') matches nothing, so it returns null and writes no log row.
  it.runIf(testDbMode() === 'pg')('two overlapping reverts of one card write exactly one log row; the one that waits returns null (two real connections)', async () => {
    await seedIdea('I1')
    const il = interleave()
    il.hold('revert-parked')
    const holder = dbx.tx(async (tx) => {
      await tx.run("UPDATE idea_box SET status = 'reviewed', kanban_id = NULL, updated_at = ? WHERE id = ? AND status = 'kanban'", nowS(), 'I1')
      await tx.run("INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, created_at) VALUES ('I1', 'kanban', 'reviewed', 'system', ?)", nowS())
      await il.pass('revert-parked')
    })
    await il.reached('revert-parked')
    const waiting = revertIdeaFromKanban('card-1')
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('revert-parked')
      await holder
    }
    expect(await waiting).toBeNull()
    expect(await logRows('I1')).toEqual([{ from_status: 'kanban', to_status: 'reviewed', actor: 'system' }])
    expect(await ideaRow('I1')).toMatchObject({ status: 'reviewed', kanban_id: null })
  })

  it('a failed log write rolls the idea update back (the idea stays promoted)', async () => {
    await seedIdea('I2')
    await refuseWrite(dbx, { name: 'fail_log', table: 'idea_status_log', message: 'log failed' })

    await expect(revertIdeaFromKanban('card-1')).rejects.toThrow('log failed')

    expect(await ideaRow('I2')).toMatchObject({ status: 'kanban', kanban_id: 'card-1' })
    expect(await logRows('I2')).toEqual([])
  })

  it('an unknown card, or an idea that is not in the kanban status, is left alone', async () => {
    await seedIdea('I3', 'new', 'card-3')
    expect(await revertIdeaFromKanban('card-3')).toBeNull()
    expect(await revertIdeaFromKanban('nope')).toBeNull()
    expect((await ideaRow('I3')).status).toBe('new')
    expect(await logRows('I3')).toEqual([])
  })
})

describe('addIdeaComment', () => {
  it('a failed updated_at write leaves no comment behind', async () => {
    await seedIdea('I4', 'new', null)
    await refuseWrite(dbx, { name: 'fail_touch', table: 'idea_box', message: 'touch failed', event: 'UPDATE' })

    await expect(addIdeaComment('I4', 'a', 'text')).rejects.toThrow('touch failed')

    expect(await getIdeaComments('I4')).toEqual([])
  })

  it('writes the comment and moves updated_at together', async () => {
    await seedIdea('I5', 'new', null)
    const c = await addIdeaComment('I5', 'a', 'text')
    expect(await getIdeaComments('I5')).toHaveLength(1)
    expect((await ideaRow('I5')).updated_at).toBe(c.created_at)
  })
})

describe('updateIdeaWithStatusLog', () => {
  it('a failed log write rolls the status change back', async () => {
    await seedIdea('I6', 'new', null)
    await refuseWrite(dbx, { name: 'fail_log2', table: 'idea_status_log', message: 'log failed' })

    await expect(updateIdeaWithStatusLog('I6', { status: 'reviewed' }, { from: 'new', to: 'reviewed', actor: 'a' })).rejects.toThrow('log failed')

    expect((await ideaRow('I6')).status).toBe('new')
  })

  it('an unknown idea changes nothing and logs nothing', async () => {
    expect(await updateIdeaWithStatusLog('nope', { status: 'reviewed' }, { from: 'new', to: 'reviewed', actor: 'a' })).toBe(false)
    expect(await logRows('nope')).toEqual([])
  })

  it('a change writes the idea row and one log row', async () => {
    await seedIdea('I7', 'new', null)
    expect(await updateIdeaWithStatusLog('I7', { status: 'kanban', kanban_id: 'c9' }, { from: 'new', to: 'kanban', actor: 'a', note: 'n' })).toBe(true)
    expect(await ideaRow('I7')).toMatchObject({ status: 'kanban', kanban_id: 'c9' })
    expect(await logRows('I7')).toEqual([{ from_status: 'new', to_status: 'kanban', actor: 'a' }])
  })
})

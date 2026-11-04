// db/misc.ts on the async facade: three places where two overlapping callers used to be serialised by the
// synchronous driver and are now interleaved at every await.
//   C8  upsertChannelRequest   one statement, exactly one winner, no exception for the loser
//   C9  finishBackgroundTask   only a 'running' task can be closed; the loser learns it lost
//   B   createBackgroundTaskAtomic   the count check and the insert share one transaction
// Promise.all([a, b]) queues both calls on the one connection lock; a read-then-write written as two separate
// statements would run both reads first.
import { describe, it, expect } from 'vitest'
import {
  getDb, upsertChannelRequest, listPendingChannelRequests, finishBackgroundTask, getBackgroundTask,
  createBackgroundTaskAtomic, getBackgroundTasks, updateChannelRequestStatus,
  revertIdeaFromKanban, addIdeaComment, getIdeaComments, updateIdeaWithStatusLog,
} from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const DAY = 86400
const nowS = () => Math.floor(Date.now() / 1000)

function channelRows(agent: string, channel: string): { status: string }[] {
  return getDb().prepare('SELECT status FROM pending_channel_requests WHERE agent = ? AND channel_id = ?').all(agent, channel) as { status: string }[]
}

function seedTask(id: string, agent = 'agent-a'): void {
  getDb().prepare("INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, 'p', 'running', ?, ?)")
    .run(id, agent, `bg-${id}`, nowS())
}

describe('C8 upsertChannelRequest', () => {
  it('two overlapping calls for one agent+channel: one creates the row, the other returns false, neither throws', async () => {
    const results = await Promise.all([
      upsertChannelRequest('agent-a', 'C1', 'U1'),
      upsertChannelRequest('agent-a', 'C1', 'U2'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(channelRows('agent-a', 'C1')).toEqual([{ status: 'pending' }])
  })

  it('five overlapping calls still leave exactly one pending row', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => upsertChannelRequest('agent-a', 'C1', `U${i}`)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(channelRows('agent-a', 'C1')).toHaveLength(1)
  })

  it('a request denied less than 7 days ago blocks a new one, a request denied longer ago does not', async () => {
    const db = getDb()
    const deny = db.prepare("INSERT INTO pending_channel_requests (agent, channel_id, requested_at, resolved_at, status) VALUES (?, ?, ?, ?, 'denied')")
    deny.run('agent-a', 'RECENT', nowS() - 4 * DAY, nowS() - 3 * DAY)
    deny.run('agent-a', 'OLD', nowS() - 10 * DAY, nowS() - 8 * DAY)

    expect(await upsertChannelRequest('agent-a', 'RECENT')).toBe(false)
    expect(channelRows('agent-a', 'RECENT')).toEqual([{ status: 'denied' }])

    expect(await upsertChannelRequest('agent-a', 'OLD')).toBe(true)
    expect(channelRows('agent-a', 'OLD').map((r) => r.status).sort()).toEqual(['denied', 'pending'])
  })

  it('a denial without resolved_at counts from requested_at', async () => {
    getDb().prepare("INSERT INTO pending_channel_requests (agent, channel_id, requested_at, status) VALUES ('agent-a', 'NR', ?, 'denied')").run(nowS() - 2 * DAY)
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
  it('poll "done" and timeout sweep racing for one task: exactly one wins, the other state never lands', async () => {
    seedTask('T1')
    const [poll, sweep] = await Promise.all([
      finishBackgroundTask('T1', 'done', 'poll output'),
      finishBackgroundTask('T1', 'timeout', 'sweep output'),
    ])
    expect([poll, sweep].filter(Boolean)).toHaveLength(1)

    const row = await getBackgroundTask('T1')
    expect(row?.status).toBe(poll ? 'done' : 'timeout')
    expect(row?.output).toBe(poll ? 'poll output' : 'sweep output')
  })

  it('a task that is already closed keeps its state and output, and the call returns false', async () => {
    seedTask('T2')
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
  it('maxConcurrent=1 with two overlapping calls: one task is created, the other gets null', async () => {
    const results = await Promise.all([
      createBackgroundTaskAtomic('A1', 'agent-a', 'p1', 'bg-A1', 1),
      createBackgroundTaskAtomic('A2', 'agent-a', 'p2', 'bg-A2', 1),
    ])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(await getBackgroundTasks('agent-a')).toHaveLength(1)
  })

  it('maxConcurrent=3 with six overlapping calls creates exactly three', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createBackgroundTaskAtomic(`B${i}`, 'agent-a', 'p', `bg-B${i}`, 3)),
    )
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

function seedIdea(id: string, status: 'new' | 'kanban' = 'kanban', kanbanId: string | null = 'card-1'): void {
  getDb().prepare(
    "INSERT INTO idea_box (id, title, category, status, source, kanban_id, tenant_id, created_at, updated_at) VALUES (?, 't', 'c', ?, 's', ?, 'default', 1, 1)",
  ).run(id, status, kanbanId)
}

const logRows = (id: string) => getDb().prepare('SELECT from_status, to_status, actor FROM idea_status_log WHERE idea_id = ?').all(id) as
  Array<{ from_status: string | null; to_status: string; actor: string }>
const ideaRow = (id: string) => getDb().prepare('SELECT status, kanban_id, updated_at FROM idea_box WHERE id = ?').get(id) as
  { status: string; kanban_id: string | null; updated_at: number }

describe('revertIdeaFromKanban', () => {
  it('two overlapping reverts of one card write exactly one log row and one of them returns the idea id', async () => {
    seedIdea('I1')
    const results = await Promise.all([revertIdeaFromKanban('card-1'), revertIdeaFromKanban('card-1')])
    expect(results.filter((r) => r === 'I1')).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(logRows('I1')).toEqual([{ from_status: 'kanban', to_status: 'reviewed', actor: 'system' }])
    expect(ideaRow('I1')).toMatchObject({ status: 'reviewed', kanban_id: null })
  })

  it('a failed log write rolls the idea update back (the idea stays promoted)', async () => {
    seedIdea('I2')
    getDb().exec("CREATE TRIGGER fail_log BEFORE INSERT ON idea_status_log BEGIN SELECT RAISE(ABORT, 'log failed'); END")

    await expect(revertIdeaFromKanban('card-1')).rejects.toThrow('log failed')

    expect(ideaRow('I2')).toMatchObject({ status: 'kanban', kanban_id: 'card-1' })
    expect(logRows('I2')).toEqual([])
  })

  it('an unknown card, or an idea that is not in the kanban status, is left alone', async () => {
    seedIdea('I3', 'new', 'card-3')
    expect(await revertIdeaFromKanban('card-3')).toBeNull()
    expect(await revertIdeaFromKanban('nope')).toBeNull()
    expect(ideaRow('I3').status).toBe('new')
    expect(logRows('I3')).toEqual([])
  })
})

describe('addIdeaComment', () => {
  it('a failed updated_at write leaves no comment behind', async () => {
    seedIdea('I4', 'new', null)
    getDb().exec("CREATE TRIGGER fail_touch BEFORE UPDATE ON idea_box BEGIN SELECT RAISE(ABORT, 'touch failed'); END")

    await expect(addIdeaComment('I4', 'a', 'text')).rejects.toThrow('touch failed')

    expect(await getIdeaComments('I4')).toEqual([])
  })

  it('writes the comment and moves updated_at together', async () => {
    seedIdea('I5', 'new', null)
    const c = await addIdeaComment('I5', 'a', 'text')
    expect(await getIdeaComments('I5')).toHaveLength(1)
    expect(ideaRow('I5').updated_at).toBe(c.created_at)
  })
})

describe('updateIdeaWithStatusLog', () => {
  it('a failed log write rolls the status change back', async () => {
    seedIdea('I6', 'new', null)
    getDb().exec("CREATE TRIGGER fail_log2 BEFORE INSERT ON idea_status_log BEGIN SELECT RAISE(ABORT, 'log failed'); END")

    await expect(updateIdeaWithStatusLog('I6', { status: 'reviewed' }, { from: 'new', to: 'reviewed', actor: 'a' })).rejects.toThrow('log failed')

    expect(ideaRow('I6').status).toBe('new')
  })

  it('an unknown idea changes nothing and logs nothing', async () => {
    expect(await updateIdeaWithStatusLog('nope', { status: 'reviewed' }, { from: 'new', to: 'reviewed', actor: 'a' })).toBe(false)
    expect(logRows('nope')).toEqual([])
  })

  it('a change writes the idea row and one log row', async () => {
    seedIdea('I7', 'new', null)
    expect(await updateIdeaWithStatusLog('I7', { status: 'kanban', kanban_id: 'c9' }, { from: 'new', to: 'kanban', actor: 'a', note: 'n' })).toBe(true)
    expect(ideaRow('I7')).toMatchObject({ status: 'kanban', kanban_id: 'c9' })
    expect(logRows('I7')).toEqual([{ from_status: 'new', to_status: 'kanban', actor: 'a' }])
  })
})

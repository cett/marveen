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

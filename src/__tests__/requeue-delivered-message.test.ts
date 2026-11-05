// requeueDeliveredMessage (src/db/agents.ts): the compare-and-set that undoes a delivery. It must move ONLY a row that is
// still 'delivered', belongs to this agent and carries this tenant; a second call changes nothing; the trace columns and
// the result are left alone. Real in-memory SQLite, neutral fixtures (agent-a, agent-b, tenant-x).

import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, createAgentMessage, markMessageDelivered, markMessageDone, markMessageFailed,
  requeueDeliveredMessage, getPendingMessages, claimPendingForAgent, setMessageResult,
} from '../db.js'
import { dbx } from '../db/facade.js'

beforeAll(() => { initDatabase(':memory:') })

const TRACE = { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), parent_span_id: null }

async function delivered(to: string, tenant = 'default') {
  const m = await createAgentMessage('agent-b', to, `body for ${to}`, null, TRACE, tenant)
  expect(await markMessageDelivered(m.id)).toBe(true)
  return m
}
const row = (id: number) => dbx.get<Record<string, unknown>>('SELECT * FROM agent_messages WHERE id = ?', id)

describe('requeueDeliveredMessage', () => {
  it('turns a delivered row back to pending, clears delivered_at, and the router sees it again', async () => {
    const m = await delivered('agent-a-1')
    expect(await requeueDeliveredMessage(m.id, 'agent-a-1', 'default')).toBe(true)
    const r = (await row(m.id))!
    expect(r.status).toBe('pending')
    expect(r.delivered_at).toBeNull()
    expect((await getPendingMessages('agent-a-1')).map((p) => p.id)).toEqual([m.id])
  })

  it('is idempotent: the second call (a racing tick) changes nothing and reports false', async () => {
    const m = await delivered('agent-a-2')
    expect(await requeueDeliveredMessage(m.id, 'agent-a-2', 'default')).toBe(true)
    expect(await requeueDeliveredMessage(m.id, 'agent-a-2', 'default')).toBe(false)
    expect((await row(m.id))!.status).toBe('pending')
  })

  it('does not touch a row that is not delivered: pending, done, failed are somebody else\'s state', async () => {
    const pending = await createAgentMessage('agent-b', 'agent-a-3', 'still pending', null, TRACE)
    expect(await requeueDeliveredMessage(pending.id, 'agent-a-3', 'default')).toBe(false)

    const done = await delivered('agent-a-3')
    await markMessageDone(done.id, 'handled')
    expect(await requeueDeliveredMessage(done.id, 'agent-a-3', 'default')).toBe(false)
    const doneRow = (await row(done.id))!
    expect(doneRow.status).toBe('done')
    expect(doneRow.result).toBe('handled')
    expect(doneRow.completed_at).not.toBeNull()

    const failed = await delivered('agent-a-3')
    await markMessageFailed(failed.id, 'boom')
    expect(await requeueDeliveredMessage(failed.id, 'agent-a-3', 'default')).toBe(false)
    expect((await row(failed.id))!.status).toBe('failed')
  })

  it('does not touch another agent\'s row, even with the right id and tenant', async () => {
    const m = await delivered('agent-a-4')
    expect(await requeueDeliveredMessage(m.id, 'agent-other', 'default')).toBe(false)
    expect((await row(m.id))!.status).toBe('delivered')
  })

  it('does not touch a row of another tenant, even with the right id and agent', async () => {
    const m = await delivered('agent-a-5')
    expect(await requeueDeliveredMessage(m.id, 'agent-a-5', 'tenant-x')).toBe(false)
    expect((await row(m.id))!.status).toBe('delivered')
    // ... and the right tenant works (guards against a tenant clause that never matches).
    expect(await requeueDeliveredMessage(m.id, 'agent-a-5', 'default')).toBe(true)
  })

  it('an unknown id changes nothing', async () => {
    expect(await requeueDeliveredMessage(987654321, 'agent-a-6', 'default')).toBe(false)
  })

  it('leaves the trace columns, the result and completed_at alone: the span closes once, at the real answer', async () => {
    const m = await delivered('agent-a-7')
    // Give the columns real values first: an untouched NULL proves nothing about a statement that would clear them.
    await setMessageResult(m.id, 'note-a')
    await dbx.run('UPDATE agent_messages SET completed_at = ? WHERE id = ?', 1700000000, m.id)
    const before = (await row(m.id))!
    expect(before.result).toBe('note-a')
    expect(before.completed_at).toBe(1700000000)
    await requeueDeliveredMessage(m.id, 'agent-a-7', 'default')
    const after = (await row(m.id))!
    for (const col of ['trace_id', 'span_id', 'parent_span_id', 'result', 'completed_at', 'created_at', 'content', 'from_agent', 'to_agent', 'tenant_id']) {
      expect(after[col], col).toEqual(before[col])
    }
    expect(after.trace_id).toBe(TRACE.trace_id)
    expect(after.result).toBe('note-a')
    expect(after.completed_at).toBe(1700000000)
  })

  it('a requeued row can be delivered again exactly once (delivered -> pending -> delivered)', async () => {
    const m = await delivered('agent-a-8')
    await requeueDeliveredMessage(m.id, 'agent-a-8', 'default')
    const claimed = await claimPendingForAgent('agent-a-8', 10)
    expect(claimed.map((c) => c.id)).toEqual([m.id])
    expect(await claimPendingForAgent('agent-a-8', 10)).toEqual([])
    expect((await row(m.id))!.status).toBe('delivered')
  })
})

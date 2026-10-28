// The check-then-write sequences on one agent's blackboard row (message assignment, the completion hook, the
// scheduled run's done write, the post route) run one after the other per agent. The done write of a scheduled run
// is driven for real here; the route and runner call sites are pinned by their source.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBlackboardDone, type TaskInflightEntry } from '../web/schedule-runner.js'
import { withBlackboardLock } from '../web/blackboard-lock.js'

const order: string[] = []

vi.mock('../db.js', () => ({
  findBlackboardRowByAgent: vi.fn(async () => {
    order.push('find')
    await new Promise((r) => setTimeout(r, 5))
    return { id: 'bb', agent_id: 'agent-a', task_ref: null, status: 'active', summary: 'run', updated_at: 0, tenant_id: 'default', blocked_by: null, blocked_reason: null }
  }),
  upsertBlackboard: vi.fn(() => { order.push('done'); return Promise.resolve({ status: 'done', summary: 'run', task_ref: null }) }),
}))

const entry = (agent: string): TaskInflightEntry => ({
  agentName: agent, taskName: 'run', injectedAt: 0, alerted: false, sawTurn: true,
  blackboardSnapshot: { status: 'active', summary: 'run', task_ref: null },
} as TaskInflightEntry)

beforeEach(() => { order.length = 0 })

describe('applyBlackboardDone holds the agent lock from the read to the write', () => {
  it('a post that arrives between the read and the done write runs after it, not inside it', async () => {
    const done = applyBlackboardDone(entry('agent-a'))
    const post = withBlackboardLock('agent-a', () => { order.push('post'); return Promise.resolve() })
    await Promise.all([done, post])
    expect(order).toEqual(['find', 'done', 'post'])
  })

  it('the lock is per agent: another agent is not held up', async () => {
    const done = applyBlackboardDone(entry('agent-a'))
    const other = withBlackboardLock('agent-b', () => { order.push('other'); return Promise.resolve() })
    await Promise.all([done, other])
    expect(order[0]).toBe('find')
    expect(order.indexOf('other')).toBeLessThan(order.indexOf('done'))
  })
})

describe('withBlackboardLock', () => {
  it('runs the callers of one agent in call order and survives a failure', async () => {
    const seen: number[] = []
    const a = withBlackboardLock('agent-q', async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(1); throw new Error('first fails') })
    const b = withBlackboardLock('agent-q', () => { seen.push(2); return Promise.resolve() })
    const c = withBlackboardLock('agent-q', () => { seen.push(3); return Promise.resolve() })
    await expect(a).rejects.toThrow('first fails')
    await Promise.all([b, c])
    expect(seen).toEqual([1, 2, 3])
  })
})

describe('the call sites take the lock', () => {
  const src = (rel: string): string => readFileSync(join(import.meta.dirname, '..', rel), 'utf-8')
  const count = (text: string): number => (text.match(/withBlackboardLock\(/g) ?? []).length

  it('the message route locks the assignment and the completion hook', () => {
    const text = src('web/routes/messages.ts')
    expect(count(text)).toBe(2)
    expect(text).toMatch(/withBlackboardLock\(storedTo, async \(\) => \{\s*const existing = await findBlackboardRowByAgent\(storedTo\)/)
    expect(text).toMatch(/withBlackboardLock\(from\.trim\(\), async \(\) => \{\s*const senderRow = await findBlackboardRowByAgent/)
  })

  it('the blackboard post route locks the existence check and the upsert together', () => {
    const text = src('web/routes/blackboard.ts')
    expect(count(text)).toBe(1)
    expect(text).toMatch(/withBlackboardLock\(agent_id, async \(\) => \(\{\s*hadExisting: await blackboardRowExistsForAgent\(agent_id\),\s*row: await upsertBlackboard\(/)
  })

  it('the scheduled run locks its active post and its done write', () => {
    const text = src('web/schedule-runner.ts')
    expect(count(text)).toBe(2)
    expect(text).toMatch(/withBlackboardLock\(agentName, \(\) => upsertBlackboard\(agentName, \{\s*status: 'active'/)
    expect(text).toMatch(/withBlackboardLock\(entry\.agentName, async \(\) => \{\s*const cur = await findBlackboardRowByAgent/)
  })
})

// The approval is used up EXACTLY once under concurrent callers, whichever door they use, and the statements of a
// transaction body run on the tx handle (not on the facade): on a pooled backend a facade statement would run OUTSIDE
// the transaction, on SQLite it only joins it by accident (one connection).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dbx, createApproval, resolveApproval, consumeApproval, claimApproval, createApprovalOnce } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave } from './helpers/interleave.js'

useTestDb()
beforeEach(async () => {
  await dbx.run('DELETE FROM approval_events')
  await dbx.run('DELETE FROM approvals')
})

afterEach(() => { vi.restoreAllMocks() })

const HASH = 'a'.repeat(64)
const WINDOW = 1800
const NOW = 2_000_000_000
let seq = 0

async function approved(): Promise<string> {
  const id = `qa-${++seq}`
  await createApproval({ id, agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default', human_only: true, content_hash: HASH })
  expect(await resolveApproval(id, 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
  await dbx.run('UPDATE approvals SET resolved_at = ? WHERE id = ?', NOW - 10, id)
  return id
}

const p = { content_hash: HASH, principal: 'agent-a', tenant_id: 'default', window_s: WINDOW, now: NOW }
const N = 8

describe('concurrent consumption: exactly one winner', () => {
  it('consume by id with distinct refs: one ok, the rest refused', async () => {
    const id = await approved()
    const out = await Promise.all(Array.from({ length: N }, (_, i) => consumeApproval({ ...p, id, ref: `r-${i}` })))
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
    expect(out.filter((o) => !o.ok)).toHaveLength(N - 1)
    expect(await dbx.get("SELECT COUNT(*) AS n FROM approval_events WHERE event = 'consumed'")).toEqual({ n: 1 })
  })

  it('consume by id with the SAME ref: one consumed, the rest replayed', async () => {
    const id = await approved()
    const out = await Promise.all(Array.from({ length: N }, () => consumeApproval({ ...p, id, ref: 'same' })))
    expect(out.every((o) => o.ok)).toBe(true)
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
    expect(await dbx.get("SELECT COUNT(*) AS n FROM approval_events WHERE event = 'consumed'")).toEqual({ n: 1 })
  })

  it('claim by hash with distinct refs: one ok', async () => {
    await approved()
    const out = await Promise.all(Array.from({ length: N }, (_, i) => claimApproval({ ...p, category: 'email_send', ref: `c-${i}` })))
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
    expect(out.filter((o) => !o.ok)).toHaveLength(N - 1)
  })

  it('claim by hash with the SAME ref: one consumed, the rest replayed', async () => {
    await approved()
    const out = await Promise.all(Array.from({ length: N }, () => claimApproval({ ...p, category: 'email_send', ref: 'same-claim' })))
    expect(out.every((o) => o.ok)).toBe(true)
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
  })

  it('consume by id and claim by hash racing for the same row: one winner over both doors', async () => {
    const id = await approved()
    const jobs = [
      ...Array.from({ length: 4 }, (_, i) => consumeApproval({ ...p, id, ref: `i-${i}` })),
      ...Array.from({ length: 4 }, (_, i) => claimApproval({ ...p, category: 'email_send', ref: `h-${i}` })),
    ]
    const out = await Promise.all(jobs)
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
  })

  it('send mode: one gate reservation, several senders racing to adopt it: exactly one adopts', async () => {
    await approved()
    const gate = await claimApproval({ ...p, category: 'email_send', ref: 'gate-send-1' })
    expect(gate.ok).toBe(true)
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => claimApproval({ ...p, category: 'email_send', mode: 'send', ref: `snd-${i}` })))
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
    expect(await dbx.get('SELECT COUNT(*) AS n FROM approvals WHERE used_at IS NOT NULL')).toEqual({ n: 1 })
  })
})

// Every statement of a transaction body must run on the tx handle. A statement on the facade (dbx) would join the
// open transaction on SQLite by accident (one connection) and run OUTSIDE it on a pooled backend.
describe('the statements of a transaction body go through the tx handle, not the facade', () => {
  function spyFacade() {
    const seen: string[] = []
    for (const m of ['get', 'run', 'all'] as const) {
      const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
      vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => { seen.push(sql.trim().slice(0, 60)); return real(sql, ...a) }) as never)
    }
    return seen
  }

  it('consume by id', async () => {
    const id = await approved()
    const seen = spyFacade()
    expect((await consumeApproval({ ...p, id, ref: 'r' })).ok).toBe(true)
    expect(seen).toEqual([])
  })

  it('claim', async () => {
    await approved()
    const seen = spyFacade()
    expect((await claimApproval({ ...p, category: 'email_send', ref: 'c' })).ok).toBe(true)
    expect(seen).toEqual([])
  })

  it('claim send: the adoption of the gate reservation', async () => {
    await approved()
    expect((await claimApproval({ ...p, category: 'email_send', ref: 'gate-send-1' })).ok).toBe(true)
    const seen = spyFacade()
    const out = await claimApproval({ ...p, category: 'email_send', mode: 'send', ref: 'snd-1' })
    expect(out.ok && out.adopted).toBe(true)
    expect(seen).toEqual([])
  })

  it('open-once: a new request and the deduplicated answer (its journal row is the one statement allowed outside)', async () => {
    const params = { id: 'oo-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default', human_only: true, content_hash: HASH, max_pending: 5 }
    const seen1 = spyFacade()
    expect((await createApprovalOnce(params)).ok).toBe(true)
    expect(seen1).toEqual([])
    vi.restoreAllMocks()
    const seen2 = spyFacade()
    const again = await createApprovalOnce({ ...params, id: 'oo-2' })
    expect(again.ok && again.deduplicated).toBe(true)
    expect(seen2.filter((s) => !/INSERT INTO approval_events/.test(s))).toEqual([])
  })
})

// Open-once under the max_pending limit. A create counts the pending rows and then inserts: a second create that counts in
// between would see the same free slot. On PostgreSQL the advisory lock of (agent, tenant, category) queues the creates, so
// the count and the insert of one create are never split by another.
const pendingCount = async (): Promise<number> =>
  Number((await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = 'agent-a' AND category = 'email_send' AND status = 'pending'"))?.n)
const openOnce = (n: number, max: number) => createApprovalOnce({
  id: `oo-${n}`, agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default', human_only: true,
  content_hash: String(n + 1).padStart(64, '0'), max_pending: max,
})

// Bounded: returns when the create has settled, or when it waits on a lock (the first create holds it).
async function settledOrBlocked(state: { settled: boolean }): Promise<void> {
  for (let i = 0; i < 200 && !state.settled; i++) {
    const waits = Number((await dbx.get<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    ))?.c)
    if (waits >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Parks the transaction before its first statement that matches, so the test can start a second create in between.
function parkBefore(match: RegExp, il: ReturnType<typeof interleave>, name: string) {
  const real = dbx.tx.bind(dbx) as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>
  let parked = false
  return vi.spyOn(dbx, 'tx').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
    real((tx) => {
      const target = tx as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      const wrapped = new Proxy(target, {
        get(obj, key) {
          if (key === 'get' || key === 'run' || key === 'all') {
            return async (sql: string, ...params: unknown[]) => {
              if (!parked && match.test(sql)) {
                parked = true
                await il.pass(name)
              }
              return Reflect.apply(obj[key], obj, [sql, ...params])
            }
          }
          const value = Reflect.get(obj, key, obj)
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value
        },
      })
      return fn(wrapped)
    }, opts)) as never)
}

describe('open-once under the max_pending limit: overlapping creates', () => {
  it('six creates at once against a limit of two: exactly two are created, four are refused, two are pending', async () => {
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => openOnce(i, 2)))
    expect(out.filter((o) => o.ok && !o.deduplicated)).toHaveLength(2)
    expect(out.filter((o) => !o.ok && o.reason === 'too_many_pending')).toHaveLength(4)
    expect(await pendingCount()).toBe(2)
  })

  it.runIf(testDbMode() === 'pg')('a second create that starts while the first sits between its count and its insert waits for it: one pending row at a limit of one (PostgreSQL)', async () => {
    const il = interleave()
    il.hold('first-insert')
    const spy = parkBefore(/INSERT INTO approvals/, il, 'first-insert')
    const first = openOnce(0, 1)
    await il.reached('first-insert')
    const second = openOnce(1, 1)
    const state = { settled: false }
    second.then(() => { state.settled = true }, () => { state.settled = true })
    await settledOrBlocked(state)
    il.open('first-insert')
    const [a, b] = await Promise.all([first, second])
    spy.mockRestore()
    expect([a, b].filter((o) => o.ok)).toHaveLength(1)
    expect(await pendingCount()).toBe(1)
  })
})

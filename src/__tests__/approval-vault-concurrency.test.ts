// The approval is used up EXACTLY once under concurrent callers, whichever door they use, and the statements of a
// transaction body run on the tx handle (not on the facade): on a pooled backend a facade statement would run OUTSIDE
// the transaction, on SQLite it only joins it by accident (one connection).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db, dbx, createApproval, resolveApproval, consumeApproval, claimApproval, createApprovalOnce } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()
beforeEach(() => { db.exec('DELETE FROM approval_events; DELETE FROM approvals') })

afterEach(() => { vi.restoreAllMocks() })

const HASH = 'a'.repeat(64)
const WINDOW = 1800
const NOW = 2_000_000_000
let seq = 0

async function approved(): Promise<string> {
  const id = `qa-${++seq}`
  await createApproval({ id, agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default', human_only: true, content_hash: HASH })
  expect(await resolveApproval(id, 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
  db.prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(NOW - 10, id)
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
    expect(db.prepare("SELECT COUNT(*) AS n FROM approval_events WHERE event = 'consumed'").get()).toEqual({ n: 1 })
  })

  it('consume by id with the SAME ref: one consumed, the rest replayed', async () => {
    const id = await approved()
    const out = await Promise.all(Array.from({ length: N }, () => consumeApproval({ ...p, id, ref: 'same' })))
    expect(out.every((o) => o.ok)).toBe(true)
    expect(out.filter((o) => o.ok && !o.replayed)).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM approval_events WHERE event = 'consumed'").get()).toEqual({ n: 1 })
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
    expect(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE used_at IS NOT NULL").get()).toEqual({ n: 1 })
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

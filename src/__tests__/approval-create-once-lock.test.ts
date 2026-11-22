// createApprovalOnce under concurrency (db/vault.ts, the per-(agent, tenant, category) advisory lock): two creates with one
// key must not both insert. A holder transaction keeps the key and waits on the interleave gate; the two creates queue behind
// it (PostgreSQL: seen in pg_stat_activity; SQLite: the connection lock). Afterwards one row exists (same hash: the second is
// deduplicated) or the limit holds (different hashes, max_pending 1: the second is refused).
//
// Privacy: neutral fixtures only (agent-a, email_send).

import { describe, expect, it } from 'vitest'
import { advisoryKeyOf, advisoryLockKeyed } from '../db/dialect.js'
import { createApprovalOnce } from '../db/vault.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** Holds the create key of (agent-a, default, email_send) until the gate opens, as the creates of that key take it. */
function holdCreateKey(il: ReturnType<typeof interleave>, point: string): Promise<void> {
  return dbx.tx(async (tx) => {
    const lock = advisoryLockKeyed('approval:', advisoryKeyOf('agent-a', 'default', 'email_send'), testDbMode())
    if (lock) await tx.run(lock.sql, ...lock.params)
    await il.pass(point)
  })
}

// The scope of the count and of the dedup (one tenant, one category, a live deadline): each row below is a pending row that
// must NOT count against the limit or dedup the create of agent-a in the default tenant and email_send.
describe('create once: the scope of the count and of the dedup', () => {
  it('a pending row of another tenant does not count against the limit', async () => {
    expect((await createApprovalOnce({ id: 'ap-other-tenant', agent_id: 'agent-a', tenant_id: 'other', category: 'email_send', action_description: 'x', content_hash: HASH_B, human_only: true, max_pending: 10 })).ok).toBe(true)
    const r = await createApprovalOnce({ id: 'ap-scope-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 1 })
    expect(r.ok).toBe(true)
  })

  it('a pending row of another tenant with the same hash does not dedup the create', async () => {
    await createApprovalOnce({ id: 'ap-other-hash', agent_id: 'agent-a', tenant_id: 'other', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 10 })
    const r = await createApprovalOnce({ id: 'ap-scope-2', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 10 })
    expect(r).toMatchObject({ ok: true, deduplicated: false })
  })

  it('a pending row of another category does not count against the limit', async () => {
    expect((await createApprovalOnce({ id: 'ap-other-cat', agent_id: 'agent-a', category: 'other_cat', action_description: 'x', content_hash: HASH_B, human_only: true, max_pending: 10 })).ok).toBe(true)
    const r = await createApprovalOnce({ id: 'ap-scope-3', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 1 })
    expect(r.ok).toBe(true)
  })

  it('an expired pending row does not count against the limit', async () => {
    await createApprovalOnce({ id: 'ap-expired', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_B, human_only: true, max_pending: 10 })
    await dbx.run("UPDATE approvals SET timeout_at = ? WHERE id = 'ap-expired'", Math.floor(Date.now() / 1000) - 100)
    const r = await createApprovalOnce({ id: 'ap-scope-4', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 1 })
    expect(r.ok).toBe(true)
  })
})

describe('create once: two creates with one key', () => {
  it('the same hash twice gives one approval, and the second one is deduplicated', async () => {
    const il = interleave()
    il.hold('create-key-held')
    const holder = holdCreateKey(il, 'create-key-held')
    await il.reached('create-key-held')
    const c1 = createApprovalOnce({ id: 'ap-1', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 10 })
    const c2 = createApprovalOnce({ id: 'ap-2', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 10 })
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('create-key-held')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([c1, c2])
    await holder
    const deduplicated = [r1, r2].map((r) => (r.ok && r.deduplicated ? 'dedup' : r.ok ? 'created' : r.reason)).sort()
    expect(deduplicated).toEqual(['created', 'dedup'])
    const rows = await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = 'agent-a' AND content_hash = ?", HASH_A)
    expect(rows?.n).toBe(1)
  })

  it('different hashes with a limit of one: one is created, the other is refused as too many pending', async () => {
    const il = interleave()
    il.hold('create-key-held-2')
    const holder = holdCreateKey(il, 'create-key-held-2')
    await il.reached('create-key-held-2')
    const c1 = createApprovalOnce({ id: 'ap-3', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_A, human_only: true, max_pending: 1 })
    const c2 = createApprovalOnce({ id: 'ap-4', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH_B, human_only: true, max_pending: 1 })
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('create-key-held-2')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([c1, c2])
    await holder
    const outcomes = [r1, r2].map((r) => (r.ok ? 'created' : r.reason)).sort()
    expect(outcomes).toEqual(['created', 'too_many_pending'])
  })
})

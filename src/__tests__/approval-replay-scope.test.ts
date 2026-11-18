// The same-ref replay is for the owner's own claim only (db/vault.ts findSameRefClaim): a row consumed by another principal, with
// another ref, in another tenant or category, or outside the replay window, is never answered as a replay. The early read of a
// claim and the re-read after a lost race (PostgreSQL) use the same helper. A send claim never takes the re-read.
//
// Privacy: neutral fixtures only (agent-a, agent-b, email_send, default, other).

import { describe, expect, it } from 'vitest'
import { claimApproval, createApprovalOnce } from '../db/vault.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const HASH = 'd'.repeat(64)
const NOW = Math.floor(Date.now() / 1000)
const REF = 'retry-ref-1'
const FAR_PAST = 10_000_000 // seconds: far outside any replay window

let seq = 0

/** An approved, unconsumed approval of agent-a in the given tenant and category. */
async function approvedRow(tenant = 'default', category = 'email_send'): Promise<string> {
  const id = `ap-scope-${++seq}`
  const c = await createApprovalOnce({ id, agent_id: 'agent-a', tenant_id: tenant, category, action_description: 'x', content_hash: HASH, human_only: true, max_pending: 10 })
  if (!c.ok) throw new Error('fixture: the approval was not created')
  await dbx.run("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_via = 'dashboard_session' WHERE id = ?", NOW - 10, id)
  return id
}

async function stamp(id: string, consumedBy: string, consumedRef: string, consumedAt: number): Promise<void> {
  await dbx.run('UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = ?', consumedAt, consumedBy, consumedRef, id)
}

function claim(tenant: string, category: string, ref: string, mode?: 'send'): Promise<{ ok: boolean; replayed?: boolean }> {
  return claimApproval({ principal: 'agent-a', tenant_id: tenant, category, content_hash: HASH, window_s: 3600, ref, now: NOW, ...(mode ? { mode } : {}) } as never) as never
}

describe('replay scope: the early read of a claim', () => {
  it('a row consumed by another principal with this ref is not a replay', async () => {
    const id = await approvedRow()
    await stamp(id, 'agent-b', REF, NOW)
    expect((await claim('default', 'email_send', REF)).replayed).not.toBe(true)
  })

  it('a row consumed by this principal with another ref is not a replay', async () => {
    const id = await approvedRow()
    await stamp(id, 'agent-a', 'other-ref', NOW)
    expect((await claim('default', 'email_send', REF)).replayed).not.toBe(true)
  })

  it('a row of another tenant is not a replay', async () => {
    const id = await approvedRow('other')
    await stamp(id, 'agent-a', REF, NOW)
    expect((await claim('default', 'email_send', REF)).replayed).not.toBe(true)
  })

  it('a row of another category is not a replay', async () => {
    const id = await approvedRow('default', 'other_cat')
    await stamp(id, 'agent-a', REF, NOW)
    expect((await claim('default', 'email_send', REF)).replayed).not.toBe(true)
  })

  it('a claim outside the replay window is not a replay', async () => {
    const id = await approvedRow()
    await stamp(id, 'agent-a', REF, NOW - FAR_PAST)
    expect((await claim('default', 'email_send', REF)).replayed).not.toBe(true)
  })
})

describe('replay scope: the re-read after a lost race (PostgreSQL)', () => {
  // A holder stamps the row (uncommitted), the claim under test waits on it, the holder commits, and the claim's guarded use-up
  // changes nothing: the answer comes from the re-read on that transaction.
  async function raced(stampBy: string, stampRef: string, mode?: 'send') {
    const id = await approvedRow()
    const il = interleave()
    il.hold('first-claim-in-flight')
    const first = dbx.tx(async (tx) => {
      await tx.run('UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = ?', NOW, stampBy, stampRef, id)
      await il.pass('first-claim-in-flight')
    })
    await il.reached('first-claim-in-flight')
    const retry = claim('default', 'email_send', REF, mode)
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-claim-in-flight')
      await Promise.allSettled([first])
    }
    const result = await retry
    await first
    return result
  }

  it.runIf(testDbMode() === 'pg')('a row consumed by another principal with this ref is not a replay', async () => {
    expect((await raced('agent-b', REF)).replayed).not.toBe(true)
  })

  it.runIf(testDbMode() === 'pg')('a row consumed by this principal with another ref is not a replay', async () => {
    expect((await raced('agent-a', 'other-ref')).replayed).not.toBe(true)
  })

  it.runIf(testDbMode() === 'pg')('a send claim never takes the re-read: the same-ref row it finds is not a replay', async () => {
    expect((await raced('agent-a', REF, 'send')).replayed).not.toBe(true)
  })
})

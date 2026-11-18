// The guarded use-up of an approval under a real race (db/vault.ts consumeApproval, and the seal variant of claimApproval in send
// mode): a holder transaction stands for a first use that is in flight (the same stamps the use writes, not committed). The
// second use waits on the row (PostgreSQL: seen in pg_stat_activity, interleave helper, no timing). When the first use commits,
// the second must not use the approval again: a different ref is refused as already consumed.
//
// Privacy: neutral fixtures only (agent-a, email_send, default).

import { describe, expect, it } from 'vitest'
import { claimApproval, consumeApproval, createApprovalOnce } from '../db/vault.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const HASH = 'e'.repeat(64)
const NOW = Math.floor(Date.now() / 1000)

/** An approved, unconsumed approval of agent-a in the default tenant. */
async function approvedRow(id: string): Promise<void> {
  const c = await createApprovalOnce({ id, agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, max_pending: 10 })
  if (!c.ok) throw new Error('fixture: the approval was not created')
  await dbx.run("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_via = 'dashboard_session' WHERE id = ?", NOW - 10, id)
}

describe('approval use under a race: the second use after a first use in flight', () => {
  it('consume by id: a different ref after the first use committed is refused as already consumed', async () => {
    await approvedRow('ap-race-consume')
    const il = interleave()
    il.hold('first-use-in-flight')
    const first = dbx.tx(async (tx) => {
      await tx.run('UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = ? AND consumed_at IS NULL', NOW, 'agent-a', 'ref-a', 'ap-race-consume')
      await il.pass('first-use-in-flight')
    })
    await il.reached('first-use-in-flight')
    const second = consumeApproval({ id: 'ap-race-consume', principal: 'agent-a', tenant_id: 'default', content_hash: HASH, window_s: 3600, ref: 'ref-b', now: NOW })
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-use-in-flight')
      await Promise.allSettled([first])
    }
    const result = await second
    await first
    expect(result).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('adoption of a gate reservation: after the first adoption committed, a second send claim does not adopt it again', async () => {
    await approvedRow('ap-race-adopt')
    // the gate's reservation for the official sender: consumed by agent-a under a gate-send ref, not yet sealed
    await dbx.run("UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = 'ap-race-adopt'", NOW, 'agent-a', 'gate-send-1')
    const il = interleave()
    il.hold('first-adoption-in-flight')
    const first = dbx.tx(async (tx) => {
      await tx.run('UPDATE approvals SET used_at = ?, used_ref = ? WHERE id = ? AND used_at IS NULL', NOW, 'send-x', 'ap-race-adopt')
      await il.pass('first-adoption-in-flight')
    })
    await il.reached('first-adoption-in-flight')
    const second = claimApproval({ principal: 'agent-a', tenant_id: 'default', category: 'email_send', content_hash: HASH, window_s: 3600, ref: 'send-y', now: NOW, mode: 'send' })
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-adoption-in-flight')
      await Promise.allSettled([first])
    }
    const result = await second
    await first
    expect(result).toMatchObject({ ok: false })
  })

  it('send (seal) claim: after the first use committed, the approval is not sealed a second time', async () => {
    await approvedRow('ap-race-seal')
    const il = interleave()
    il.hold('first-use-in-flight-seal')
    const first = dbx.tx(async (tx) => {
      await tx.run('UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = ? AND consumed_at IS NULL', NOW, 'agent-a', 'ref-a', 'ap-race-seal')
      await il.pass('first-use-in-flight-seal')
    })
    await il.reached('first-use-in-flight-seal')
    const second = claimApproval({ principal: 'agent-a', tenant_id: 'default', category: 'email_send', content_hash: HASH, window_s: 3600, ref: 'send-ref-b', now: NOW, mode: 'send' })
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-use-in-flight-seal')
      await Promise.allSettled([first])
    }
    const result = await second
    await first
    expect(result).toMatchObject({ ok: false })
  })
})

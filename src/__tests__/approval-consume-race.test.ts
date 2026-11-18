// The guarded use-up of an approval under a real race (db/vault.ts consumeApproval, the seal variant of claimApproval in send
// mode, and the adoption of a gate reservation in adoptReservation): a holder transaction runs the real write and keeps its row
// locked until it commits (PostgreSQL: the second write is seen waiting in pg_stat_activity, interleave helper, no timing). The
// second write re-checks its WHERE on the committed row, so the approval is used up exactly once.
//
// Privacy: neutral fixtures only (agent-a, agent-b, email_send, default).

import { describe, expect, it } from 'vitest'
import { adoptReservation, claimApproval, consumeApproval, createApprovalOnce } from '../db/vault.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const HASH = 'e'.repeat(64)
const NOW = Math.floor(Date.now() / 1000)
const SINCE = NOW - 3600
const ADOPT = { principal: 'agent-a', tenant_id: 'default', content_hash: HASH, category: 'email_send' }

/** An approved, unconsumed approval of agent-a in the default tenant. */
async function approvedRow(id: string): Promise<void> {
  const c = await createApprovalOnce({ id, agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, max_pending: 10 })
  if (!c.ok) throw new Error('fixture: the approval was not created')
  await dbx.run("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_via = 'dashboard_session' WHERE id = ?", NOW - 10, id)
}

/** The gate's reservation for the official sender: consumed by `by` under a gate-send ref, not yet sealed. */
async function reservedRow(id: string, by: string, resolvedVia = 'dashboard_session'): Promise<void> {
  await approvedRow(id)
  await dbx.run("UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = 'gate-send-1', resolved_via = ? WHERE id = ?", NOW, by, resolvedVia, id)
}

describe('approval use under a race: the second write after a first write in flight', () => {
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

  it('adoption of a gate reservation: the holder adopts it, the second adoption waits and adopts nothing (exactly one)', async () => {
    await reservedRow('ap-race-adopt', 'agent-a')
    const il = interleave()
    il.hold('first-adoption-in-flight')
    // the holder runs the real adoption write, inside its own transaction, and keeps the row locked until it commits
    const first = dbx.tx(async (tx) => {
      const adopted = await adoptReservation('ap-race-adopt', ADOPT, SINCE, NOW, 'send-x', tx)
      await il.pass('first-adoption-in-flight')
      return adopted
    })
    await il.reached('first-adoption-in-flight')
    const second = claimApproval({ ...ADOPT, window_s: 3600, ref: 'send-y', now: NOW, mode: 'send' })
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-adoption-in-flight')
    }
    const firstAdopted = await first
    const result = await second
    expect(firstAdopted).toBe(true)
    expect(result).toMatchObject({ ok: false })
  })

  it('adoption: a reservation consumed by another principal is not adopted (the consumer must be the caller)', async () => {
    await reservedRow('ap-scope-consumer', 'agent-b')
    expect(await adoptReservation('ap-scope-consumer', ADOPT, SINCE, NOW, 'send-x')).toBe(false)
    const row = await dbx.get<{ used_at: number | null }>('SELECT used_at FROM approvals WHERE id = ?', 'ap-scope-consumer')
    expect(row?.used_at).toBeNull()
  })

  it('adoption: a reservation not resolved on the dashboard is not adopted', async () => {
    await reservedRow('ap-scope-resolved', 'agent-a', 'chat')
    expect(await adoptReservation('ap-scope-resolved', ADOPT, SINCE, NOW, 'send-x')).toBe(false)
    const row = await dbx.get<{ used_at: number | null }>('SELECT used_at FROM approvals WHERE id = ?', 'ap-scope-resolved')
    expect(row?.used_at).toBeNull()
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

// A same-ref retry of a claim whose first claim is still in flight (db/vault.ts claimApproval, A2). The first claim has taken
// the approval row (a holder transaction stands for it, with the same stamps the claim writes) and has not committed. The retry
// reads nothing yet, then its guarded write waits on the row (PostgreSQL: seen in pg_stat_activity, interleave helper, no
// timing). When the first claim commits, the retry must answer as the replay of that claim, not as already_consumed.
//
// Privacy: neutral fixtures only (agent-a, email_send, default).

import { describe, expect, it } from 'vitest'
import { createApprovalOnce, claimApproval } from '../db/vault.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const HASH = 'c'.repeat(64)
const NOW = Math.floor(Date.now() / 1000)

describe('claim replay: the retry of a claim that is still in flight', () => {
  it('answers as the replay of the first claim, once that claim has committed', async () => {
    const created = await createApprovalOnce({ id: 'ap-replay', agent_id: 'agent-a', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, max_pending: 10 })
    if (!created.ok) throw new Error('fixture: the approval was not created')
    await dbx.run("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_via = 'dashboard_session' WHERE id = 'ap-replay'", NOW - 10)
    const il = interleave()
    il.hold('first-claim-in-flight')
    const first = dbx.tx(async (tx) => {
      // the stamps the first claim writes, held until its commit
      await tx.run('UPDATE approvals SET consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = ? AND consumed_at IS NULL', NOW, 'agent-a', 'retry-ref-1', 'ap-replay')
      await il.pass('first-claim-in-flight')
    })
    await il.reached('first-claim-in-flight')
    const retry = claimApproval({ principal: 'agent-a', tenant_id: 'default', category: 'email_send', content_hash: HASH, window_s: 3600, ref: 'retry-ref-1', now: NOW })
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-claim-in-flight')
      await Promise.allSettled([first])
    }
    const result = await retry
    await first
    expect(result).toMatchObject({ ok: true, replayed: true })
  })
})

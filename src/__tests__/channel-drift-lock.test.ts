// Two drift checks of one channel at once (db/channel-credentials.ts recordChannelDriftCheck): exactly one of them starts the
// drift episode (one alarm). A holder transaction keeps the baseline row locked; the two checks queue behind it (PostgreSQL:
// seen in pg_stat_activity, interleave helper, no timing; SQLite: the connection lock). The second check then reads the
// first one's new state.
//
// Privacy: neutral fixtures only (agent-a, telegram, default).

import { describe, expect, it } from 'vitest'
import { forUpdate } from '../db/dialect.js'
import { recordChannelDriftCheck } from '../db/channel-credentials.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

describe('channel drift check: two checks of one channel', () => {
  it('exactly one of them starts the drift episode', async () => {
    await dbx.run("INSERT INTO channel_credential_baseline (agent_id, provider, token_sha256, allow_sha256, adopted_by, tenant_id) VALUES ('agent-a', 'telegram', 'h1', 'h2', 'owner', 'default')")
    const il = interleave()
    il.hold('baseline-locked')
    const holder = dbx.tx(async (tx) => {
      await tx.get(`SELECT drift_state FROM channel_credential_baseline WHERE tenant_id = ? AND agent_id = ? AND provider = ? ${forUpdate()}`, 'default', 'agent-a', 'telegram')
      await il.pass('baseline-locked')
    })
    await il.reached('baseline-locked')
    const c1 = recordChannelDriftCheck('agent-a', 'telegram', 'token', 1000, 'default')
    const c2 = recordChannelDriftCheck('agent-a', 'telegram', 'token', 1001, 'default')
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('baseline-locked')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([c1, c2])
    await holder
    expect([r1, r2].sort()).toEqual([false, true])
  })
})

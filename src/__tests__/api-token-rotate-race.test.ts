// Two rotations of one API token under a real race (db/api-tokens.ts rotateApiToken): a holder transaction runs the real
// rotation of the token and keeps its row locked until it commits (PostgreSQL: the second rotation is seen waiting in
// pg_stat_activity, interleave helper, no timing). The second rotation re-checks the revoke on the committed row: it must
// reject as already revoked, and exactly one replacement may stay active.
//
// Privacy: neutral fixtures only (agent-x, agent-a, default tenant).

import { describe, expect, it } from 'vitest'
import { ApiTokenAlreadyRevokedError, dbx, insertApiToken, listActiveApiTokensByName, rotateApiToken, type ApiTokenRow } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

useTestDb()

const NOW = 1_800_000_000

async function activeToken(name: string, hash: string): Promise<ApiTokenRow> {
  return await insertApiToken({ tokenHash: hash, name, role: 'fleet_agent', tenantId: 'default', createdAt: NOW - 100, expiresAt: null, agentId: 'agent-a' })
}

describe('API token rotation under a race: two rotations of one token', () => {
  it('the second rotation of a token the first one is rotating rejects, and exactly one replacement stays active', async () => {
    const old = await activeToken('agent-x', 'hash-old-race')
    const il = interleave()
    il.hold('first-rotation-in-flight')
    // the holder runs the real rotation and keeps the old row locked until its transaction commits
    const first = dbx.tx(async (tx) => {
      const row = await rotateApiToken(old, 'hash-new-first', NOW, null, tx)
      await il.pass('first-rotation-in-flight')
      return row
    })
    await il.reached('first-rotation-in-flight')
    const second = rotateApiToken(old, 'hash-new-second', NOW, null, dbx).then(() => 'rotated', (e: unknown) => e)
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-rotation-in-flight')
    }
    const firstRow = await first
    const outcome = await second
    expect(outcome).toBeInstanceOf(ApiTokenAlreadyRevokedError)
    expect((outcome as ApiTokenAlreadyRevokedError).tokenId).toBe(old.id)
    const active = await listActiveApiTokensByName('agent-x', NOW)
    expect(active.map((r) => r.id)).toEqual([firstRow.id])
    expect(active[0]?.rotated_from).toBe(old.id)
  })
})
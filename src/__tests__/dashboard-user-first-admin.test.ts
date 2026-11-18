// The first-admin election (sessions.ts createDashboardUser) under concurrency: two sign-ups on an empty table must not
// both become admin. The election takes one advisory lock first, on its own transaction. A holder transaction takes the
// same lock and waits on the interleave gate, so the two sign-ups queue behind it (PostgreSQL: seen in pg_stat_activity;
// SQLite: the connection lock). Tenant-scoped provisioning does not take the election lock and must not wait for it.
//
// Privacy: neutral fixtures only (user-a, user-b, user-c, tenant-a).

import { describe, expect, it } from 'vitest'
import { advisoryLockSql } from '../db/dialect.js'
import { provisionDashboardUser } from '../db/observability.js'
import { ELECTION_KEY, createDashboardUser } from '../db/sessions.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

/** Takes the election lock on its own transaction and holds it until the gate opens. */
function holdElection(il: ReturnType<typeof interleave>, point: string): Promise<void> {
  return dbx.tx(async (tx) => {
    const lock = advisoryLockSql(ELECTION_KEY)
    if (lock) await tx.run(lock)
    await il.pass(point)
  })
}

describe('first admin: two sign-ups on an empty table', () => {
  it('give one admin and one viewer', async () => {
    const il = interleave()
    il.hold('election-held')
    const holder = holdElection(il, 'election-held')
    await il.reached('election-held')
    const s1 = createDashboardUser('user-a', 'h')
    const s2 = createDashboardUser('user-b', 'h')
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('election-held')
    }
    const [u1, u2] = await Promise.all([s1, s2])
    await holder
    expect([u1.role, u2.role].sort()).toEqual(['admin', 'viewer'])
  })
})

describe('first admin: tenant provisioning is not blocked by the election', () => {
  it.runIf(testDbMode() === 'pg')('a tenant-scoped user is written while the election is held', async () => {
    const il = interleave()
    il.hold('election-held-2')
    const holder = holdElection(il, 'election-held-2')
    await il.reached('election-held-2')
    // no wait: the provisioning insert takes no election lock, and the holder holds only that lock
    const user = await provisionDashboardUser('user-c', 'h', 'viewer', 'tenant-a')
    il.open('election-held-2')
    await holder
    expect(user.tenant_id).toBe('tenant-a')
  })
})

describe('first admin: a tenant admin provisioned first', () => {
  it('makes the first global sign-up a viewer', async () => {
    await provisionDashboardUser('user-c', 'h', 'admin', 'tenant-a')
    const u = await createDashboardUser('user-a', 'h')
    expect(u.role).toBe('viewer')
  })
})

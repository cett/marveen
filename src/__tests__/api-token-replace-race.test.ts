// Replacing the active API token of one name under concurrency (db/api-tokens.ts replaceActiveApiToken and
// rotateSharedDashboardToken): the documented invariant is exactly one active row per name. SQLite keeps it with the write
// lock of BEGIN IMMEDIATE; PostgreSQL needs the per-name advisory lock (apitoken: key) taken FIRST in the transaction, before
// the listing. Without it two calls on a name with no active row both insert one, and two tokens are active.
//
// Privacy: neutral fixtures only (agent-x, agent-y, default tenant).

import { describe, expect, it } from 'vitest'
import { dbx, insertApiToken, listActiveApiTokensByName, replaceActiveApiToken, revokeApiToken, rotateSharedDashboardToken, getApiTokenRowById, lockApiTokenName } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

useTestDb()

const NOW = 1_800_000_000

const replace = (name: string, tokenHash: string) =>
  replaceActiveApiToken({ fileHash: null, tokenHash, name, role: 'fleet_agent', agentId: 'agent-a', now: NOW })

/** The holder takes the production name lock (the same helper the replacement paths call first). */
const holdNameLock = lockApiTokenName

describe('API token replacement under a race: one active token per name', () => {
  it('two replacements of a name with no active token wait for the holder, then exactly one token is active', async () => {
    const il = interleave()
    il.hold('name-lock-held')
    const holder = dbx.tx(async (tx) => {
      await holdNameLock(tx, 'agent-x')
      await il.pass('name-lock-held')
    })
    await il.reached('name-lock-held')
    const a = replace('agent-x', 'hash-race-a')
    const b = replace('agent-x', 'hash-race-b')
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('name-lock-held')
    }
    await holder
    const outcomes = await Promise.allSettled([a, b])
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true)
    expect((await listActiveApiTokensByName('agent-x', NOW)).length).toBe(1)
  })

  it('the shared dashboard rotation waits for the same name lock: exactly one active dashboard token', async () => {
    const il = interleave()
    il.hold('dashboard-lock-held')
    const holder = dbx.tx(async (tx) => {
      await holdNameLock(tx, 'dashboard')
      await il.pass('dashboard-lock-held')
    })
    await il.reached('dashboard-lock-held')
    const a = rotateSharedDashboardToken('hash-dash-a', NOW)
    const b = rotateSharedDashboardToken('hash-dash-b', NOW)
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('dashboard-lock-held')
    }
    await holder
    await Promise.allSettled([a, b])
    expect((await listActiveApiTokensByName('dashboard', NOW)).length).toBe(1)
  })

  it('concurrent pairs on eight names with no active token: each name ends with exactly one active token', async () => {
    const counts: number[] = []
    for (let i = 0; i < 8; i++) {
      const name = `pair-${i}`
      await Promise.all([replace(name, `pair-${i}-a`), replace(name, `pair-${i}-b`)])
      counts.push((await listActiveApiTokensByName(name, NOW)).length)
    }
    expect(counts, 'active tokens per name').toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })

  const pgOnly = testDbMode() === 'pg' ? it : it.skip
  pgOnly('a name lock does not block another name: a replacement of agent-y completes while agent-x is held', async () => {
    const il = interleave()
    il.hold('x-lock-held')
    const holder = dbx.tx(async (tx) => {
      await holdNameLock(tx, 'agent-x')
      await il.pass('x-lock-held')
    })
    await il.reached('x-lock-held')
    const other = replace('agent-y', 'hash-other')
    const outcome = await Promise.race([other.then(() => 'done'), new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 3000))])
    il.open('x-lock-held')
    await holder
    await other
    expect(outcome).toBe('done')
  })

  it('a revoke of a token already revoked keeps the first revoke time (the stale path cannot overwrite it)', async () => {
    const row = await insertApiToken({ tokenHash: 'hash-revoke-once', name: 'agent-x', role: 'fleet_agent', tenantId: 'default', createdAt: NOW - 100, expiresAt: null, agentId: 'agent-a' })
    await revokeApiToken(row.id, NOW - 50)
    await revokeApiToken(row.id, NOW)
    expect((await getApiTokenRowById(row.id))?.revoked_at).toBe(NOW - 50)
  })
})

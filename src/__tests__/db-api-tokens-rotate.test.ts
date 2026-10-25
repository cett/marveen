// rotateApiToken is a read-modify-write on one row: revoke the old token, insert its replacement. The revoke
// used to be unconditional, so two rotations of the SAME token both succeeded and left two active replacements
// (nobody could tell which one the caller kept). The revoke is now conditional on the token still being active,
// and a rotation that finds it already revoked fails and rolls back, so exactly one replacement can exist.
import { describe, it, expect, vi } from 'vitest'
import {
  ApiTokenAlreadyRevokedError,
  dbx,
  getApiTokenRowById,
  insertApiToken,
  listActiveApiTokensByName,
  replaceActiveApiToken,
  revokeApiToken,
  rotateApiToken,
  rotateSharedDashboardToken,
  getDb,
} from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const NOW = 1_800_000_000

const mint = (name: string, hash: string, role = 'fleet_agent') =>
  insertApiToken({ tokenHash: hash, name, role, tenantId: 'default', createdAt: NOW - 100, expiresAt: null, agentId: name === 'dashboard' ? null : 'agent-a' })

const count = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n
const activeHashes = async (name: string): Promise<string[]> => (await listActiveApiTokensByName(name, NOW)).map((r) => r.token_hash).sort()

describe('rotateApiToken', () => {
  it('two rotations of the same token started together: exactly one wins, one replacement stays active', async () => {
    const old = await mint('t-race', 'old-hash')
    const results = await Promise.allSettled([
      rotateApiToken(old, 'new-hash-1', NOW, null),
      rotateApiToken(old, 'new-hash-2', NOW, null),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(loser.reason).toBeInstanceOf(ApiTokenAlreadyRevokedError)

    const winner = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof rotateApiToken>>> => r.status === 'fulfilled')!
    expect(await activeHashes('t-race')).toEqual([winner.value.token_hash])
    // The loser's replacement was rolled back with its revoke: its hash is nowhere in the table.
    const hashes = (getDb().prepare('SELECT token_hash FROM api_tokens').all() as { token_hash: string }[]).map((r) => r.token_hash)
    expect(hashes.filter((h) => h.startsWith('new-hash'))).toEqual([winner.value.token_hash])
  })

  it('a token that is already revoked is not rotated, and no replacement row is written', async () => {
    const old = await mint('t-revoked', 'old-hash')
    await revokeApiToken(old.id, NOW - 10)
    const before = count()
    await expect(rotateApiToken(old, 'new-hash', NOW, null)).rejects.toBeInstanceOf(ApiTokenAlreadyRevokedError)
    expect(count()).toBe(before)
    // The revoke time is the first one: the failed rotation did not move it.
    expect((await getApiTokenRowById(old.id))?.revoked_at).toBe(NOW - 10)
  })

  it('an active token is rotated: the old row is revoked with its hash kept, the new one points back at it', async () => {
    const old = await mint('t-ok', 'old-hash')
    const next = await rotateApiToken(old, 'new-hash', NOW, null)
    expect(next).toMatchObject({ token_hash: 'new-hash', rotated_from: old.id, name: 't-ok', agent_id: 'agent-a' })
    expect(await getApiTokenRowById(old.id)).toMatchObject({ token_hash: 'old-hash', revoked_at: NOW })
  })
})

// replaceActiveApiToken reads the active rows INSIDE its transaction, so a row that another caller revoked
// after the file was read is simply no longer "current": the call still ends with exactly one active row.
describe('replaceActiveApiToken', () => {
  const replace = (fileHash: string | null, tokenHash: string, name = 't-replace') =>
    replaceActiveApiToken({ fileHash, tokenHash, name, role: 'fleet_agent', agentId: 'agent-a', now: NOW })

  it('rotates the row the file held and revokes every other active row of the name', async () => {
    const current = await mint('t-replace', 'current-hash')
    await mint('t-replace', 'stale-hash')
    await mint('t-other', 'other-hash')

    const { row, rotated } = await replace('current-hash', 'new-hash')

    expect(rotated).toBe(true)
    expect(row).toMatchObject({ token_hash: 'new-hash', rotated_from: current.id })
    expect(await activeHashes('t-replace')).toEqual(['new-hash'])
    expect(await activeHashes('t-other')).toEqual(['other-hash'])
  })

  it('without a matching row revokes everything active under the name and mints a fresh row', async () => {
    await mint('t-replace', 'a-hash')
    await mint('t-replace', 'b-hash')

    const { row, rotated } = await replace('not-active-hash', 'new-hash')

    expect(rotated).toBe(false)
    expect(row.rotated_from).toBeNull()
    expect(await activeHashes('t-replace')).toEqual(['new-hash'])
  })

  it('a file row that was revoked meanwhile is not rotated again: a fresh row, one active', async () => {
    const current = await mint('t-replace', 'current-hash')
    await revokeApiToken(current.id, NOW - 5) // another caller rotated or revoked it first

    const { rotated } = await replace('current-hash', 'new-hash')

    expect(rotated).toBe(false)
    expect(await activeHashes('t-replace')).toEqual(['new-hash'])
  })

  it('two overlapping calls leave exactly one active row, the later commit', async () => {
    await mint('t-replace', 'current-hash')

    await Promise.all([replace('current-hash', 'new-1'), replace('current-hash', 'new-2')])

    const active = await activeHashes('t-replace')
    expect(active).toHaveLength(1)
    expect(['new-1', 'new-2']).toContain(active[0])
  })

  // One connection serializes the callers already (the facade lock), so only the transaction mode tells that a
  // SECOND process (the CLI) takes the write lock at BEGIN, before it reads the active rows.
  it('opens its transaction IMMEDIATE (the read of the active rows happens under the write lock)', async () => {
    await mint('t-replace', 'a-hash')
    const original = dbx.tx.bind(dbx)
    const spy = vi.spyOn(dbx, 'tx').mockImplementation((fn, opts) => original(fn, opts))

    await replace('a-hash', 'new-hash')

    // The first call is the outer transaction; the rotation inside it opens a savepoint (a second call).
    expect(spy.mock.calls[0][1]).toEqual({ mode: 'immediate' })
    spy.mockRestore()
  })

  it('a failed insert rolls the revokes back (nothing is lost half-way)', async () => {
    await mint('t-replace', 'a-hash')
    await mint('t-taken', 'taken-hash') // the new hash collides with an existing row: UNIQUE(token_hash)

    await expect(replace(null, 'taken-hash')).rejects.toThrow()

    expect(await activeHashes('t-replace')).toEqual(['a-hash'])
  })
})

// rotateSharedDashboardToken runs rotateApiToken inside its own transaction (a SAVEPOINT in the inner one). A
// rotation that fails must roll the WHOLE outer transaction back, not just its own part: the other rows it
// revokes in the same transaction must stay as they were.
describe('rotation nested in a larger transaction', () => {
  it('rotateSharedDashboardToken: a lost rotation leaves the older active rows active', async () => {
    const newest = await mint('dashboard', 'newest-hash', 'admin')
    const older = await mint('dashboard', 'older-hash', 'admin')
    await revokeApiToken(newest.id, NOW - 5)
    const before = count()

    await expect(rotateSharedDashboardToken([newest, older], 'new-hash', NOW)).rejects.toBeInstanceOf(ApiTokenAlreadyRevokedError)

    expect(count()).toBe(before)
    expect(await activeHashes('dashboard')).toEqual(['older-hash'])
  })

  it('the normal rotation still completes (the nesting does not deadlock)', async () => {
    const shared = await mint('dashboard', 'shared-hash', 'admin')
    const sharedNext = await rotateSharedDashboardToken([shared], 'shared-new', NOW)
    expect(await activeHashes('dashboard')).toEqual([sharedNext.token_hash])
  })
})

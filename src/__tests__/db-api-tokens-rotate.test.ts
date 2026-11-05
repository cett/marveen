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

// A token can only carry the id of an existing tenant (insertApiToken checks), so a tenant other than 'default' is made first.
const mint = async (name: string, hash: string, role = 'fleet_agent', createdAt = NOW - 100, expiresAt: number | null = null, tenantId = 'default') => {
  await dbx.run('INSERT OR IGNORE INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)', tenantId, tenantId, createdAt)
  return insertApiToken({ tokenHash: hash, name, role, tenantId, createdAt, expiresAt, agentId: name === 'dashboard' ? null : 'agent-a' })
}

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

  // Every other case here uses 'default', which a replacement that hard-codes the tenant would still match.
  it('the replacement takes name, role, tenant and agent of the row it replaces (a tenant other than default)', async () => {
    const old = await mint('t-fields', 'old-hash', 'viewer', NOW - 100, null, 'other-tenant')
    const next = await rotateApiToken(old, 'new-hash', NOW, null)
    expect(next).toMatchObject({ name: 't-fields', role: 'viewer', tenant_id: 'other-tenant', agent_id: 'agent-a', created_at: NOW, rotated_from: old.id, revoked_at: null })
  })

  it('the replacement gets the expiry the caller passes (a value, and null for none)', async () => {
    const first = await rotateApiToken(await mint('t-exp-a', 'old-a'), 'new-a', NOW, NOW + 500)
    expect(first.expires_at).toBe(NOW + 500)
    const second = await rotateApiToken(await mint('t-exp-b', 'old-b', 'fleet_agent', NOW - 100, NOW + 900), 'new-b', NOW, null)
    expect(second.expires_at).toBeNull()
  })

  it('a failed insert (the new hash is taken) rolls the revoke back: the old row stays active, no row is added', async () => {
    const old = await mint('t-atomic', 'old-hash')
    await mint('t-taken', 'taken-hash') // UNIQUE(token_hash) fails the insert AFTER the revoke has succeeded
    const before = count()
    await expect(rotateApiToken(old, 'taken-hash', NOW, null)).rejects.toThrow()
    expect(count()).toBe(before)
    expect((await getApiTokenRowById(old.id))?.revoked_at).toBeNull()
    expect(await activeHashes('t-atomic')).toEqual(['old-hash'])
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

  it('a fresh row takes the role, agent and tenant of the call, created now, with no expiry', async () => {
    const { row, rotated } = await replaceActiveApiToken({ fileHash: null, tokenHash: 'new-hash', name: 't-replace', role: 'agent', agentId: 'agent-b', now: NOW })
    expect(rotated).toBe(false)
    expect(row).toMatchObject({ name: 't-replace', role: 'agent', agent_id: 'agent-b', tenant_id: 'default', created_at: NOW, expires_at: null, rotated_from: null, revoked_at: null })
  })

  it('a rotated row keeps the role and agent of the row it replaces (not the call\'s) and never expires', async () => {
    const current = await mint('t-replace', 'current-hash', 'fleet_agent', NOW - 100, NOW + 1000) // agent-a
    const { row, rotated } = await replaceActiveApiToken({ fileHash: 'current-hash', tokenHash: 'new-hash', name: 't-replace', role: 'agent', agentId: 'agent-b', now: NOW })
    expect(rotated).toBe(true)
    expect(row).toMatchObject({ role: 'fleet_agent', agent_id: 'agent-a', tenant_id: 'default', created_at: NOW, expires_at: null, rotated_from: current.id })
  })

  it('a rotated row of another tenant than default keeps that tenant', async () => {
    const current = await mint('t-replace', 'current-hash', 'fleet_agent', NOW - 100, null, 'other-tenant')
    const { row, rotated } = await replace('current-hash', 'new-hash')
    expect(rotated).toBe(true)
    expect(row).toMatchObject({ tenant_id: 'other-tenant', rotated_from: current.id })
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
  it('rotateSharedDashboardToken: a rotation that fails leaves every active row active', async () => {
    // Two active rows: the older one is revoked first, then the rotation of the newest fails on the UNIQUE
    // hash of the replacement. The revoke of the older row must roll back with it.
    await mint('dashboard', 'older-hash', 'admin')
    await mint('dashboard', 'newest-hash', 'admin')
    await mint('t-taken', 'taken-hash')
    const before = count()

    await expect(rotateSharedDashboardToken('taken-hash', NOW)).rejects.toThrow()

    expect(count()).toBe(before)
    expect(await activeHashes('dashboard')).toEqual(['newest-hash', 'older-hash'])
  })

  it('the normal rotation still completes (the nesting does not deadlock)', async () => {
    await mint('dashboard', 'shared-hash', 'admin')
    const { row, rotated } = await rotateSharedDashboardToken('shared-new', NOW)
    expect(rotated).toBe(true)
    expect(await activeHashes('dashboard')).toEqual([row.token_hash])
  })

  it('without an active dashboard row it mints one and says it did not rotate', async () => {
    const { row, rotated } = await rotateSharedDashboardToken('first-hash', NOW)
    expect(rotated).toBe(false)
    expect(row.name).toBe('dashboard')
    expect(await activeHashes('dashboard')).toEqual(['first-hash'])
  })

  it('rotates the newest active row and revokes the older one: the rotation takes no list from the caller', async () => {
    // The old shape took the list from the caller. Here the only input is the new hash, so whatever is active when
    // the transaction runs is what gets rotated or revoked. The newest row is the one that rotates: the new row
    // points back at it (rotated_from), the older one is just revoked. The list is newest first (ORDER BY created_at
    // DESC): an ascending list would rotate the oldest row, which only shows in rotated_from.
    const older = await mint('dashboard', 'one-hash', 'admin')
    const newer = await mint('dashboard', 'two-hash', 'admin', NOW - 50)
    const { row, rotated } = await rotateSharedDashboardToken('rot-hash', NOW)
    expect(rotated).toBe(true)
    expect(row.rotated_from).toBe(newer.id)
    expect(await activeHashes('dashboard')).toEqual(['rot-hash'])
    expect((await getApiTokenRowById(older.id))?.revoked_at).toBe(NOW)
    expect((await getApiTokenRowById(newer.id))?.revoked_at).toBe(NOW)
  })

  it('"newest" is by created_at, not by id: a later insert with an earlier created_at is not the newest', async () => {
    const newest = await mint('dashboard', 'newest-hash', 'admin', NOW - 10)
    await mint('dashboard', 'higher-id-hash', 'admin', NOW - 500) // inserted last (higher id), created earlier
    const { row } = await rotateSharedDashboardToken('rot-hash', NOW)
    expect(row.rotated_from).toBe(newest.id)
  })

  it('two rows created in the same second: the higher id is the newest (the tie-break)', async () => {
    await mint('dashboard', 'first-hash', 'admin')
    const second = await mint('dashboard', 'second-hash', 'admin')
    const { row } = await rotateSharedDashboardToken('rot-hash', NOW)
    expect(row.rotated_from).toBe(second.id)
  })

  it('with three or more active rows every one but the rotated row is revoked, and other names are left alone', async () => {
    const ids = [
      (await mint('dashboard', 'a-hash', 'admin', NOW - 400)).id,
      (await mint('dashboard', 'b-hash', 'admin', NOW - 300)).id,
      (await mint('dashboard', 'c-hash', 'admin', NOW - 200)).id,
      (await mint('dashboard', 'd-hash', 'admin', NOW - 100)).id,
    ]
    await mint('t-other', 'other-hash')
    await rotateSharedDashboardToken('rot-hash', NOW)
    expect(await activeHashes('dashboard')).toEqual(['rot-hash'])
    for (const id of ids) expect((await getApiTokenRowById(id))?.revoked_at, `row ${id}`).toBe(NOW)
    expect(await activeHashes('t-other')).toEqual(['other-hash'])
  })

  it('the rotated row keeps the role and tenant of the row it replaces and never expires, whatever the old row did', async () => {
    await mint('dashboard', 'old-hash', 'viewer', NOW - 100, NOW + 1000)
    const { row } = await rotateSharedDashboardToken('rot-hash', NOW)
    expect(row).toMatchObject({ name: 'dashboard', role: 'viewer', tenant_id: 'default', agent_id: null, expires_at: null, created_at: NOW, revoked_at: null })
  })

  it('the first row of the name is an admin row of the default tenant, with no agent, no expiry, created now', async () => {
    const { row } = await rotateSharedDashboardToken('first-hash', NOW)
    expect(row).toMatchObject({ name: 'dashboard', role: 'admin', tenant_id: 'default', agent_id: null, expires_at: null, created_at: NOW, rotated_from: null, revoked_at: null })
  })

  it('a row that already expired is not active: it is not rotated and a first row is minted', async () => {
    await mint('dashboard', 'expired-hash', 'admin', NOW - 100, NOW - 1)
    const { row, rotated } = await rotateSharedDashboardToken('fresh-hash', NOW)
    expect(rotated).toBe(false)
    expect(row.rotated_from).toBeNull()
  })

  it('a row of another tenant than default keeps that tenant when it rotates', async () => {
    const old = await mint('dashboard', 'old-hash', 'admin', NOW - 100, null, 'other-tenant')
    const { row, rotated } = await rotateSharedDashboardToken('rot-hash', NOW)
    expect(rotated).toBe(true)
    expect(row).toMatchObject({ tenant_id: 'other-tenant', rotated_from: old.id })
  })

  // `expires_at > now` is the edge: a row that expires AT now is already out, one that expires a second later is in.
  it('a row that expires exactly now is not active: it is not rotated and a first row is minted', async () => {
    await mint('dashboard', 'edge-hash', 'admin', NOW - 100, NOW)
    expect(await activeHashes('dashboard')).toEqual([])
    const { row, rotated } = await rotateSharedDashboardToken('fresh-hash', NOW)
    expect(rotated).toBe(false)
    expect(row.rotated_from).toBeNull()
  })

  it('a row that expires one second after now is active: it is rotated', async () => {
    const edge = await mint('dashboard', 'edge-hash', 'admin', NOW - 100, NOW + 1)
    expect(await activeHashes('dashboard')).toEqual(['edge-hash'])
    const { row, rotated } = await rotateSharedDashboardToken('fresh-hash', NOW)
    expect(rotated).toBe(true)
    expect(row.rotated_from).toBe(edge.id)
  })

  it('two overlapping rotations leave exactly one active dashboard row', async () => {
    await mint('dashboard', 'start-hash', 'admin')
    await Promise.all([rotateSharedDashboardToken('rot-1', NOW), rotateSharedDashboardToken('rot-2', NOW)])
    const active = await activeHashes('dashboard')
    expect(active).toHaveLength(1)
    expect(['rot-1', 'rot-2']).toContain(active[0])
  })

  it('opens its transaction IMMEDIATE (the active rows are read under the write lock)', async () => {
    await mint('dashboard', 'start-hash', 'admin')
    const original = dbx.tx.bind(dbx)
    const spy = vi.spyOn(dbx, 'tx').mockImplementation((fn, opts) => original(fn, opts))

    await rotateSharedDashboardToken('rot-hash', NOW)

    expect(spy.mock.calls[0][1]).toEqual({ mode: 'immediate' })
    spy.mockRestore()
  })
})

// `mode: 'immediate'` applies to the OUTERMOST transaction only (see TxOptions): a rotation called inside a transaction
// that is already open joins it as a savepoint and reads the rows under whatever lock that transaction holds. No caller
// nests it today; these pin what joining means, so the first one that does cannot be surprised.
describe('a rotation called inside an open transaction joins it', () => {
  it('rotateSharedDashboardToken: an outer transaction that fails afterwards takes the rotation back with it', async () => {
    await mint('dashboard', 'start-hash', 'admin')
    await expect(dbx.tx(async () => {
      await rotateSharedDashboardToken('rot-hash', NOW)
      expect(await activeHashes('dashboard')).toEqual(['rot-hash']) // visible inside the outer transaction
      throw new Error('outer failed')
    })).rejects.toThrow('outer failed')
    expect(await activeHashes('dashboard')).toEqual(['start-hash'])
  })

  it('rotateSharedDashboardToken: an outer transaction that commits keeps exactly one active row', async () => {
    await mint('dashboard', 'start-hash', 'admin')
    await dbx.tx(async () => {
      await rotateSharedDashboardToken('rot-hash', NOW)
    })
    expect(await activeHashes('dashboard')).toEqual(['rot-hash'])
  })

  it('replaceActiveApiToken: the same, an outer failure takes the replacement back', async () => {
    await mint('t-replace', 'start-hash')
    await expect(dbx.tx(async () => {
      await replaceActiveApiToken({ fileHash: 'start-hash', tokenHash: 'new-hash', name: 't-replace', role: 'fleet_agent', agentId: 'agent-a', now: NOW })
      throw new Error('outer failed')
    })).rejects.toThrow('outer failed')
    expect(await activeHashes('t-replace')).toEqual(['start-hash'])
  })
})

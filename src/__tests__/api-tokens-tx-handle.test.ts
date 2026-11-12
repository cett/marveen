// replaceActiveApiToken and rotateSharedDashboardToken keep the invariant "exactly one active token per name": the
// stale rows are revoked and the replacement is written in ONE transaction. On SQLite a call on the facade inside the
// transaction body lands in the same transaction anyway (one connection), so the behaviour alone cannot tell a
// statement on the transaction handle from one on the facade. On PostgreSQL the facade call would be another
// connection and another transaction: two active rows, or no valid token for a while. This test therefore watches the
// facade itself: while a transaction scope is open, NOTHING may reach it (the tenants lookup of insertApiToken
// included). Plus the atomicity that rests on it.
//
// Privacy: neutral fixtures only (tok-a).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { dbx, insertApiToken, replaceActiveApiToken, rotateSharedDashboardToken, listActiveApiTokensByName } from '../db.js'
import { currentTxScope } from '../db/tx-lock.js'

useTestDb()

const NOW = Math.floor(Date.now() / 1000)

interface FacadeCall { op: string; inTx: boolean; sql: string }
let facadeCalls: FacadeCall[] = []

/** Record every call that reaches the facade (dbx.run / get / all / exec) and whether a transaction scope was open. */
function watchFacade(): void {
  facadeCalls = []
  for (const op of ['run', 'get', 'all', 'exec', 'tx'] as const) {
    const real = dbx[op] as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, op).mockImplementation(((...a: unknown[]) => {
      facadeCalls.push({ op, inTx: currentTxScope() !== undefined, sql: String(a[0]).slice(0, 70) })
      return real.apply(dbx, a)
    }) as never)
  }
}
const insideTx = () => facadeCalls.filter((c) => c.inTx)

const mint = (name: string, hash: string, createdAt = NOW - 100) =>
  insertApiToken({ tokenHash: hash, name, role: 'admin', tenantId: 'default', createdAt, expiresAt: null, agentId: null })
const activeHashes = async (name: string) => (await listActiveApiTokensByName(name, NOW)).map((r) => r.token_hash).sort()
/** The insert of this one hash cannot be written: an INSERT of it aborts. */
async function breakInsertOf(hash: string): Promise<void> {
  await dbx.exec(`CREATE TRIGGER no_boom_insert BEFORE INSERT ON api_tokens
    WHEN NEW.token_hash = '${hash}' BEGIN SELECT RAISE(ABORT, 'insert refused'); END`)
}
const replace = (fileHash: string | null, tokenHash: string) =>
  replaceActiveApiToken({ fileHash, tokenHash, name: 'tok-a', role: 'admin', agentId: null, now: NOW })

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('the harness', () => {
  it('sees a facade call made while a transaction is open (so zero below is not an empty claim)', async () => {
    watchFacade()
    await dbx.tx(async () => { await dbx.run('SELECT 1') })
    expect(insideTx().map((c) => c.op)).toEqual(['run'])
  })
})

describe('replaceActiveApiToken: every statement runs on the transaction handle', () => {
  it('rotate branch (the file hash matches the active row): 0 facade calls inside, one active row left', async () => {
    await mint('tok-a', 'h-current')
    await mint('tok-a', 'h-stale', NOW - 200)
    watchFacade()
    const out = await replace('h-current', 'h-new')
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(out.rotated).toBe(true)
    expect(await activeHashes('tok-a')).toEqual(['h-new'])
  })

  it('insert branch (no match): the stale rows are revoked, the tenants lookup of the insert is on the handle too', async () => {
    await mint('tok-a', 'h-one')
    await mint('tok-a', 'h-two', NOW - 200)
    watchFacade()
    const out = await replace(null, 'h-new')
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(out.rotated).toBe(false)
    expect(await activeHashes('tok-a')).toEqual(['h-new'])
  })

  it('when the replacement cannot be written, the stale revokes roll back: the original active rows stay', async () => {
    await mint('tok-a', 'h-one')
    await mint('tok-a', 'h-two', NOW - 200)
    await breakInsertOf('boom')
    await expect(replace(null, 'boom')).rejects.toThrow('insert refused')
    expect(await activeHashes('tok-a')).toEqual(['h-one', 'h-two'])
  })

  it('when the rotation cannot be written, the stale revokes and the revoke of the old row roll back', async () => {
    await mint('tok-a', 'h-current')
    await mint('tok-a', 'h-stale', NOW - 200)
    await breakInsertOf('boom')
    await expect(replace('h-current', 'boom')).rejects.toThrow('insert refused')
    expect(await activeHashes('tok-a')).toEqual(['h-current', 'h-stale'])
  })
})

describe('rotateSharedDashboardToken: every statement runs on the transaction handle', () => {
  it('rotate branch: the newest active row is rotated, the older ones revoked, 0 facade calls inside', async () => {
    await mint('dashboard', 'h-newest')
    await mint('dashboard', 'h-older', NOW - 200)
    watchFacade()
    const out = await rotateSharedDashboardToken('h-new', NOW)
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(out.rotated).toBe(true)
    expect(await activeHashes('dashboard')).toEqual(['h-new'])
  })

  it('insert branch (no active row): 0 facade calls inside, the tenants lookup included', async () => {
    watchFacade()
    const out = await rotateSharedDashboardToken('h-new', NOW)
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(out.rotated).toBe(false)
    expect(await activeHashes('dashboard')).toEqual(['h-new'])
  })

  it('when the replacement cannot be written, nothing is revoked', async () => {
    await mint('dashboard', 'h-newest')
    await mint('dashboard', 'h-older', NOW - 200)
    await breakInsertOf('boom')
    await expect(rotateSharedDashboardToken('boom', NOW)).rejects.toThrow('insert refused')
    expect(await activeHashes('dashboard')).toEqual(['h-newest', 'h-older'])
  })
})

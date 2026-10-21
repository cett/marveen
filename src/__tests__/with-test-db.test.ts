// useTestDb: every test starts with a fresh database and with the db layer state reset, whatever the
// previous test left behind (an open transaction, counters, a cached config row).

import { describe, it, expect } from 'vitest'
import { db, getDbContextStats, getSystemConfig, setSystemConfig, runAs, currentDbContext } from '../db.js'
import { lockFor } from '../db/tx-lock.js'
import { useTestDb } from './helpers/with-test-db.js'

const { dbx } = useTestDb()

describe('useTestDb (the tests run in this order on purpose)', () => {
  it('first test: leaves a transaction open, counters, a config row and a table behind', async () => {
    await dbx.exec('CREATE TABLE leftover (id INTEGER)')
    setSystemConfig('leftover_key', '1')
    void dbx.tx(() => new Promise<void>(() => { /* never settles */ }))
    await new Promise((r) => setTimeout(r, 2))
    expect(lockFor(db).busy).toBe(true)
    expect(getDbContextStats().total).toBeGreaterThan(0)
  })

  it('second test: a fresh database, a free lock, zeroed counters, an empty cache', async () => {
    expect(lockFor(db).busy).toBe(false)
    expect(getDbContextStats()).toEqual({ total: 0, withoutContext: 0, lastCallSite: null })
    expect(getSystemConfig('leftover_key')).toBeUndefined()
    expect(await dbx.get("SELECT name FROM sqlite_master WHERE name = 'leftover'")).toBeUndefined()
    // and the facade works at once, no waiting behind the previous test's transaction
    expect(await dbx.get('SELECT 1 AS one')).toEqual({ one: 1 })
  })

  it('no context leaks into the next test', async () => {
    await runAs.system('first', async () => { await dbx.get('SELECT 1') })
    expect(currentDbContext()).toBeUndefined()
  })

  it('and none from the one before', () => {
    expect(currentDbContext()).toBeUndefined()
  })
})

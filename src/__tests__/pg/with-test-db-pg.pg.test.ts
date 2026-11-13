// useTestDb in PG mode, against the real server (MARVEEN_PG_TEST_URL, `npm run test:pg`). The cells that make a "green on
// PostgreSQL" mean PostgreSQL: dbx really is the PG adapter, every test starts on a clean clone of the baseline, the
// SQLite handle is not there to catch a stray raw call, and no backend survives into a file that does not ask for one.
import { describe, expect, it, vi } from 'vitest'
import { db } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'
import { getDbContextStats } from '../../db/context.js'
import { logger } from '../../logger.js'
import { cacheAfterWriteAsync, cachedSystemConfig, cachedSystemConfigList } from '../../db/config-cache.js'
import { cachedModelProfileMapList } from '../../db/model-profile-map-cache.js'
import { cachedAgentSettingsByKey } from '../../db/agent-settings-cache.js'
import { ambientInTx, testDbMode, useTestDb } from '../helpers/with-test-db.js'

// before useTestDb() reads it: the hooks registered below are the PG ones
process.env.MARVEEN_TEST_DB = 'pg'
const { dbx } = useTestDb()

describe('useTestDb in PG mode', () => {
  it('the mode is pg, dbx is the PG adapter, and the server says PostgreSQL', async () => {
    expect(testDbMode()).toBe('pg')
    expect(dbxDialect()).toBe('pg')
    expect((await dbx.get<{ v: string }>('SELECT version() AS v'))!.v).toMatch(/^PostgreSQL/)
  })

  it('there is no SQLite handle: a stray raw call fails loudly instead of running on a second database', () => {
    expect(db).toBeUndefined()
  })

  it('the baseline is there (85 tables) and a statement written in the SQLite spelling is refused by the server', async () => {
    const n = await dbx.get<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")
    expect(n!.n).toBeGreaterThan(80)
    await expect(dbx.run('INSERT OR IGNORE INTO task_runs (name, agent, ts) VALUES (?, ?, ?)', 'a', 'agent-a', 1)).rejects.toMatchObject({ code: '42601' })
  })

  it('a row written in one test is gone in the next, and the identity column starts again (a clone per test)', async () => {
    const first = await dbx.get<{ id: number }>('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?) RETURNING id', 'a', 'agent-a', 1)
    expect(first!.id).toBe(1)
    expect((await dbx.get<{ n: number }>('SELECT count(*)::int AS n FROM task_runs'))!.n).toBe(1)
  })

  it('the next test: the table is empty and the id is 1 again', async () => {
    expect((await dbx.get<{ n: number }>('SELECT count(*)::int AS n FROM task_runs'))!.n).toBe(0)
    const again = await dbx.get<{ id: number }>('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?) RETURNING id', 'b', 'agent-b', 2)
    expect(again!.id).toBe(1)
  })

  it('the three caches are loaded for this backend (a reader does not throw), and a row written then read back through the async write-through is served', async () => {
    // loaded from the backend: the baseline carries seed rows, so the cache holds exactly what the tables hold, and that is
    // not nothing (an unloaded cache would throw, a cache that loaded the wrong database would not match)
    const configKeys = (await dbx.all<{ key: string }>('SELECT key FROM system_config')).map((r) => r.key).sort()
    expect(configKeys.length).toBeGreaterThan(0)
    expect(cachedSystemConfigList()?.map((r) => r.key).sort()).toEqual(configKeys)
    const profileIds = (await dbx.all<{ profile_id: string }>('SELECT profile_id FROM model_profile_map')).map((r) => r.profile_id).sort()
    expect(profileIds.length).toBeGreaterThan(0)
    expect(cachedModelProfileMapList()?.map((r) => r.profile_id).sort()).toEqual(profileIds)
    expect(cachedAgentSettingsByKey('context_guard' as never)).toEqual({}) // agent_settings has no seed rows
    await dbx.run("INSERT INTO system_config (key, value, source) VALUES (?, ?, ?)", 'cache-probe', 'one', 'db')
    await cacheAfterWriteAsync('cache-probe')
    expect(cachedSystemConfig('cache-probe')).toMatchObject({ value: 'one', source: 'db' })
  })

  it('the next test does not see that cache: its own clone, its own epoch', async () => {
    expect(cachedSystemConfig('cache-probe')).toBeUndefined()
    // the cache is this clone's seed and nothing of the previous test's probe row
    const configKeys = (await dbx.all<{ key: string }>('SELECT key FROM system_config')).map((r) => r.key).sort()
    expect(configKeys).not.toContain('cache-probe')
    expect(cachedSystemConfigList()?.map((r) => r.key).sort()).toEqual(configKeys)
  })

  let previousDatabase: string | undefined

  it('remembers the name of its own database for the next test to look for', async () => {
    previousDatabase = (await dbx.get<{ n: string }>('SELECT current_database() AS n'))!.n
    expect(previousDatabase).toMatch(/^marveen_t_/)
  })

  it('the database of the previous test is dropped after it (afterEach closes the clone), and this one is another', async () => {
    const mine = (await dbx.get<{ n: string }>('SELECT current_database() AS n'))!.n
    expect(mine).not.toBe(previousDatabase)
    // pg_database is readable from any database of the server
    const left = await dbx.all<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ?', previousDatabase)
    expect(left).toEqual([])
    const here = await dbx.all<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ?', mine)
    expect(here).toHaveLength(1) // positive pair: the same lookup finds a database that exists
  })

  it('a transaction rolls back on the PG adapter too (the facade delegates tx, not only the statements)', async () => {
    await expect(dbx.tx(async (tx) => {
      await tx.run('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)', 'c', 'agent-c', 3)
      throw new Error('rollback me')
    })).rejects.toThrow('rollback me')
    expect((await dbx.get<{ n: number }>('SELECT count(*)::int AS n FROM task_runs'))!.n).toBe(0)
  })
})

describe('ambientInTx in PG mode (the positive control is not a no-op)', () => {
  it('an ambient call inside a transaction body is refused with the strict-tx error, and the control accepts exactly that', async () => {
    await ambientInTx(() => dbx.tx(async () => {
      await dbx.get('SELECT 1 AS one')
    }))
  })

  it('a run that RESOLVES fails the control: a call that was not refused must not pass for a positive control', async () => {
    await expect(ambientInTx(async () => {})).rejects.toThrow()
    await expect(ambientInTx(() => dbx.tx(async (tx) => {
      await tx.get('SELECT 1 AS one')
    }))).rejects.toThrow()
  })

  it('a run that rejects with another error fails the control too', async () => {
    await expect(ambientInTx(() => Promise.reject(new Error('some other failure')))).rejects.toThrow()
    await expect(ambientInTx(() => dbx.get('SELECT * FROM table_that_does_not_exist'))).rejects.toThrow()
  })
})

describe('the diagnostics name the caller on PostgreSQL, not the adapter', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('the warning for a call without a db context carries the call site of the test, not a frame of src/db', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      await dbx.get('SELECT 1 AS one')
      const calls = warn.mock.calls.filter((c) => String(c[1] ?? '').includes('without a db context'))
      expect(calls.length).toBe(1)
      expect((calls[0]![0] as { callSite: string }).callSite).toContain('with-test-db-pg.pg.test')
      expect(getDbContextStats().lastCallSite).toContain('with-test-db-pg.pg.test')
    } finally {
      warn.mockRestore()
    }
  })

  it('the slow-transaction warning points at the line that opened the transaction, through the facade too', async () => {
    const original = process.env.DB_TX_WARN_MS
    process.env.DB_TX_WARN_MS = '15'
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      await dbx.tx(async (tx) => {
        await tx.get('SELECT 1 AS one')
        await sleep(80)
      })
      const calls = warn.mock.calls.filter((c) => String(c[1] ?? '').includes('DB_TX_WARN_MS'))
      expect(calls.length).toBe(1)
      expect(String((calls[0]![0] as { origin: string }).origin)).toContain('with-test-db-pg.pg.test')
    } finally {
      warn.mockRestore()
      if (original === undefined) delete process.env.DB_TX_WARN_MS
      else process.env.DB_TX_WARN_MS = original
    }
  })
})

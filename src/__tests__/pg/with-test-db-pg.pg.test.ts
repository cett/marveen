// useTestDb in PG mode, against the real server (MARVEEN_PG_TEST_URL, `npm run test:pg`). The cells that make a "green on
// PostgreSQL" mean PostgreSQL: dbx really is the PG adapter, every test starts on a clean clone of the baseline, the
// SQLite handle is not there to catch a stray raw call, and no backend survives into a file that does not ask for one.
import { describe, expect, it } from 'vitest'
import { db } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'
import { cacheAfterWriteAsync, cachedSystemConfig, cachedSystemConfigList } from '../../db/config-cache.js'
import { cachedModelProfileMapList } from '../../db/model-profile-map-cache.js'
import { cachedAgentSettingsByKey } from '../../db/agent-settings-cache.js'
import { testDbMode, useTestDb } from '../helpers/with-test-db.js'

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
    expect(cachedSystemConfigList()).toEqual([]) // loaded, and the baseline has no seed rows
    expect(cachedModelProfileMapList()).toEqual([])
    expect(cachedAgentSettingsByKey('context_guard' as never)).toEqual({})
    await dbx.run("INSERT INTO system_config (key, value, source) VALUES (?, ?, ?)", 'cache-probe', 'one', 'db')
    await cacheAfterWriteAsync('cache-probe')
    expect(cachedSystemConfig('cache-probe')).toMatchObject({ value: 'one', source: 'db' })
  })

  it('the next test does not see that cache: its own clone, its own epoch', () => {
    expect(cachedSystemConfig('cache-probe')).toBeUndefined()
    expect(cachedSystemConfigList()).toEqual([])
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

// useTestDb in PG mode, against the real server (MARVEEN_PG_TEST_URL, `npm run test:pg`). The cells that make a "green on
// PostgreSQL" mean PostgreSQL: dbx really is the PG adapter, every test starts on a clean clone of the baseline, the
// SQLite handle is not there to catch a stray raw call, and no backend survives into a file that does not ask for one.
import { describe, expect, it } from 'vitest'
import { db } from '../../db.js'
import { dbxDialect } from '../../db/facade.js'
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

  it('a transaction rolls back on the PG adapter too (the facade delegates tx, not only the statements)', async () => {
    await expect(dbx.tx(async (tx) => {
      await tx.run('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)', 'c', 'agent-c', 3)
      throw new Error('rollback me')
    })).rejects.toThrow('rollback me')
    expect((await dbx.get<{ n: number }>('SELECT count(*)::int AS n FROM task_runs'))!.n).toBe(0)
  })
})

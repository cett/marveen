// syncVecMemoryDelete: the vec entry delete is best effort (its failure is swallowed), so it runs in a nested
// transaction, a SAVEPOINT inside a dbx.tx body. The subject of this file is the SQLite SQL text of that savepoint:
// the exec spy records the SAVEPOINT / RELEASE / ROLLBACK TO statements (the dbx_sp_ name regex), and the vec0 delete
// is failed through a prepare spy on the raw handle. It is not in the PORTED or the EXCLUDED list because it does not
// use useTestDb. The PostgreSQL behaviour the savepoint exists for (a refused write inside an open transaction does not
// abort it) is covered by the PG seam cell "a refused side-row write inside an open transaction is a savepoint" in
// vector-memory.pg.test.ts. The observable part here (the entry goes away, a rollback brings it back) stays too.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { dbx } from '../db/facade.js'
import { floatsToBlob, syncVecMemoryDelete } from '../db/vector.js'

const EMB = floatsToBlob(new Array(768).fill(0).map((_, i) => Math.sin(i)))

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  getDb().prepare('DELETE FROM vec_memories').run()
  getDb().prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)').run(BigInt(41), EMB)
  getDb().prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)').run(BigInt(42), EMB)
})
afterEach(() => { vi.restoreAllMocks() })

const vecIds = (): number[] =>
  (getDb().prepare('SELECT memory_id FROM vec_memories ORDER BY memory_id').all() as { memory_id: number }[]).map((r) => Number(r.memory_id))

function recordExec(): string[] {
  const seen: string[] = []
  const db = getDb()
  const original = db.exec.bind(db)
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => { seen.push(sql); return original(sql) })
  return seen
}

describe('syncVecMemoryDelete', () => {
  it('removes the entry of that memory and only that one', async () => {
    await syncVecMemoryDelete(41)
    expect(vecIds()).toEqual([42])
  })

  it('outside a transaction it opens its own transaction (BEGIN, COMMIT) and no savepoint', async () => {
    const sql = recordExec()
    await syncVecMemoryDelete(41)
    expect(sql).toContain('BEGIN')
    expect(sql).toContain('COMMIT')
    expect(sql.indexOf('BEGIN')).toBeLessThan(sql.indexOf('COMMIT'))
    expect(sql.some((s) => /^SAVEPOINT /.test(s))).toBe(false)
    expect(vecIds()).toEqual([42])
  })

  it('inside a transaction body it runs in a savepoint, and the commit keeps the delete', async () => {
    const sql = recordExec()
    await dbx.tx(async () => { await syncVecMemoryDelete(41) })
    expect(sql.some((s) => /^SAVEPOINT dbx_sp_\d+$/.test(s))).toBe(true)
    expect(sql.some((s) => /^RELEASE dbx_sp_\d+$/.test(s))).toBe(true)
    expect(vecIds()).toEqual([42])
  })

  it('a rollback of the surrounding transaction brings the entry back', async () => {
    await expect(dbx.tx(async () => {
      await syncVecMemoryDelete(41)
      throw new Error('abort the transaction')
    })).rejects.toThrow('abort the transaction')
    expect(vecIds()).toEqual([41, 42])
  })

  it('a failing delete is swallowed, rolled back to its savepoint, and the surrounding transaction still commits', async () => {
    const sql = recordExec()
    const db = getDb()
    const realPrepare = db.prepare.bind(db)
    // the delete statement fails; every other statement runs as usual
    vi.spyOn(db, 'prepare').mockImplementation(((text: string) => {
      if (/^DELETE FROM vec_memories WHERE memory_id/.test(text)) throw new Error('vec0 unavailable')
      return realPrepare(text)
    }) as typeof db.prepare)
    await dbx.tx(async (tx) => {
      await syncVecMemoryDelete(41)
      await tx.run('INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)', BigInt(43), EMB)
    })
    const rollbackAt = sql.findIndex((s) => /^ROLLBACK TO dbx_sp_\d+$/.test(s))
    expect(rollbackAt).toBeGreaterThan(-1)
    // the savepoint is released right after the rollback to it, under the same name; without the RELEASE it would
    // stay open inside the surrounding transaction
    expect(sql[rollbackAt + 1]).toBe(`RELEASE ${sql[rollbackAt].replace('ROLLBACK TO ', '')}`)
    vi.restoreAllMocks()
    expect(vecIds()).toEqual([41, 42, 43])
  })

  it('outside a transaction it does not fail either when the delete fails', async () => {
    const db = getDb()
    const realPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(((text: string) => {
      if (/^DELETE FROM vec_memories WHERE memory_id/.test(text)) throw new Error('vec0 unavailable')
      return realPrepare(text)
    }) as typeof db.prepare)
    await expect(syncVecMemoryDelete(41)).resolves.toBeUndefined()
  })
})

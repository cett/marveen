// syncVecMemoryDelete: the vec entry delete is best effort (its failure is swallowed), so it runs in a nested
// transaction, a SAVEPOINT inside a dbx.tx body. On SQLite a failed statement leaves the transaction usable anyway, so
// the savepoint is invisible in the result; on PostgreSQL the swallowed failure would abort the whole transaction
// without it. The tests therefore watch the statements the facade issues (the transaction-handle spy pattern) next to
// the observable behaviour: the entry goes away, a rollback of the surrounding transaction brings it back.
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
    expect(sql.some((s) => /^ROLLBACK TO dbx_sp_\d+$/.test(s))).toBe(true)
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

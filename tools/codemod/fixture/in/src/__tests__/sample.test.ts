import { db, getDb } from '../db.js'

declare const describe: (name: string, fn: () => void) => void
declare const it: (name: string, fn: () => unknown) => void
declare const beforeEach: (fn: () => unknown) => void
declare const expect: any

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

describe('sample', () => {
  beforeEach(() => {
    db.exec('DELETE FROM widgets')
  })

  it('reads and writes through the raw handle', () => {
    db.prepare('INSERT INTO widgets (id) VALUES (?)').run(1)
    const row = db.prepare('SELECT id FROM widgets WHERE id = ?').get(1) as { id: number } | undefined
    expect(row).toEqual({ id: 1 })
    expect(count('SELECT COUNT(*) AS n FROM widgets')).toBe(1)
  })

  it('goes through a getDb alias and a direct getDb call', () => {
    const h = getDb()
    expect(h.prepare('SELECT 1 AS n').get().n).toBe(1)
    expect(getDb().prepare('SELECT 2 AS n').get().n).toBe(2)
  })

  it('a transaction is reported, not rewritten', () => {
    db.transaction(() => { db.prepare('DELETE FROM widgets').run() })()
  })

  it('a thrown-error assertion is reported, not rewritten', () => {
    expect(() => db.prepare('INSERT INTO widgets (id) VALUES (1)').run()).toThrow()
  })

  it('a callback of forEach is reported, not rewritten', () => {
    const ids = [1, 2]
    ids.forEach((i) => db.prepare('INSERT INTO widgets (id) VALUES (?)').run(i))
  })

  it('a stored statement blocks the whole test', () => {
    const stmt = db.prepare('SELECT 1')
    stmt.get()
    db.prepare('SELECT 2').get()
  })
})

describe('db used right in the describe body', () => {
  db.exec('SELECT 1')
})

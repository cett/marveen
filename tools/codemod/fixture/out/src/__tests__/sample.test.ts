import { db, dbx } from '../db.js'

declare const describe: (name: string, fn: () => void) => void
declare const it: (name: string, fn: () => unknown) => void
declare const beforeEach: (fn: () => unknown) => void
declare const expect: any

const count = async (sql: string): Promise<number> => ((await dbx.get(sql)) as { n: number }).n

describe('sample', () => {
  beforeEach(async () => {
    await dbx.exec('DELETE FROM widgets')
  })

  it('reads and writes through the raw handle', async () => {
    await dbx.run('INSERT INTO widgets (id) VALUES (?)', 1)
    const row = await dbx.get<{ id: number }>('SELECT id FROM widgets WHERE id = ?', 1)
    expect(row).toEqual({ id: 1 })
    expect(await count('SELECT COUNT(*) AS n FROM widgets')).toBe(1)
  })

  it('goes through a getDb alias and a direct getDb call', async () => {
    expect((await dbx.get('SELECT 1 AS n')).n).toBe(1)
    expect((await dbx.get('SELECT 2 AS n')).n).toBe(2)
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

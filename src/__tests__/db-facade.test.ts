// The async db facade (dbx): get/all/run/exec on the SQLite backend, both parameter shapes, error
// propagation and the live handle (initDatabase() called again hands the facade a fresh connection).

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, dbx } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(async () => {
  await dbx.exec('CREATE TABLE facade_t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, n INTEGER NOT NULL DEFAULT 0)')
})

describe('dbx statement operations', () => {
  it('run reports changes and lastInsertRowid', async () => {
    const first = await dbx.run('INSERT INTO facade_t (name, n) VALUES (?, ?)', 'a', 1)
    expect(first.changes).toBe(1)
    expect(Number(first.lastInsertRowid)).toBe(1)
    const second = await dbx.run('INSERT INTO facade_t (name) VALUES (?)', 'b')
    expect(Number(second.lastInsertRowid)).toBe(2)
    const upd = await dbx.run('UPDATE facade_t SET n = n + 1')
    expect(upd.changes).toBe(2)
  })

  it('get returns the first row or undefined', async () => {
    await dbx.run('INSERT INTO facade_t (name, n) VALUES (?, ?)', 'a', 7)
    expect(await dbx.get<{ name: string; n: number }>('SELECT name, n FROM facade_t WHERE name = ?', 'a')).toEqual({ name: 'a', n: 7 })
    expect(await dbx.get('SELECT * FROM facade_t WHERE name = ?', 'missing')).toBeUndefined()
  })

  it('all returns every row, or an empty array', async () => {
    expect(await dbx.all('SELECT * FROM facade_t')).toEqual([])
    await dbx.run('INSERT INTO facade_t (name) VALUES (?)', 'a')
    await dbx.run('INSERT INTO facade_t (name) VALUES (?)', 'b')
    const rows = await dbx.all<{ name: string }>('SELECT name FROM facade_t ORDER BY id')
    expect(rows.map(r => r.name)).toEqual(['a', 'b'])
  })

  it('exec runs a multi-statement script', async () => {
    await dbx.exec("INSERT INTO facade_t (name) VALUES ('x'); INSERT INTO facade_t (name) VALUES ('y');")
    expect((await dbx.all('SELECT * FROM facade_t')).length).toBe(2)
  })

  it('takes a single object for @name placeholders', async () => {
    await dbx.run('INSERT INTO facade_t (name, n) VALUES (@name, @n)', { name: 'named', n: 5 })
    expect(await dbx.get('SELECT n FROM facade_t WHERE name = @name', { name: 'named' })).toEqual({ n: 5 })
    expect(await dbx.all('SELECT name FROM facade_t WHERE n >= @min', { min: 5 })).toEqual([{ name: 'named' }])
  })

  it('takes a variable number of positional arguments', async () => {
    await dbx.run('INSERT INTO facade_t (name, n) VALUES (?, ?)', 'a', 1)
    await dbx.run('INSERT INTO facade_t (name, n) VALUES (?, ?)', 'b', 2)
    await dbx.run('INSERT INTO facade_t (name, n) VALUES (?, ?)', 'c', 3)
    const rows = await dbx.all<{ name: string }>('SELECT name FROM facade_t WHERE n IN (?, ?) ORDER BY n', 1, 3)
    expect(rows.map(r => r.name)).toEqual(['a', 'c'])
  })
})

describe('dbx errors', () => {
  it('rejects with the unchanged better-sqlite3 error (constraint code kept)', async () => {
    await dbx.run('INSERT INTO facade_t (name) VALUES (?)', 'dup')
    const err = await dbx.run('INSERT INTO facade_t (name) VALUES (?)', 'dup').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as NodeJS.ErrnoException).code).toBe('SQLITE_CONSTRAINT_UNIQUE')
  })

  it('a bad statement is a rejection on every operation, never a synchronous throw', async () => {
    const calls = [
      () => dbx.get('SELECT * FROM no_such_table'),
      () => dbx.all('SELECT * FROM no_such_table'),
      () => dbx.run('INSERT INTO no_such_table VALUES (1)'),
      () => dbx.exec('NOT SQL'),
    ]
    for (const call of calls) {
      let promise!: Promise<unknown>
      expect(() => { promise = call() }).not.toThrow()
      await expect(promise).rejects.toBeInstanceOf(Error)
    }
  })
})

describe('dbx handle', () => {
  it('resolves the connection on every call: initDatabase() again gives a fresh one', async () => {
    await dbx.run('INSERT INTO facade_t (name) VALUES (?)', 'old')
    initDatabase(':memory:')
    // The old in-memory database is gone with its handle; the facade talks to the new one.
    expect(await dbx.get("SELECT name FROM sqlite_master WHERE name = 'facade_t'")).toBeUndefined()
    await dbx.exec('CREATE TABLE facade_t (id INTEGER PRIMARY KEY, name TEXT)')
    expect(await dbx.all('SELECT * FROM facade_t')).toEqual([])
  })

  it('does not leak the raw handle or a statement object', async () => {
    expect(Object.keys(dbx).sort()).toEqual(['all', 'exec', 'get', 'run', 'tx'])
    const row = await dbx.get('SELECT 1 AS one')
    expect(row).toEqual({ one: 1 })
  })
})

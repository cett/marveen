// The backend behind `dbx` is replaceable (test side): useDbxBackend / dbxDialect, the delegation of the five
// operations, the reset between tests, and the rule that the facade never imports the PostgreSQL driver. No server:
// the other backend here is a recording fake. The SQLite behaviour itself is pinned by db-facade.test.ts and
// db-facade-tx.test.ts, which must stay green unchanged.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { dbx, dbxDialect, useDbxBackend, type Dbx, type Tx, type TxOptions } from '../db/facade.js'
import { resetDbTestState, useTestDb } from './helpers/with-test-db.js'

useTestDb()

interface Call { op: string; args: unknown[] }

/** A backend that records every call and answers with fixed values; `failWith` makes every operation reject. */
function fakeBackend(failWith?: Error): { backend: Dbx; calls: Call[] } {
  const calls: Call[] = []
  const answer = <T>(value: T): Promise<T> => (failWith ? Promise.reject(failWith) : Promise.resolve(value))
  const backend: Dbx = {
    get: (<T>(sql: string, ...params: unknown[]) => { calls.push({ op: 'get', args: [sql, ...params] }); return answer({ from: 'fake' } as T) }) as Dbx['get'],
    all: (<T>(sql: string, ...params: unknown[]) => { calls.push({ op: 'all', args: [sql, ...params] }); return answer([{ from: 'fake' }] as T[]) }) as Dbx['all'],
    run: (sql: string, ...params: unknown[]) => { calls.push({ op: 'run', args: [sql, ...params] }); return answer({ changes: 7, lastInsertRowid: 0 }) },
    exec: (sql: string) => { calls.push({ op: 'exec', args: [sql] }); return answer(undefined) },
    tx: (<T>(fn: (tx: Tx) => Promise<T>, opts?: TxOptions) => { calls.push({ op: 'tx', args: [opts] }); return failWith ? Promise.reject(failWith) : fn(null as unknown as Tx) }) as Dbx['tx'],
  }
  return { backend, calls }
}

// no afterEach of its own: the reset between tests is the thing under test (useTestDb does it)

describe('the default is SQLite', () => {
  it('dialect sqlite, and the five operations reach the in-memory database', async () => {
    expect(dbxDialect()).toBe('sqlite')
    await dbx.exec('CREATE TABLE be_t (id INTEGER PRIMARY KEY, name TEXT)')
    const r = await dbx.run('INSERT INTO be_t (name) VALUES (?)', 'agent-a')
    expect(r.changes).toBe(1)
    expect(await dbx.get<{ name: string }>('SELECT name FROM be_t WHERE id = ?', r.lastInsertRowid)).toEqual({ name: 'agent-a' })
    expect(await dbx.all('SELECT name FROM be_t')).toEqual([{ name: 'agent-a' }])
    expect(await dbx.tx(async (tx) => (await tx.get<{ n: number }>('SELECT count(*) AS n FROM be_t'))!.n)).toBe(1)
  })

  it('an error of the SQLite driver reaches the caller unchanged (same Error, same code)', async () => {
    const err = await dbx.get('SELECT * FROM no_such_table').then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/no such table: no_such_table/)
    expect((err as { code?: string }).code).toBe('SQLITE_ERROR')
  })
})

describe('another backend', () => {
  it('every operation goes to it with its arguments as given, and the answer comes back as it is', async () => {
    const { backend, calls } = fakeBackend()
    useDbxBackend(backend)
    expect(dbxDialect()).toBe('pg')
    expect(await dbx.get('SELECT 1 WHERE a = ?', 1)).toEqual({ from: 'fake' })
    expect(await dbx.all('SELECT 2 WHERE a = @a AND b = @b', { a: 1, b: 2 })).toEqual([{ from: 'fake' }])
    expect(await dbx.run('UPDATE t SET a = ? WHERE b = ? AND c = ?', 1, 2, 3)).toEqual({ changes: 7, lastInsertRowid: 0 })
    await dbx.exec('SELECT 3')
    const body = (): Promise<string> => Promise.resolve('body-result')
    expect(await dbx.tx(body, { mode: 'immediate' })).toBe('body-result')
    expect(calls).toEqual([
      { op: 'get', args: ['SELECT 1 WHERE a = ?', 1] },
      { op: 'all', args: ['SELECT 2 WHERE a = @a AND b = @b', { a: 1, b: 2 }] },
      { op: 'run', args: ['UPDATE t SET a = ? WHERE b = ? AND c = ?', 1, 2, 3] },
      { op: 'exec', args: ['SELECT 3'] },
      { op: 'tx', args: [{ mode: 'immediate' }] },
    ])
  })

  it('a rejection of the backend reaches the caller as the same Error object', async () => {
    const boom = Object.assign(new Error('backend failed'), { code: '23505' })
    useDbxBackend(fakeBackend(boom).backend)
    for (const op of [() => dbx.get('SELECT 1'), () => dbx.all('SELECT 1'), () => dbx.run('SELECT 1'), () => dbx.exec('SELECT 1'), () => dbx.tx(() => Promise.resolve(1))]) {
      await expect(op()).rejects.toBe(boom)
    }
  })

  it('nothing of it touches the SQLite database (the statement does not run there)', async () => {
    const { backend } = fakeBackend()
    useDbxBackend(backend)
    await dbx.exec('CREATE TABLE only_on_fake (id INTEGER)')
    useDbxBackend(null)
    await expect(dbx.get('SELECT * FROM only_on_fake')).rejects.toThrow(/no such table/)
  })

  it('a module that holds the dbx object from before the switch talks to the new backend (it is looked up per call)', async () => {
    const held = dbx
    const { backend, calls } = fakeBackend()
    useDbxBackend(backend)
    await held.get('SELECT 1')
    expect(calls).toHaveLength(1)
  })

  it('the dialect can be named (a wrapper around SQLite says sqlite), and null always means SQLite', () => {
    const { backend } = fakeBackend()
    useDbxBackend(backend, 'sqlite')
    expect(dbxDialect()).toBe('sqlite')
    useDbxBackend(backend, 'pg')
    expect(dbxDialect()).toBe('pg')
    useDbxBackend(null, 'pg')
    expect(dbxDialect()).toBe('sqlite')
  })
})

describe('no backend leaks from one test into the next', () => {
  it('first test: leaves a backend switched on, on purpose', () => {
    useDbxBackend(fakeBackend().backend)
    expect(dbxDialect()).toBe('pg')
  })

  it('next test: useTestDb put SQLite back before it started, and the database works', async () => {
    expect(dbxDialect()).toBe('sqlite')
    await dbx.exec('CREATE TABLE leak_t (id INTEGER)')
    expect(await dbx.all('SELECT * FROM leak_t')).toEqual([])
  })

  it('resetDbTestState alone does it (PG, then SQLite)', async () => {
    const { backend, calls } = fakeBackend()
    useDbxBackend(backend)
    resetDbTestState()
    expect(dbxDialect()).toBe('sqlite')
    await dbx.exec('CREATE TABLE after_reset_t (id INTEGER)')
    expect(calls).toEqual([])
  })
})

describe('the facade does not know the PostgreSQL driver', () => {
  const source = readFileSync(path.resolve(__dirname, '..', 'db', 'facade.ts'), 'utf-8')
  const importLines = source.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l))

  it('imports neither pg nor anything under db/pg', () => {
    expect(importLines.length).toBeGreaterThan(0) // the scan sees the imports at all
    expect(importLines.filter((l) => /from\s+['"](pg|pg-[^'"]*|\.\/pg\/[^'"]*)['"]/.test(l))).toEqual([])
  })
})

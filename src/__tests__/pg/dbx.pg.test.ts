// The PostgreSQL adapter (src/db/pg/dbx.ts) against a real server (MARVEEN_PG_TEST_URL, `npm run test:pg`). The control
// flow (which statement on which connection, when a connection is released) is pinned without a server in
// src/__tests__/pg-dbx-flow.test.ts; here is what the SERVER does with it: savepoints, the lifetime of the tenant
// settings, row locks, timeouts. Every pool here is built WITHOUT the int8 parser: the adapter must not depend on it.
// The mutants for these cells are in the PR description (a table of text patches, each with the cell that goes red).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runAs } from '../../db/context.js'
import { createPgDbx, type PgDbx } from '../../db/pg/dbx.js'
import { isPgUniqueViolation, pgErrorCode } from '../../db/pg/errors.js'
import { pgPoolConfig, type PgPoolSettings } from '../../db/pg/pool.js'
import { isUniqueViolationOn } from '../../web/unique-violation.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

let db: PgTestDb
const pools: pg.Pool[] = []
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A pool on the test database with no extra settings (the adapter has to cope with a plain pool). */
function plainDbx(max: number): PgDbx {
  const p = new pg.Pool({ connectionString: db.url, max })
  pools.push(p)
  return createPgDbx(p)
}

/** A pool with the production limits (pgPoolConfig), overridden per cell. */
function limitedDbx(settings: PgPoolSettings): { dbx: PgDbx; pool: pg.Pool } {
  const p = new pg.Pool(pgPoolConfig(db.url, settings, {}))
  pools.push(p)
  return { dbx: createPgDbx(p), pool: p }
}

const GUCS = `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.role', true) AS r,
  current_setting('app.agent_id', true) AS a, current_setting('app.job', true) AS j`
const noValue = (v: string | null): boolean => v === null || v === '' // an unset custom setting reads as NULL or '' depending on history

beforeAll(async () => {
  db = await createPgTestDb()
  await db.pool.query('CREATE TABLE dx_t (id bigint PRIMARY KEY, v bigint NOT NULL DEFAULT 0, name text UNIQUE, flag smallint, raw bytea)')
}, 60000)

beforeEach(async () => {
  await db.pool.query('TRUNCATE dx_t')
})

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)))
})

afterAll(async () => {
  if (db) await db.close()
})

describe('rows and statements', () => {
  it('int8 is a checked number, smallint a number, bytea a Buffer, numeric stays text (on a pool with no type parser of its own)', async () => {
    const dbx = plainDbx(2)
    const row = await dbx.get<{ n: number; big: number; s: number; b: Buffer; d: string }>(
      "SELECT count(*) AS n, 9007199254740991::bigint AS big, 7::smallint AS s, '\\x0102ff'::bytea AS b, 1.5::numeric AS d FROM dx_t",
    )
    expect(row).toEqual({ n: 0, big: Number.MAX_SAFE_INTEGER, s: 7, b: Buffer.from([1, 2, 255]), d: '1.5' })
    await expect(dbx.get('SELECT 9007199254740993::bigint AS x')).rejects.toThrow(/safe integer/)
  })

  it('a Buffer goes in and comes out unchanged', async () => {
    const dbx = plainDbx(2)
    const raw = Buffer.from([0, 1, 2, 255, 0])
    await dbx.run('INSERT INTO dx_t (id, raw) VALUES (?, ?)', 1, raw)
    expect((await dbx.get<{ raw: Buffer }>('SELECT raw FROM dx_t WHERE id = ?', 1))!.raw.equals(raw)).toBe(true)
  })

  it('run: changes is the row count, an ON CONFLICT DO NOTHING that skipped the row is 0, lastInsertRowid is 0', async () => {
    const dbx = plainDbx(2)
    expect(await dbx.run('INSERT INTO dx_t (id) VALUES (?), (?)', 1, 2)).toEqual({ changes: 2, lastInsertRowid: 0 })
    expect((await dbx.run('UPDATE dx_t SET v = ? WHERE id = ?', 5, 1)).changes).toBe(1)
    expect((await dbx.run('UPDATE dx_t SET v = ? WHERE id = ?', 5, 99)).changes).toBe(0)
    expect((await dbx.run('INSERT INTO dx_t (id) VALUES (?) ON CONFLICT DO NOTHING', 1)).changes).toBe(0)
    expect((await dbx.run('DELETE FROM dx_t')).changes).toBe(2)
  })

  it('RETURNING gives the generated value that lastInsertRowid does not', async () => {
    const dbx = plainDbx(2)
    expect(await dbx.get('INSERT INTO dx_t (id, v) VALUES (?, ?) RETURNING id, v', 8, 3)).toEqual({ id: 8, v: 3 })
  })

  it('the translated text runs: a ? or @name inside a literal or a comment is data, the cast stays, a name used twice binds once', async () => {
    const dbx = plainDbx(2)
    expect(await dbx.get("SELECT ?::int + 1 AS n, 'a?b @c' AS q /* ? */ -- ?", 41)).toEqual({ n: 42, q: 'a?b @c' })
    expect(await dbx.get('SELECT @a::int + @a::int AS twice, @b::text AS b', { a: 2, b: 'x' })).toEqual({ twice: 4, b: 'x' })
  })

  it('exec runs several statements in one go', async () => {
    const dbx = plainDbx(2)
    await dbx.exec("INSERT INTO dx_t (id) VALUES (1); INSERT INTO dx_t (id) VALUES (2); UPDATE dx_t SET v = 9 WHERE id = 2")
    expect(await dbx.all('SELECT id, v FROM dx_t ORDER BY id')).toEqual([{ id: 1, v: 0 }, { id: 2, v: 9 }])
  })

  it('a unique violation reaches the caller with the driver error that the matchers know', async () => {
    const dbx = plainDbx(2)
    await dbx.run('INSERT INTO dx_t (id, name) VALUES (1, ?)', 'agent-a')
    const err = await dbx.run('INSERT INTO dx_t (id, name) VALUES (2, ?)', 'agent-a').then(() => undefined, (e: unknown) => e)
    expect(pgErrorCode(err)).toBe('23505')
    expect(isPgUniqueViolation(err)).toBe(true)
    expect(isUniqueViolationOn(err, 'dx_t.name')).toBe(true)
    expect(isUniqueViolationOn(err, 'dx_t.id')).toBe(false)
  })
})

describe('transactions', () => {
  it('commit makes the rows visible to everyone, and not before', async () => {
    const dbx = plainDbx(3)
    let commitNow!: () => void
    const gate = new Promise<void>((r) => { commitNow = r })
    let inserted!: () => void
    const insertedP = new Promise<void>((r) => { inserted = r })
    const running = dbx.tx(async (tx) => {
      await tx.run('INSERT INTO dx_t (id) VALUES (1)')
      inserted()
      await gate
    })
    await insertedP
    expect((await db.pool.query('SELECT count(*)::int AS n FROM dx_t')).rows[0].n).toBe(0) // not committed yet
    commitNow()
    await running
    expect((await db.pool.query('SELECT count(*)::int AS n FROM dx_t')).rows[0].n).toBe(1)
  })

  it('a body that throws is rolled back and the same error comes out', async () => {
    const dbx = plainDbx(2)
    const boom = new Error('body failed')
    await expect(dbx.tx(async (tx) => { await tx.run('INSERT INTO dx_t (id) VALUES (1)'); throw boom })).rejects.toBe(boom)
    expect((await db.pool.query('SELECT count(*)::int AS n FROM dx_t')).rows[0].n).toBe(0)
  })

  it('a savepoint: the inner unique violation is undone alone, the outer goes on and commits', async () => {
    const dbx = plainDbx(2)
    await dbx.run('INSERT INTO dx_t (id, name) VALUES (1, ?)', 'agent-a')
    let innerError: unknown
    await dbx.tx(async (tx) => {
      await tx.run('INSERT INTO dx_t (id, name) VALUES (2, ?)', 'agent-b')
      innerError = await tx.tx((inner) => inner.run('INSERT INTO dx_t (id, name) VALUES (3, ?)', 'agent-a')).then(() => undefined, (e: unknown) => e)
      await tx.run('INSERT INTO dx_t (id, name) VALUES (4, ?)', 'agent-c')
    })
    expect(isPgUniqueViolation(innerError)).toBe(true)
    expect((await dbx.all<{ id: number }>('SELECT id FROM dx_t ORDER BY id')).map((r) => r.id)).toEqual([1, 2, 4])
  })

  it('a statement on the PARENT handle while a savepoint body runs falls into that savepoint (one connection): the savepoint rollback takes it back (same as SQLite)', async () => {
    const dbx = plainDbx(2)
    let parentWriteAccepted = false
    await dbx.tx(async (tx) => {
      await tx.run('INSERT INTO dx_t (id) VALUES (1)')
      await tx.tx(async (inner) => {
        await inner.run('INSERT INTO dx_t (id) VALUES (2)')
        await tx.run('INSERT INTO dx_t (id) VALUES (3)') // the parent handle, the savepoint is the open scope
        parentWriteAccepted = true // a refusal of the parent handle would end the body above and be swallowed by the catch below
        throw new Error('inner failed')
      }).catch(() => undefined)
      await tx.run('INSERT INTO dx_t (id) VALUES (4)')
    })
    expect(parentWriteAccepted).toBe(true)
    expect((await dbx.all<{ id: number }>('SELECT id FROM dx_t ORDER BY id')).map((r) => r.id)).toEqual([1, 4])
  })

  it('positive pair: the same parent-handle write inside a savepoint that succeeds is kept', async () => {
    const dbx = plainDbx(2)
    await dbx.tx(async (tx) => {
      await tx.tx(async (inner) => {
        await inner.run('INSERT INTO dx_t (id) VALUES (2)')
        await tx.run('INSERT INTO dx_t (id) VALUES (3)')
      })
    })
    expect((await dbx.all<{ id: number }>('SELECT id FROM dx_t ORDER BY id')).map((r) => r.id)).toEqual([2, 3])
  })

  it('positive pair: the same write through the parent handle after the savepoint body is kept', async () => {
    const dbx = plainDbx(2)
    await dbx.tx(async (tx) => {
      await tx.tx(async (inner) => {
        await inner.run('INSERT INTO dx_t (id) VALUES (2)')
        throw new Error('inner failed')
      }).catch(() => undefined)
      await tx.run('INSERT INTO dx_t (id) VALUES (3)')
    })
    expect((await dbx.all<{ id: number }>('SELECT id FROM dx_t ORDER BY id')).map((r) => r.id)).toEqual([3])
  })

  it('without a savepoint the same failure poisons the transaction: the next statement fails with 25P02', async () => {
    const dbx = plainDbx(2)
    await dbx.run('INSERT INTO dx_t (id, name) VALUES (1, ?)', 'agent-a')
    let next: unknown
    await expect(
      dbx.tx(async (tx) => {
        await tx.run('INSERT INTO dx_t (id, name) VALUES (2, ?)', 'agent-a').catch(() => undefined) // swallowed, no savepoint
        next = await tx.get('SELECT 1').then(() => undefined, (e: unknown) => e)
        throw next
      }),
    ).rejects.toMatchObject({ code: '25P02' })
    expect(pgErrorCode(next)).toBe('25P02')
    expect((next as Error).message).toMatch(/current transaction is aborted/)
  })

  it('a body that swallowed every failure and returned normally does not report a success: nothing was committed', async () => {
    const dbx = plainDbx(2)
    await dbx.run('INSERT INTO dx_t (id, name) VALUES (1, ?)', 'agent-a')
    await expect(
      dbx.tx(async (tx) => {
        await tx.run('INSERT INTO dx_t (id, name) VALUES (2, ?)', 'agent-b')
        await tx.run('INSERT INTO dx_t (id, name) VALUES (3, ?)', 'agent-a').catch(() => undefined) // aborts the transaction
        return 'looks fine'
      }),
    ).rejects.toThrow(/nothing was committed/)
    expect((await dbx.all<{ id: number }>('SELECT id FROM dx_t ORDER BY id')).map((r) => r.id)).toEqual([1]) // agent-b's row is gone
  })

  it('25P02 then COMMIT: the statement after the failure is refused with 25P02, the body returns normally, and the COMMIT is reported as a failure', async () => {
    const dbx = plainDbx(2)
    await dbx.run('INSERT INTO dx_t (id, name) VALUES (1, ?)', 'agent-a')
    const codes: Array<string | undefined> = []
    await expect(
      dbx.tx(async (tx) => {
        await tx.run('INSERT INTO dx_t (id, name) VALUES (2, ?)', 'agent-a').catch((e: unknown) => codes.push(pgErrorCode(e)))
        await tx.get('SELECT 1').catch((e: unknown) => codes.push(pgErrorCode(e)))
        return 'looks fine'
      }),
    ).rejects.toThrow(/nothing was committed/)
    expect(codes).toEqual(['23505', '25P02'])
  })

  it('two transactions run side by side on two connections; a conflicting UPDATE waits for the row and applies after the first commit', async () => {
    const dbx = plainDbx(4)
    await dbx.run('INSERT INTO dx_t (id, v) VALUES (1, 0)')
    let letGo!: () => void
    const gate = new Promise<void>((r) => { letGo = r })
    let firstUpdated!: () => void
    const updated = new Promise<void>((r) => { firstUpdated = r })
    let secondDone = false
    const pids: number[] = []
    const first = dbx.tx(async (tx) => {
      pids.push((await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid)
      await tx.run('UPDATE dx_t SET v = v + 1 WHERE id = 1')
      firstUpdated()
      await gate
    })
    await updated
    const second = dbx.tx(async (tx) => {
      pids.push((await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid)
      await tx.run('UPDATE dx_t SET v = v + 10 WHERE id = 1')
      secondDone = true
    })
    await sleep(300)
    expect(secondDone).toBe(false) // waiting for the row lock of the first
    letGo()
    await Promise.all([first, second])
    expect(secondDone).toBe(true)
    expect(new Set(pids).size).toBe(2)
    expect((await dbx.get<{ v: number }>('SELECT v FROM dx_t WHERE id = 1'))!.v).toBe(11)
  })
})

describe('the strict rule against a real second connection', () => {
  it('an outer call inside a body is refused; with { ambient: true } it runs on another connection and does not see the open transaction', async () => {
    const dbx = plainDbx(3)
    await expect(
      dbx.tx(async (tx) => {
        await tx.run('INSERT INTO dx_t (id) VALUES (1)')
        await dbx.get('SELECT id FROM dx_t WHERE id = 1')
      }),
    ).rejects.toThrow(/use the tx handle inside a transaction body/)
    expect((await dbx.all('SELECT id FROM dx_t')).length).toBe(0) // and the transaction rolled back

    let seenByHandle: unknown
    let seenByOuter: unknown
    await dbx.tx(async (tx) => {
      await tx.run('INSERT INTO dx_t (id) VALUES (2)')
      seenByHandle = await tx.get('SELECT id FROM dx_t WHERE id = 2')
      seenByOuter = await dbx.get('SELECT id FROM dx_t WHERE id = 2') // uncommitted: another connection does not see it
    }, { ambient: true })
    expect(seenByHandle).toEqual({ id: 2 })
    expect(seenByOuter).toBeUndefined()
  })
})

describe('the tenant context on the server', () => {
  it('inside a transaction the four settings carry the context: tenant, agent, system job, and none (empty, never a default tenant)', async () => {
    const dbx = plainDbx(2)
    const read = (tx: { get<T>(sql: string): Promise<T | undefined> }) => tx.get<{ t: string; r: string; a: string; j: string }>(GUCS)
    expect(await runAs.tenant('tenant-a', () => dbx.tx(read))).toEqual({ t: 'tenant-a', r: 'tenant', a: '', j: '' })
    expect(await runAs.agent('agent-a', 'tenant-b', () => dbx.tx(read))).toEqual({ t: 'tenant-b', r: 'agent', a: 'agent-a', j: '' })
    expect(await runAs.system('job-x', () => dbx.tx(read))).toEqual({ t: '', r: 'system', a: '', j: 'job-x' })
    expect(await dbx.tx(read)).toEqual({ t: '', r: '', a: '', j: '' })
  })

  it('a statement outside a transaction sees it too, and a savepoint body keeps it', async () => {
    const dbx = plainDbx(2)
    expect(await runAs.tenant('tenant-a', () => dbx.get<{ t: string }>(GUCS))).toMatchObject({ t: 'tenant-a', r: 'tenant' })
    const inner = await runAs.tenant('tenant-a', () => dbx.tx((tx) => tx.tx((sp) => sp.get<{ t: string }>(GUCS))))
    expect(inner).toMatchObject({ t: 'tenant-a', r: 'tenant' })
  })

  it('a runAs inside the body does not change what the transaction was opened with', async () => {
    const dbx = plainDbx(2)
    const seen = await runAs.tenant('tenant-a', () => dbx.tx((tx) => runAs.tenant('tenant-b', () => tx.get<{ t: string }>(GUCS))))
    expect(seen).toMatchObject({ t: 'tenant-a' })
  })

  it('does not leak to the next borrower of the SAME connection (pool of one): after a commit, a failed statement, a thrown body and a lone statement', async () => {
    const p = new pg.Pool({ connectionString: db.url, max: 1 })
    pools.push(p)
    const dbx = createPgDbx(p)
    const pidOf = async (): Promise<number> => (await dbx.tx((tx) => tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid')))!.pid
    const home = await pidOf()
    const nextBorrower = async (): Promise<{ pid: number; t: string | null; r: string | null }> =>
      (await p.query<{ pid: number; t: string | null; r: string | null }>(
        "SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS t, current_setting('app.role', true) AS r",
      )).rows[0]!

    await runAs.tenant('tenant-a', () => dbx.tx((tx) => tx.get('SELECT 1')))
    let after = await nextBorrower()
    expect(after.pid).toBe(home) // the same connection: the cell means something
    expect(noValue(after.t) && noValue(after.r)).toBe(true)

    await runAs.tenant('tenant-b', () => dbx.tx((tx) => tx.get('SELECT 1/0'))).catch(() => undefined)
    after = await nextBorrower()
    expect(after.pid).toBe(home)
    expect(noValue(after.t) && noValue(after.r)).toBe(true)

    await runAs.tenant('tenant-c', () => dbx.tx(() => Promise.reject(new Error('body failed')))).catch(() => undefined)
    after = await nextBorrower()
    expect(after.pid).toBe(home)
    expect(noValue(after.t) && noValue(after.r)).toBe(true)

    await runAs.tenant('tenant-d', () => dbx.get('SELECT 1'))
    after = await nextBorrower()
    expect(after.pid).toBe(home)
    expect(noValue(after.t) && noValue(after.r)).toBe(true)
  })
})

describe('limits (pgPoolConfig)', () => {
  it('a full pool: the second waiter fails with the connection timeout instead of hanging, and the pool works again once the first is done', async () => {
    const { dbx } = limitedDbx({ max: 1, connectionTimeoutMs: 300 })
    let letGo!: () => void
    const gate = new Promise<void>((r) => { letGo = r })
    let holding!: () => void
    const holdingP = new Promise<void>((r) => { holding = r })
    const first = dbx.tx(async (tx) => { await tx.get('SELECT 1'); holding(); await gate })
    await holdingP
    const started = Date.now()
    await expect(dbx.tx((tx) => tx.get('SELECT 2'))).rejects.toThrow(/timeout/i)
    expect(Date.now() - started).toBeLessThan(5000)
    letGo()
    await first
    expect(await dbx.get('SELECT 3 AS n')).toEqual({ n: 3 })
  })

  it('statement_timeout ends a long statement with 57014, and the connection is usable afterwards (pool of one)', async () => {
    const { dbx } = limitedDbx({ max: 1, statementTimeoutMs: 200 })
    const started = Date.now()
    await expect(dbx.get('SELECT pg_sleep(5)')).rejects.toMatchObject({ code: '57014' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await dbx.get('SELECT 1 AS one')).toEqual({ one: 1 })
  })

  it('lock_timeout ends a wait for a row lock with 55P03', async () => {
    const { dbx } = limitedDbx({ max: 3, lockTimeoutMs: 300 })
    await dbx.run('INSERT INTO dx_t (id, v) VALUES (1, 0)')
    let letGo!: () => void
    const gate = new Promise<void>((r) => { letGo = r })
    let locked!: () => void
    const lockedP = new Promise<void>((r) => { locked = r })
    const holder = dbx.tx(async (tx) => { await tx.run('UPDATE dx_t SET v = 1 WHERE id = 1'); locked(); await gate })
    await lockedP
    await expect(dbx.run('UPDATE dx_t SET v = 2 WHERE id = 1')).rejects.toMatchObject({ code: '55P03' })
    letGo()
    await holder
  })

  it('a backend killed while the body is idle: the process survives (the handler on the checked-out connection), the transaction fails, the pool keeps serving', async () => {
    const { dbx } = limitedDbx({ max: 1 })
    await expect(
      dbx.tx(async (tx) => {
        const pid = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid
        await db.pool.query('SELECT pg_terminate_backend($1)', [pid])
        await sleep(500) // no query is running: the connection error arrives as an event, not as a query error
        await tx.get('SELECT 2')
      }),
    ).rejects.toThrow()
    expect(await dbx.get('SELECT 1 AS one')).toEqual({ one: 1 })
  })

  it('idle_in_transaction_session_timeout ends a forgotten transaction; the pool keeps serving', async () => {
    const { dbx } = limitedDbx({ max: 1, idleInTransactionTimeoutMs: 300 })
    await expect(
      dbx.tx(async (tx) => {
        await tx.get('SELECT 1')
        await sleep(1500) // idle inside the transaction: the server terminates the session
        await tx.get('SELECT 2')
      }),
    ).rejects.toThrow()
    expect(await dbx.get('SELECT 1 AS one')).toEqual({ one: 1 }) // a new connection took its place
  })
})

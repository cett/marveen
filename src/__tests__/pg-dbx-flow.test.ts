// The control flow of the PostgreSQL adapter (src/db/pg/dbx.ts) against a FAKE pool: which statements go out in which
// order on which connection, when a connection is given back and how. No server, so the default suite and a local
// mutation run can pin the mechanics; what the server does with them (savepoints, the GUC lifetime, RLS-relevant
// behavior) is in src/__tests__/pg/dbx.pg.test.ts.
import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbContextForTest, runAs } from '../db/context.js'
import { createPgDbx, PG_SET_CONTEXT_SQL, STRICT_OUTSIDE_CALL_MESSAGE, type PgPoolLike } from '../db/pg/dbx.js'
import { pgTypes } from '../db/pg/types.js'
import { logger } from '../logger.js'

type Entry = { c: number; kind: 'q'; text: string; values?: unknown[]; types?: unknown } | { c: number; kind: 'release'; arg: unknown }

interface Hooks {
  /** An error to throw for this statement text (the n-th call overall), or nothing. */
  fail?: (text: string) => Error | undefined
  commitCommand?: string
  rows?: unknown[]
  rowCount?: number | null
}

function fakePool(hooks: Hooks = {}) {
  const log: Entry[] = []
  const state = { connects: 0, errorListeners: [] as Array<(e: Error) => void>, clients: [] as EventEmitter[] }
  const pool: PgPoolLike = {
    on(_event, listener) { state.errorListeners.push(listener); return pool },
    connect() {
      const c = ++state.connects
      // a real EventEmitter: an 'error' event nobody listens for throws, as it does on a pg client that is checked out
      const client = Object.assign(new EventEmitter(), {
        query(cfg: pg.QueryConfig) {
          log.push({ c, kind: 'q', text: cfg.text, values: cfg.values as unknown[] | undefined, types: cfg.types })
          const err = hooks.fail?.(cfg.text)
          if (err) return Promise.reject(err)
          return Promise.resolve({
            rows: hooks.rows ?? [],
            rowCount: hooks.rowCount === undefined ? 0 : hooks.rowCount,
            command: cfg.text === 'COMMIT' ? (hooks.commitCommand ?? 'COMMIT') : 'SELECT',
          } as never)
        },
        release(arg?: boolean | Error) { log.push({ c, kind: 'release', arg }) },
      })
      state.clients.push(client)
      return Promise.resolve(client)
    },
  }
  /** One connection's story: its statements (the context one is called CTX) and its release. */
  const story = (c: number): string[] =>
    log.filter((e) => e.c === c).map((e) => (e.kind === 'release' ? `release(${String(e.arg)})` : e.text === PG_SET_CONTEXT_SQL ? 'CTX' : e.text))
  const context = (c: number): unknown[] | undefined => {
    const e = log.find((x) => x.c === c && x.kind === 'q' && x.text === PG_SET_CONTEXT_SQL)
    return e && e.kind === 'q' ? e.values : undefined
  }
  return { pool, log, state, story, context }
}

const nop = (): Promise<void> => Promise.resolve()

// the calls here carry no db context on purpose in most cells; the warning about that is noise in this file
beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  resetDbContextForTest()
  vi.restoreAllMocks()
})

describe('a statement outside a transaction', () => {
  it('is BEGIN, the context in ONE statement, the work, COMMIT, and only then the release', async () => {
    const f = fakePool({ rows: [{ id: 7 }] })
    const dbx = createPgDbx(f.pool)
    expect(await dbx.get('SELECT id FROM t WHERE a = ? AND b = ?', 1, 'x')).toEqual({ id: 7 })
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', 'SELECT id FROM t WHERE a = $1 AND b = $2', 'COMMIT', 'release(false)'])
    expect(f.state.connects).toBe(1)
  })

  it('the context statement sets all four settings, transaction-locally, and nothing else rides on it', () => {
    expect(PG_SET_CONTEXT_SQL.match(/set_config\(/g)).toHaveLength(4)
    expect(PG_SET_CONTEXT_SQL.match(/, true\)/g)).toHaveLength(4)
    for (const g of ['app.tenant_id', 'app.role', 'app.agent_id', 'app.job']) expect(PG_SET_CONTEXT_SQL).toContain(`'${g}'`)
    expect(PG_SET_CONTEXT_SQL).not.toMatch(/\bWITH\b|\bFROM\b/i)
  })

  it('the work never carries the context with it (no set_config in a statement of the caller)', async () => {
    const f = fakePool()
    await createPgDbx(f.pool).run('UPDATE t SET a = ?', 1)
    const work = f.log.filter((e) => e.kind === 'q' && !['BEGIN', 'COMMIT', PG_SET_CONTEXT_SQL].includes(e.text))
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({ text: 'UPDATE t SET a = $1' })
  })

  it('takes the four values from the context of the call: tenant, agent, system job, and none', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await runAs.tenant('tenant-a', () => dbx.get('SELECT 1'))
    await runAs.agent('agent-a', 'tenant-b', () => dbx.get('SELECT 1'))
    await runAs.system('job-x', () => dbx.get('SELECT 1'))
    await dbx.get('SELECT 1')
    expect(f.context(1)).toEqual(['tenant-a', 'tenant', '', ''])
    expect(f.context(2)).toEqual(['tenant-b', 'agent', 'agent-a', ''])
    expect(f.context(3)).toEqual(['', 'system', '', 'job-x'])
    expect(f.context(4)).toEqual(['', '', '', '']) // no context: empty, never a default tenant
  })

  it('a failing statement is rolled back, the connection goes back only after that, and the same error comes out', async () => {
    const boom = new Error('boom')
    const f = fakePool({ fail: (t) => (t.startsWith('UPDATE') ? boom : undefined) })
    await expect(createPgDbx(f.pool).run('UPDATE t SET a = ?', 1)).rejects.toBe(boom)
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', 'UPDATE t SET a = $1', 'ROLLBACK', 'release(false)'])
  })

  it('a ROLLBACK that fails destroys the connection instead of returning it', async () => {
    const boom = new Error('boom')
    const f = fakePool({ fail: (t) => (t === 'ROLLBACK' ? new Error('gone') : t.startsWith('UPDATE') ? boom : undefined) })
    await expect(createPgDbx(f.pool).run('UPDATE t SET a = ?', 1)).rejects.toBe(boom)
    expect(f.story(1).at(-1)).toBe('release(true)')
  })

  it('a BEGIN that fails still ends with a ROLLBACK attempt and a release', async () => {
    const f = fakePool({ fail: (t) => (t === 'BEGIN' ? new Error('no begin') : undefined) })
    await expect(createPgDbx(f.pool).get('SELECT 1')).rejects.toThrow('no begin')
    expect(f.story(1)).toEqual(['BEGIN', 'ROLLBACK', 'release(false)'])
  })

  it('a COMMIT that the server turned into a ROLLBACK is a failure, not a success', async () => {
    const f = fakePool({ commitCommand: 'ROLLBACK' })
    await expect(createPgDbx(f.pool).run('UPDATE t SET a = ?', 1)).rejects.toThrow(/nothing was committed/)
  })

  it('a mistake in the parameters rejects before any connection is taken', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await expect(dbx.get('SELECT ?')).rejects.toThrow(/1 placeholder but 0 parameters/)
    await expect(dbx.all('SELECT 1', 5)).rejects.toThrow(/0 placeholders/)
    expect(f.state.connects).toBe(0)
  })

  it('two statements at once take two connections, each wrapped in its own transaction', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await Promise.all([dbx.get('SELECT 1'), dbx.get('SELECT 2')])
    expect(f.state.connects).toBe(2)
    for (const c of [1, 2]) expect(f.story(c)[0]).toBe('BEGIN')
    for (const c of [1, 2]) expect(f.story(c).slice(-2)).toEqual(['COMMIT', 'release(false)'])
  })

  it('exec sends the text as it is (no translation, no parameters), still inside the wrapper', async () => {
    const f = fakePool()
    await createPgDbx(f.pool).exec('CREATE TABLE t (a text); INSERT INTO t VALUES (\'?\')')
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', "CREATE TABLE t (a text); INSERT INTO t VALUES ('?')", 'COMMIT', 'release(false)'])
  })
})

describe('the rows', () => {
  it('get is the first row or undefined; all is the rows; every query asks for checked int8 numbers', async () => {
    const f = fakePool({ rows: [{ a: 1 }, { a: 2 }] })
    const dbx = createPgDbx(f.pool)
    expect(await dbx.get('SELECT a FROM t')).toEqual({ a: 1 })
    expect(await dbx.all('SELECT a FROM t')).toEqual([{ a: 1 }, { a: 2 }])
    expect(await createPgDbx(fakePool().pool).get('SELECT a FROM t')).toBeUndefined()
    const typed = f.log.filter((e) => e.kind === 'q' && e.text === 'SELECT a FROM t')
    expect(typed.length).toBe(2)
    for (const e of typed) expect(e.kind === 'q' && e.types).toBe(pgTypes)
  })

  it('run reports the row count as changes (a null count is 0) and lastInsertRowid is always 0', async () => {
    expect(await createPgDbx(fakePool({ rowCount: 3 }).pool).run('UPDATE t SET a = 1')).toEqual({ changes: 3, lastInsertRowid: 0 })
    expect(await createPgDbx(fakePool({ rowCount: null }).pool).run('UPDATE t SET a = 1')).toEqual({ changes: 0, lastInsertRowid: 0 })
  })
})

describe('a transaction', () => {
  it('opens once (BEGIN, the context), runs the body on one connection, COMMIT, then releases', async () => {
    const f = fakePool()
    const result = await createPgDbx(f.pool).tx(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', 1)
      await tx.get('SELECT 1')
      return 'done'
    })
    expect(result).toBe('done')
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', 'INSERT INTO t VALUES ($1)', 'SELECT 1', 'COMMIT', 'release(false)'])
    expect(f.state.connects).toBe(1)
  })

  it('a body that throws is rolled back (no COMMIT), released after, and the same error comes out', async () => {
    const boom = new Error('body failed')
    const f = fakePool()
    await expect(createPgDbx(f.pool).tx(async (tx) => { await tx.run('INSERT INTO t VALUES (1)'); throw boom })).rejects.toBe(boom)
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', 'INSERT INTO t VALUES (1)', 'ROLLBACK', 'release(false)'])
  })

  it('a ROLLBACK that fails destroys the connection', async () => {
    const f = fakePool({ fail: (t) => (t === 'ROLLBACK' ? new Error('gone') : undefined) })
    await expect(createPgDbx(f.pool).tx(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(f.story(1).at(-1)).toBe('release(true)')
  })

  it('a body that swallowed a failure and returned normally: COMMIT answers ROLLBACK, the transaction fails', async () => {
    const f = fakePool({ commitCommand: 'ROLLBACK', fail: (t) => (t === 'BAD' ? new Error('syntax') : undefined) })
    await expect(
      createPgDbx(f.pool).tx(async (tx) => {
        await tx.exec('BAD').catch(() => undefined)
        return 'looks fine'
      }),
    ).rejects.toThrow(/nothing was committed/)
  })

  it('a COMMIT that fails is rolled back and the connection released after', async () => {
    const f = fakePool({ fail: (t) => (t === 'COMMIT' ? new Error('deferred constraint') : undefined) })
    await expect(createPgDbx(f.pool).tx(async (tx) => { await tx.get('SELECT 1') })).rejects.toThrow('deferred constraint')
    expect(f.story(1).slice(-3)).toEqual(['COMMIT', 'ROLLBACK', 'release(false)'])
  })

  it('takes the context once, when it opens: a runAs inside the body does not change it', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await runAs.tenant('tenant-a', () =>
      dbx.tx(async (tx) => {
        await runAs.tenant('tenant-b', () => tx.get('SELECT 1'))
        await tx.get('SELECT 2')
      }),
    )
    expect(f.log.filter((e) => e.kind === 'q' && e.text === PG_SET_CONTEXT_SQL)).toHaveLength(1)
    expect(f.context(1)).toEqual(['tenant-a', 'tenant', '', ''])
  })

  it('mode: immediate means nothing on PostgreSQL: the same plain BEGIN', async () => {
    const f = fakePool()
    await createPgDbx(f.pool).tx(nop, { mode: 'immediate' })
    expect(f.story(1)[0]).toBe('BEGIN')
  })

  it('the handle refuses once the transaction has finished, and a mistake in its parameters is a rejection that rolls back', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    let kept: Parameters<Parameters<typeof dbx.tx>[0]>[0] | undefined
    await dbx.tx((tx) => { kept = tx; return nop() })
    await expect(kept!.get('SELECT 1')).rejects.toThrow(/already finished/)
    await expect(kept!.tx(nop)).rejects.toThrow(/already finished/)
    await expect(dbx.tx(async (tx) => { await tx.get('SELECT ?') })).rejects.toThrow(/1 placeholder/)
    expect(f.story(2).slice(-2)).toEqual(['ROLLBACK', 'release(false)'])
  })

  it('two transactions at once run on two connections with no lock between them', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = dbx.tx(async (tx) => { await tx.get('SELECT 1'); await gate })
    const second = dbx.tx(async (tx) => { await tx.get('SELECT 2') })
    await second // finished while the first one is still open
    expect(f.state.connects).toBe(2)
    expect(f.story(2).at(-1)).toBe('release(false)')
    expect(f.story(1).at(-1)).toBe('SELECT 1')
    release()
    await first
  })
})

describe('savepoints (a transaction inside a transaction)', () => {
  it('opens a SAVEPOINT on the same connection and releases it; the outer transaction commits', async () => {
    const f = fakePool()
    await createPgDbx(f.pool).tx(async (tx) => {
      await tx.tx(async (inner) => { await inner.run('INSERT INTO t VALUES (1)') })
    })
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', 'SAVEPOINT dbx_sp_1', 'INSERT INTO t VALUES (1)', 'RELEASE SAVEPOINT dbx_sp_1', 'COMMIT', 'release(false)'])
    expect(f.state.connects).toBe(1)
  })

  it('a failing inner body rolls back to the savepoint only; the outer goes on and commits', async () => {
    const f = fakePool()
    await createPgDbx(f.pool).tx(async (tx) => {
      await tx.tx(() => Promise.reject(new Error('inner'))).catch(() => undefined)
      await tx.run('INSERT INTO t VALUES (2)')
    })
    expect(f.story(1)).toEqual([
      'BEGIN', 'CTX', 'SAVEPOINT dbx_sp_1', 'ROLLBACK TO SAVEPOINT dbx_sp_1', 'RELEASE SAVEPOINT dbx_sp_1', 'INSERT INTO t VALUES (2)', 'COMMIT', 'release(false)',
    ])
  })

  it('the inner error reaches the caller, and an outer body that does not catch it rolls everything back', async () => {
    const inner = new Error('inner')
    const f = fakePool()
    await expect(createPgDbx(f.pool).tx(async (tx) => { await tx.tx(() => Promise.reject(inner)) })).rejects.toBe(inner)
    expect(f.story(1).slice(-3)).toEqual(['RELEASE SAVEPOINT dbx_sp_1', 'ROLLBACK', 'release(false)'])
  })

  it('savepoints side by side run one after the other, with names that do not collide; nested ones count on', async () => {
    const f = fakePool()
    await createPgDbx(f.pool).tx(async (tx) => {
      await Promise.all([
        tx.tx(async (a) => { await a.get('SELECT "a"'); await a.tx(async (deep) => { await deep.get('SELECT "deep"') }) }),
        tx.tx(async (b) => { await b.get('SELECT "b"') }),
      ])
    })
    expect(f.story(1)).toEqual([
      'BEGIN', 'CTX',
      'SAVEPOINT dbx_sp_1', 'SELECT "a"', 'SAVEPOINT dbx_sp_2', 'SELECT "deep"', 'RELEASE SAVEPOINT dbx_sp_2', 'RELEASE SAVEPOINT dbx_sp_1',
      'SAVEPOINT dbx_sp_3', 'SELECT "b"', 'RELEASE SAVEPOINT dbx_sp_3',
      'COMMIT', 'release(false)',
    ])
  })
})

describe('the strict rule: inside a transaction body the handle is used, not the outer dbx', () => {
  it('an outer statement or transaction in the body is refused, and no second connection is taken', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    const seen: string[] = []
    await dbx.tx(async () => {
      for (const call of [() => dbx.get('SELECT 1'), () => dbx.all('SELECT 1'), () => dbx.run('SELECT 1'), () => dbx.exec('SELECT 1'), () => dbx.tx(nop)]) {
        await call().catch((e: Error) => seen.push(e.message))
      }
    })
    expect(seen).toEqual(Array(5).fill(STRICT_OUTSIDE_CALL_MESSAGE))
    expect(f.state.connects).toBe(1)
  })

  it('also inside a savepoint body', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await dbx.tx(async (tx) => {
      await tx.tx(async () => {
        await expect(dbx.get('SELECT 1')).rejects.toThrow(STRICT_OUTSIDE_CALL_MESSAGE)
      })
    })
    expect(f.state.connects).toBe(1)
  })

  it('{ ambient: true } allows the outer call, on a connection of its own and in its own transaction', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await dbx.tx(async (tx) => {
      await tx.get('SELECT "in the tx"')
      await dbx.get('SELECT "outside"')
    }, { ambient: true })
    expect(f.story(1)).toEqual(['BEGIN', 'CTX', 'SELECT "in the tx"', 'COMMIT', 'release(false)'])
    expect(f.story(2)).toEqual(['BEGIN', 'CTX', 'SELECT "outside"', 'COMMIT', 'release(false)'])
  })

  it('ambient carries into a savepoint body', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    await dbx.tx(async (tx) => {
      await tx.tx(async () => { await dbx.get('SELECT 1') })
    }, { ambient: true })
    expect(f.state.connects).toBe(2)
  })

  it('a Dbx on ANOTHER pool inside the body is not an outer call of this one', async () => {
    const a = fakePool()
    const b = fakePool()
    const dbxA = createPgDbx(a.pool)
    const dbxB = createPgDbx(b.pool)
    await dbxA.tx(async () => { await dbxB.get('SELECT 1') })
    expect(b.state.connects).toBe(1)
  })

  it('a call that runs after the transaction has finished (a timer the body left behind) is an ordinary outer call', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    let late: Promise<unknown> | undefined
    await dbx.tx(() => {
      late = new Promise((resolve) => setTimeout(resolve, 5)).then(() => dbx.get('SELECT "late"'))
      return nop()
    })
    await expect(late).resolves.toBeUndefined()
    expect(f.story(2)).toEqual(['BEGIN', 'CTX', 'SELECT "late"', 'COMMIT', 'release(false)'])
  })
})

describe('a connection that drops while it is checked out', () => {
  it('an error event on it is logged and the connection is destroyed, in a transaction and in a lone statement; the listener is gone after', async () => {
    const f = fakePool()
    const dbx = createPgDbx(f.pool)
    let drop!: () => void
    const gate = new Promise<void>((r) => { drop = r })
    const running = dbx.tx(async (tx) => {
      await tx.get('SELECT 1')
      f.state.clients[0]!.emit('error', new Error('terminating connection')) // no query is running: the event would end the process
      await gate
    })
    await vi.waitFor(() => expect(f.state.clients[0]!.listenerCount('error')).toBe(1))
    drop()
    await running
    expect(f.story(1).at(-1)).toBe('release(true)')
    expect(f.state.clients[0]!.listenerCount('error')).toBe(0)

    await dbx.get('SELECT 2')
    expect(f.story(2).at(-1)).toBe('release(false)') // a healthy connection still goes back normally
    expect(f.state.clients[1]!.listenerCount('error')).toBe(0)

    const g: ReturnType<typeof fakePool> = fakePool({
      fail: (t) => {
        if (t === 'SELECT 3') g.state.clients[0]!.emit('error', new Error('terminating connection'))
        return undefined
      },
    })
    await createPgDbx(g.pool).get('SELECT 3')
    expect(g.story(1).at(-1)).toBe('release(true)')
  })
})

describe('the pool and the slow transaction', () => {
  it('registers a listener for the error event of an idle client, which logs and does not throw', () => {
    const f = fakePool()
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    createPgDbx(f.pool)
    expect(f.state.errorListeners).toHaveLength(1)
    expect(() => f.state.errorListeners[0]!(new Error('server restarted'))).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a transaction open longer than txWarnMs is logged once, with where it was opened; a short one is not; 0 turns it off', async () => {
    const spy = vi.mocked(logger.warn)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const dbx = createPgDbx(fakePool().pool, { txWarnMs: 40 })
    await dbx.tx(async () => { await sleep(120) })
    await dbx.tx(nop)
    const warns = spy.mock.calls.filter((c) => String(c[1]).includes('DB_TX_WARN_MS'))
    expect(warns).toHaveLength(1)
    expect(String((warns[0]![0] as { origin: string }).origin)).toContain('pg-dbx-flow.test')
    spy.mockClear()
    await createPgDbx(fakePool().pool, { txWarnMs: 0 }).tx(async () => { await sleep(60) })
    expect(spy.mock.calls.filter((c) => String(c[1]).includes('DB_TX_WARN_MS'))).toHaveLength(0)
  })
})

describe('the invariant behind the leak cells: a connection is never released between BEGIN and COMMIT/ROLLBACK', () => {
  it('holds for every path above (success, body throw, failing statement, failing COMMIT, failing ROLLBACK)', async () => {
    const scenarios: Array<[Hooks, (d: ReturnType<typeof createPgDbx>) => Promise<unknown>]> = [
      [{}, (d) => d.get('SELECT 1')],
      [{ fail: (t) => (t === 'SELECT 1' ? new Error('x') : undefined) }, (d) => d.get('SELECT 1')],
      [{}, (d) => d.tx(async (tx) => { await tx.get('SELECT 1') })],
      [{}, (d) => d.tx(() => Promise.reject(new Error('x')))],
      [{ fail: (t) => (t === 'COMMIT' ? new Error('x') : undefined) }, (d) => d.tx(nop)],
      [{ fail: (t) => (t === 'ROLLBACK' || t === 'SELECT 1' ? new Error('x') : undefined) }, (d) => d.get('SELECT 1')],
    ]
    for (const [hooks, run] of scenarios) {
      const f = fakePool(hooks)
      await run(createPgDbx(f.pool)).catch(() => undefined)
      const s = f.story(1)
      const release = s.findIndex((x) => x.startsWith('release('))
      expect(release).toBe(s.length - 1)
      // the statement right before the release ended the transaction (COMMIT answered, or ROLLBACK attempted)
      expect(['COMMIT', 'ROLLBACK']).toContain(s[release - 1])
    }
  })
})

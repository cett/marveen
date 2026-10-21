// dbx.tx and the connection-level async lock: transactions never overlap, a statement outside a
// transaction waits for an open one, the order is FIFO, an error rolls back and frees the lock, a nested
// transaction is a savepoint, and the immediate mode takes the write lock at BEGIN.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase, dbx, db } from '../db.js'
import { lockFor } from '../db/tx-lock.js'
import { logger } from '../logger.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

beforeEach(async () => {
  initDatabase(':memory:')
  await dbx.exec('CREATE TABLE tx_t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
})

const names = async () => (await dbx.all<{ name: string }>('SELECT name FROM tx_t ORDER BY id')).map((r) => r.name)
const count = async () => (await dbx.get<{ c: number }>('SELECT COUNT(*) AS c FROM tx_t'))!.c

describe('dbx.tx basics', () => {
  it('commits the body and returns its value', async () => {
    const out = await dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'a')
      return (await tx.get<{ name: string }>('SELECT name FROM tx_t'))!.name
    })
    expect(out).toBe('a')
    expect(await names()).toEqual(['a'])
    expect(db.inTransaction).toBe(false)
  })

  it('a statement through the outer dbx inside the body is part of the transaction', async () => {
    await expect(dbx.tx(async () => {
      await dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'inner')
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await names()).toEqual([])
  })
})

describe('the connection lock', () => {
  // (1) two parallel transactions do not overlap
  it('two parallel transactions do not overlap: the second starts after the first committed', async () => {
    const events: string[] = []
    const a = dbx.tx(async (tx) => {
      events.push('a-start')
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'a')
      await sleep(20)
      events.push('a-end')
    })
    const b = dbx.tx(async (tx) => {
      events.push('b-start')
      events.push(`b-sees-${(await tx.get<{ c: number }>('SELECT COUNT(*) AS c FROM tx_t'))!.c}`)
    })
    await Promise.all([a, b])
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-sees-1'])
  })

  // (2) a statement outside waits for the open transaction and sees the result after the commit
  it('a statement outside a transaction waits and reads the committed result', async () => {
    let committed = false
    const t = dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'a')
      await sleep(20)
      committed = true
    })
    await sleep(5)
    const read = dbx.get<{ c: number }>('SELECT COUNT(*) AS c FROM tx_t').then((r) => ({ c: r!.c, committedAtRead: committed }))
    await t
    expect(await read).toEqual({ c: 1, committedAtRead: true })
  })

  it('a statement outside a transaction never reads uncommitted rows of a transaction that rolls back', async () => {
    const t = dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'dirty')
      await sleep(20)
      throw new Error('undo')
    })
    const settled = t.catch(() => undefined)
    await sleep(5)
    const read = dbx.get<{ c: number }>('SELECT COUNT(*) AS c FROM tx_t')
    await settled
    expect((await read)!.c).toBe(0)
  })

  // (3) FIFO
  it('keeps the arrival order across statements and transactions', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const holder = dbx.tx(async () => { await gate })
    await sleep(2)
    const q1 = dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'q1')
    const q2 = dbx.tx(async (tx) => { await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'q2') })
    const q3 = dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'q3')
    const q4 = dbx.tx(async (tx) => { await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'q4') })
    open()
    await Promise.all([holder, q1, q2, q3, q4])
    expect(await names()).toEqual(['q1', 'q2', 'q3', 'q4'])
  })

  // (4) an error in the body: rollback, the lock is free, the next call runs
  it('a throwing body rolls back, frees the lock and the next call runs', async () => {
    const failure = new Error('body failed')
    await expect(dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'gone')
      throw failure
    })).rejects.toBe(failure)
    expect(lockFor(db).busy).toBe(false)
    expect(db.inTransaction).toBe(false)
    expect(await count()).toBe(0)
    await dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'next')
    expect(await names()).toEqual(['next'])
  })

  it('a rejecting body of a transaction in the queue does not block the ones behind it', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const holder = dbx.tx(async () => { await gate })
    await sleep(2)
    const bad = dbx.tx(async () => { throw new Error('queued failure') }).catch((e: Error) => e.message)
    const good = dbx.tx(async (tx) => { await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'ok') })
    open()
    await holder
    expect(await bad).toBe('queued failure')
    await good
    expect(await names()).toEqual(['ok'])
  })

  it('a bad statement in the body rolls everything back and frees the lock', async () => {
    await expect(dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'x')
      await tx.run('INSERT INTO tx_t (nope) VALUES (?)', 'y')
    })).rejects.toThrow(/nope/i)
    expect(await count()).toBe(0)
    expect(lockFor(db).busy).toBe(false)
  })

  it('the handle of a finished transaction refuses to work', async () => {
    let stray!: Parameters<Parameters<typeof dbx.tx>[0]>[0]
    await dbx.tx(async (tx) => { stray = tx })
    await expect(stray.run('INSERT INTO tx_t (name) VALUES (?)', 'late')).rejects.toThrow(/already finished/)
    await expect(stray.tx(async () => 1)).rejects.toThrow(/already finished/)
    expect(await count()).toBe(0)
  })

  it('a call that still carries a finished transaction scope waits like any outside call', async () => {
    let lateCall!: () => Promise<unknown>
    await dbx.tx(async () => {
      lateCall = () => dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'late')
    })
    // Another transaction is open: the late call must queue behind it, not run inside it.
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const holder = dbx.tx(async () => { await gate })
    await sleep(2)
    let ran = false
    const late = lateCall().then(() => { ran = true })
    await sleep(10)
    expect(ran).toBe(false)
    open()
    await Promise.all([holder, late])
    expect(ran).toBe(true)
  })

  it('the lock belongs to the connection: initDatabase() again starts with a free one', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const hung = dbx.tx(async () => { await gate })
    await sleep(2)
    expect(lockFor(db).busy).toBe(true)
    initDatabase(':memory:')
    expect(lockFor(db).busy).toBe(false)
    open()
    await hung.catch(() => undefined)
  })
})

describe('nested transactions (savepoints)', () => {
  // (5)
  it('an error in a nested body undoes only the nested part', async () => {
    await dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'outer-1')
      await tx.tx(async (inner) => {
        await inner.run('INSERT INTO tx_t (name) VALUES (?)', 'inner')
        throw new Error('inner failed')
      }).catch(() => undefined)
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'outer-2')
    })
    expect(await names()).toEqual(['outer-1', 'outer-2'])
  })

  it('a successful nested body is kept, and a failing outer body takes it back', async () => {
    await expect(dbx.tx(async (tx) => {
      await tx.tx(async (inner) => { await inner.run('INSERT INTO tx_t (name) VALUES (?)', 'inner') })
      throw new Error('outer failed')
    })).rejects.toThrow('outer failed')
    expect(await count()).toBe(0)
  })

  it('dbx.tx inside a body is a savepoint too, and nesting goes more than one level deep', async () => {
    await dbx.tx(async () => {
      await dbx.tx(async () => {
        await dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'l2')
        await dbx.tx(async () => {
          await dbx.run('INSERT INTO tx_t (name) VALUES (?)', 'l3')
          throw new Error('l3 failed')
        }).catch(() => undefined)
      })
    })
    expect(await names()).toEqual(['l2'])
  })

  it('savepoints opened side by side run one after the other', async () => {
    const events: string[] = []
    await dbx.tx(async (tx) => {
      await Promise.all([
        tx.tx(async (a) => { events.push('a-start'); await sleep(10); await a.run('INSERT INTO tx_t (name) VALUES (?)', 'a'); events.push('a-end') }),
        tx.tx(async (b) => { events.push('b-start'); await b.run('INSERT INTO tx_t (name) VALUES (?)', 'b'); events.push('b-end') }),
      ])
    })
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    expect(await names()).toEqual(['a', 'b'])
  })
})

describe('immediate mode', () => {
  // (6)
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbx-tx-'))
    file = join(dir, 'tx.db')
    initDatabase(file)
    db.exec('CREATE TABLE IF NOT EXISTS tx_t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const otherConnectionCanTakeWriteLock = (): boolean => {
    const other = new Database(file)
    try {
      other.exec('BEGIN IMMEDIATE')
      other.exec('ROLLBACK')
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'SQLITE_BUSY') return false
      throw err
    } finally {
      other.close()
    }
  }

  it('immediate takes the write lock at BEGIN, deferred does not before the first write', async () => {
    let deferredFree: boolean | undefined
    await dbx.tx(async () => { deferredFree = otherConnectionCanTakeWriteLock() })
    expect(deferredFree).toBe(true)

    let immediateFree: boolean | undefined
    await dbx.tx(async () => { immediateFree = otherConnectionCanTakeWriteLock() }, { mode: 'immediate' })
    expect(immediateFree).toBe(false)

    // and the transaction itself works
    await dbx.tx(async (tx) => { await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'imm') }, { mode: 'immediate' })
    expect((await dbx.all<{ name: string }>('SELECT name FROM tx_t')).map((r) => r.name)).toEqual(['imm'])
  })
})

describe('slow transaction warning', () => {
  const original = process.env.DB_TX_WARN_MS
  afterEach(() => {
    if (original === undefined) delete process.env.DB_TX_WARN_MS
    else process.env.DB_TX_WARN_MS = original
    vi.restoreAllMocks()
  })

  const slowWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) => String(c[1] ?? '').includes('DB_TX_WARN_MS'))

  it('logs where a transaction was opened once it is open longer than DB_TX_WARN_MS, and does not abort it', async () => {
    process.env.DB_TX_WARN_MS = '15'
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    await dbx.tx(async (tx) => {
      await tx.run('INSERT INTO tx_t (name) VALUES (?)', 'slow')
      await sleep(60)
    })
    const calls = slowWarnings(warn)
    expect(calls.length).toBe(1)
    expect(String((calls[0][0] as { origin: string }).origin)).toContain('db-facade-tx.test')
    expect(await names()).toEqual(['slow'])
  })

  it('stays quiet for a fast transaction and when the warning is off', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    process.env.DB_TX_WARN_MS = '0'
    await dbx.tx(async () => { await sleep(30) })
    process.env.DB_TX_WARN_MS = '5000'
    await dbx.tx(async () => { await sleep(5) })
    expect(slowWarnings(warn)).toEqual([])
  })
})

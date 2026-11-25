// A failed INSERT of an incoming event must not move the poll offset past the update (Telegram does not send an update below the
// confirmed offset again, so that would LOSE the message). processBatch returns the highest DURABLE update id; on an insert
// failure the batch stops and returns the last one that was stored (or deduplicated, or not stored on purpose), null when the
// first one fails. A handoff failure is a different case: the event is stored and the replay hands it off.
//
// The ingest module is wrapped: insertIncomingEvent throws for the update ids in `failing`, everything else is the real code on
// the real (in-memory) SQLite database.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// the alert of a given-up update runs a shell script: no test may reach it, the call is recorded instead
const alerts: string[][] = []
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (_file: string, args: string[]) => { alerts.push(args); return {} },
}))

const failing = new Set<number>()
// the read the give-up decision probes the database with: true = the database does not answer
let probeFails = false
vi.mock('../channel-coordinator/ingest.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-coordinator/ingest.js')>()
  return {
    ...real,
    getOffset: (source: string) => (probeFails ? Promise.reject(new Error('pool: connection terminated')) : real.getOffset(source)),
    insertIncomingEvent: (source: string, ev: Parameters<typeof real.insertIncomingEvent>[1]) => {
      if (failing.has(ev.update_id)) return Promise.reject(new Error('pool: connection terminated'))
      return real.insertIncomingEvent(source, ev)
    },
  }
})

import { useAccessFile } from './helpers/coordinator-access.js'
import { closeDatabase, getDb, initProcessDatabase } from '../db/connection.js'
import { processBatch, resetInsertFailuresForTests, POISON_INSERT_FAILURES, lastBatchStoppedOnFailure, setPoisonMinAgeForTests, insertFailStreakValue } from '../channel-coordinator-main.js'

// the sender gate is default-deny: the owner chat of the fixtures (1001) is on a throwaway access list
useAccessFile()

const upd = (id: number) => ({ update_id: id, message: { message_id: id, date: 1, text: 't', chat: { id: 1001 }, from: { id: 1001 } } })
const stored = (): number[] => (getDb().prepare('SELECT update_id FROM incoming_events ORDER BY update_id').all() as { update_id: number }[]).map((r) => r.update_id)

beforeEach(() => { alerts.length = 0; failing.clear(); probeFails = false; resetInsertFailuresForTests(); initProcessDatabase(':memory:') })
afterEach(() => { closeDatabase(); vi.useRealTimers() })

describe('processBatch and a failed insert', () => {
  it('3 updates, the 2nd insert fails: the batch stops, the 3rd is not stored, the offset stays at the 1st', async () => {
    failing.add(2)
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(1)
    expect(stored()).toEqual([1])
  })

  it('the next poll asks for the update again: with the database back, all three end up stored once', async () => {
    failing.add(2)
    await processBatch([upd(1), upd(2), upd(3)])
    failing.clear()
    // Telegram sends everything above the confirmed offset (1) again; the dedupe key keeps the stored one single
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(3)
    expect(stored()).toEqual([1, 2, 3])
  })

  it('the first insert fails: nothing is durable, null comes back (the caller does not move the offset)', async () => {
    failing.add(1)
    expect(await processBatch([upd(1), upd(2)])).toBeNull()
    expect(stored()).toEqual([])
  })

  it('the last insert fails: everything before it is durable', async () => {
    failing.add(3)
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(2)
  })

  it('an unhandled update kind before the failure is durable (it is not stored on purpose)', async () => {
    failing.add(2)
    expect(await processBatch([{ update_id: 1 }, upd(2)])).toBe(1)
  })

  it('a duplicate before the failure is durable (it is already stored)', async () => {
    await processBatch([upd(1)])
    failing.add(2)
    expect(await processBatch([upd(1), upd(2)])).toBe(1)
  })

  it('a batch with no failure is unchanged: the highest id comes back and everything is stored', async () => {
    expect(await processBatch([upd(5), upd(3), upd(4)])).toBe(5)
    expect(stored()).toEqual([3, 4, 5])
  })
})

describe('an insert that keeps failing does not hold the queue for ever', () => {
  beforeEach(() => { setPoisonMinAgeForTests(0) }) // the count and the probe are under test here; the age has its own cells below
  it('every failure stops the batch and raises the flag the loop waits on; the offset stays below the update', async () => {
    failing.add(2)
    for (let i = 1; i < POISON_INSERT_FAILURES; i++) {
      expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(1)
      expect(lastBatchStoppedOnFailure()).toBe(true)
    }
    expect(stored()).toEqual([1])
    expect(alerts).toEqual([]) // no alert before the limit
  })

  it('after the limit the update is given up and the batch goes on past it (the ones behind it are stored)', async () => {
    failing.add(2)
    for (let i = 1; i < POISON_INSERT_FAILURES; i++) await processBatch([upd(1), upd(2), upd(3)])
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(3)
    expect(lastBatchStoppedOnFailure()).toBe(false)
    expect(stored()).toEqual([1, 3])
    // given up LOUDLY: one alert, naming the update id and no content
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.[1]).toContain('update 2 ')
  })

  it('a success in between resets the count: the failures must be of the SAME update, one after the other', async () => {
    failing.add(2)
    for (let i = 1; i < POISON_INSERT_FAILURES; i++) await processBatch([upd(2)])
    failing.clear()
    expect(await processBatch([upd(2)])).toBe(2)
    failing.add(2)
    expect(await processBatch([upd(4), upd(2)])).toBe(4)
    expect(lastBatchStoppedOnFailure()).toBe(true) // a fresh count: one failure STOPS the batch, it is not given up
    expect(alerts).toEqual([])
  })

  it('a batch with no failure leaves the flag down', async () => {
    await processBatch([upd(1)])
    expect(lastBatchStoppedOnFailure()).toBe(false)
  })
})

describe('the give-up needs the count AND the age AND a database that answers', () => {
  const MIN = 60 * 1000
  const failTimes = async (n: number, ids = [upd(1), upd(2), upd(3)]) => { for (let i = 0; i < n; i++) await processBatch(ids) }

  it('twelve failures within seconds: not given up, no alert, the offset stays below the update (an outage must not eat a message)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    failing.add(2)
    await failTimes(POISON_INSERT_FAILURES + 2)
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(1)
    expect(lastBatchStoppedOnFailure()).toBe(true)
    expect(stored()).toEqual([1])
    expect(alerts).toEqual([])
  })

  it('count and age reached but the database does not answer a read: not given up (it is an outage, not the data)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    failing.add(2)
    await failTimes(POISON_INSERT_FAILURES)
    vi.setSystemTime(Date.now() + 11 * MIN)
    probeFails = true
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(1)
    expect(lastBatchStoppedOnFailure()).toBe(true)
    expect(alerts).toEqual([])
    // the database comes back, the same update is still failing: now the probe answers and it is given up
    probeFails = false
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(3)
    expect(alerts).toHaveLength(1)
  })

  it('count, age and a database that answers: given up, one alert naming the id, the rest of the batch stored', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    failing.add(2)
    await failTimes(POISON_INSERT_FAILURES)
    vi.setSystemTime(Date.now() + 10 * MIN)
    expect(await processBatch([upd(1), upd(2), upd(3)])).toBe(3)
    expect(lastBatchStoppedOnFailure()).toBe(false)
    expect(stored()).toEqual([1, 3])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.[1]).toContain('update 2 ')
  })

  it('the age counts from the FIRST failure of that update, and a success in between starts it over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    failing.add(2)
    await failTimes(3)
    vi.setSystemTime(Date.now() + 20 * MIN) // old failures, but then the update goes through ...
    failing.clear()
    expect(await processBatch([upd(2)])).toBe(2)
    failing.add(4)
    await failTimes(POISON_INSERT_FAILURES, [upd(4)]) // ... and a new one starts a new clock: count reached, age not
    expect(await processBatch([upd(4)])).toBeNull()
    expect(alerts).toEqual([])
  })
})

describe('the backoff counter of the loop is the insert-failure streak', () => {
  it('it grows with each batch that stops at a failed insert and drops to zero after a batch that does not', async () => {
    failing.add(2)
    expect(insertFailStreakValue()).toBe(0)
    for (let i = 1; i <= 4; i++) {
      await processBatch([upd(1), upd(2)])
      expect(insertFailStreakValue()).toBe(i)
    }
    failing.clear()
    await processBatch([upd(1), upd(2)])
    expect(insertFailStreakValue()).toBe(0)
  })

  it('a batch that gave the update up also ends the streak', async () => {
    setPoisonMinAgeForTests(0)
    failing.add(2)
    for (let i = 0; i < POISON_INSERT_FAILURES; i++) await processBatch([upd(2)])
    expect(insertFailStreakValue()).toBe(0)
  })
})

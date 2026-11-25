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
vi.mock('../channel-coordinator/ingest.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-coordinator/ingest.js')>()
  return {
    ...real,
    insertIncomingEvent: (source: string, ev: Parameters<typeof real.insertIncomingEvent>[1]) => {
      if (failing.has(ev.update_id)) return Promise.reject(new Error('pool: connection terminated'))
      return real.insertIncomingEvent(source, ev)
    },
  }
})

import { closeDatabase, getDb, initProcessDatabase } from '../db/connection.js'
import { processBatch, resetInsertFailuresForTests, POISON_INSERT_FAILURES, lastBatchStoppedOnFailure } from '../channel-coordinator-main.js'

const upd = (id: number) => ({ update_id: id, message: { message_id: id, date: 1, text: 't', chat: { id: 1001 }, from: { id: 1001 } } })
const stored = (): number[] => (getDb().prepare('SELECT update_id FROM incoming_events ORDER BY update_id').all() as { update_id: number }[]).map((r) => r.update_id)

beforeEach(() => { alerts.length = 0; failing.clear(); resetInsertFailuresForTests(); initProcessDatabase(':memory:') })
afterEach(() => { closeDatabase() })

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

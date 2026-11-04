// AsyncLock, the FIFO mutex under the connection lock: a lock that is handed to the next waiter never looks
// free on the way, and a release function works once.

import { describe, it, expect } from 'vitest'
import { AsyncLock } from '../db/tx-lock.js'

describe('AsyncLock handover', () => {
  it('a lock handed to the next waiter never looks free, so a late arrival queues behind it', async () => {
    const lock = new AsyncLock()
    const order: string[] = []
    const releaseA = await lock.acquire()
    const b = lock.acquire().then((rel) => { order.push('b'); return rel })
    releaseA() // hand over to b
    expect(lock.busy).toBe(true) // synchronously after the release: still held (by b)
    const c = lock.acquire().then((rel) => { order.push('c'); return rel })
    const relB = await b
    // c must not have been granted while b holds
    await Promise.resolve()
    expect(order).toEqual(['b'])
    relB()
    const relC = await c
    expect(order).toEqual(['b', 'c'])
    relC()
    expect(lock.busy).toBe(false)
  })

  it('a second call of the same release function does not hand the lock to a waiter early', async () => {
    const lock = new AsyncLock()
    const releaseA = await lock.acquire()
    let bGranted = false
    let cGranted = false
    const b = lock.acquire().then((rel) => { bGranted = true; return rel })
    const c = lock.acquire().then((rel) => { cGranted = true; return rel })
    releaseA()
    releaseA() // double release: must be a no-op
    const relB = await b
    await Promise.resolve()
    expect(bGranted).toBe(true)
    expect(cGranted).toBe(false)
    relB()
    await c
  })
})

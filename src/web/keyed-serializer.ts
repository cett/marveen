// A per-key FIFO serializer for read-modify-write sequences that span `await`s.
//
// Why it exists: the db layer used to be synchronous, so a function that read a row, merged a change and wrote it
// back (and then mirrored the result into a file) could not be interleaved with another caller. With an async db
// facade every `await` is a point where a second caller's sequence can start, so two edits of one row both read the
// old row and the later write drops the earlier change, or the file mirror ends up holding the older content.
// Running the sequences of one key one after the other restores the old guarantee inside this process.
//
// - FIFO per key: callers run in the order they asked, a failure of one does not block the next.
// - Re-entrant: code that already runs under a key (a route holding the schedule lock that calls
//   writeScheduledTask for the same schedule) runs directly instead of waiting for itself.
// - Not a cross-process lock: another process writing the same rows is covered by the database, not by this.

import { AsyncLocalStorage } from 'node:async_hooks'
import { AsyncLock } from '../db/tx-lock.js'

export interface KeyedSerializer {
  /** Run `fn` once every earlier run for `key` has finished. Resolves or rejects with `fn`'s outcome. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

export function createKeyedSerializer(): KeyedSerializer {
  const locks = new Map<string, { lock: AsyncLock; users: number }>()
  const held = new AsyncLocalStorage<ReadonlySet<string>>()

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const mine = held.getStore()
      if (mine?.has(key)) return fn()

      let entry = locks.get(key)
      if (!entry) {
        entry = { lock: new AsyncLock(), users: 0 }
        locks.set(key, entry)
      }
      entry.users++
      const release = await entry.lock.acquire()
      try {
        return await held.run(new Set([...(mine ?? []), key]), fn)
      } finally {
        release()
        if (--entry.users === 0) locks.delete(key)
      }
    },
  }
}

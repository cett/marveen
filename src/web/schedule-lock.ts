// One schedule is read, merged, written to the DB and mirrored to its files as one step. The db is async, so two
// writers of the same schedule would otherwise both read the old row (the later write drops the earlier change) and
// the mirror could end up holding the older content. This lock runs them one after the other, in call order, per
// schedule name. It is re-entrant: a route that holds it for a longer decision (read, check, write) can call
// writeScheduledTask inside. In-process only: the database is the guard across processes.
//
// A module of its own so that a test which replaces scheduled-tasks-io still gets the real lock.

import { createKeyedSerializer } from './keyed-serializer.js'

const scheduleWrites = createKeyedSerializer()

export function withScheduleLock<T>(taskName: string, fn: () => Promise<T>): Promise<T> {
  return scheduleWrites.run(taskName, fn)
}

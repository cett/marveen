// A blackboard row is read, judged ("does the recipient already have an active row?", "is the row still what the
// runner wrote?") and then written by a separate upsert. The db is async, so two callers of the same agent would both
// judge the old row and the later write would replace the earlier one. This runs those sequences one after the
// other, in call order, per agent id. Re-entrant. In-process only: the database is the guard across processes.
//
// A module of its own so that a test which replaces the db layer still gets the real lock.

import { createKeyedSerializer } from './keyed-serializer.js'

const blackboardWrites = createKeyedSerializer()

export function withBlackboardLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  return blackboardWrites.run(agentId, fn)
}

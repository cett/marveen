// Read-then-write transactions that SQLite serialised through the facade's transaction lock and PostgreSQL does not (each
// dbx.tx has its own connection, READ COMMITTED, no global transaction lock): the first statement of the body must take the
// lock of what it reads, or two overlapping transactions lose an update. One describe per site; each cell parks the first
// transaction right before its write (helpers/tx-park.ts), starts the second one, waits until the second is blocked on the
// lock (PostgreSQL) and lets the first one go on. The expected result is exact. SQLite: the second transaction queues in
// the connection lock, the result is the same, so the cell is green there with or without the lock.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { interleave } from './helpers/interleave.js'
import { parkFirstTxAt, untilSettledOrBlocked } from './helpers/tx-park.js'
import { saveWorkspaceDoc, patchWorkspaceDoc, getWorkspaceDoc } from '../db/workspace.js'

useTestDb()
afterEach(() => { vi.restoreAllMocks() })

describe('patchWorkspaceDoc', () => {
  it('two overlapping patches of different fields both survive (the second waits on the row lock of the first read)', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'notes/one', title: 'T0', content: 'C0',
      content_type: 'text', type: 'notes',
    })
    const il = interleave()
    il.hold('first-patch')
    // the first patch has read the row and stops before its UPDATE; the second patch must not read the row while it is open
    const spy = parkFirstTxAt(il, 'first-patch', /^\s*UPDATE workspace_docs\s+SET /)
    let state: 'settled' | 'blocked' | 'queued'
    try {
      const first = patchWorkspaceDoc(doc.id, { title: 'T1' })
      await il.reached('first-patch')
      const second = patchWorkspaceDoc(doc.id, { content: 'C2' })
      state = await untilSettledOrBlocked(second)
      il.open('first-patch')
      expect((await first)?.title).toBe('T1')
      expect((await second)?.content).toBe('C2')
    } finally {
      il.open('first-patch')
      spy.mockRestore()
    }
    // the second patch must not have run to its end while the first one was open (a stale read would let it)
    expect(state).not.toBe('settled')
    // a stale merge would write the second patch over the title of the first one (T0)
    const after = await getWorkspaceDoc(doc.id)
    expect(after?.title).toBe('T1')
    expect(after?.content).toBe('C2')
  })
})

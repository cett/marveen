// importFleetRows and fleetRowExists (db/fleet-transfer.ts) run every statement on a transaction handle, on both backends
// (SQLite in the default suite, PostgreSQL in the module run: the file is in the ported list). On PostgreSQL an ambient
// `dbx` call inside a transaction body is refused, so a regression to the facade is red there; on SQLite the ambient call
// quietly joins the transaction, so the structural counter (helpers/single-transaction.ts) is what catches it.
//
// Privacy: neutral fixtures only (agent-a).
import { describe, expect, it } from 'vitest'
import { dbx } from '../db.js'
import { fleetRowExists, importFleetRows } from '../db/fleet-transfer.js'
import { useTestDb } from './helpers/with-test-db.js'
import { countFacadeCalls } from './helpers/single-transaction.js'

useTestDb()

const memory = (content: string | null) => ({
  chat_id: '', content, sector: 'semantic', salience: 1, created_at: 5, accessed_at: 5,
  agent_id: 'agent-a', category: 'warm', auto_generated: 0, keywords: null,
})
const label = { id: 'l1', name: 'bug', color: '#f00', created_at: 1 }
const memoryCount = async () => ((await dbx.get("SELECT COUNT(*) AS n FROM memories WHERE agent_id = 'agent-a'")) as { n: number }).n
const labelCount = async () => ((await dbx.get('SELECT COUNT(*) AS n FROM labels')) as { n: number }).n

describe('importFleetRows', () => {
  it('opens one transaction and runs the existence reads and the inserts on its handle, not on dbx', async () => {
    const counts = await countFacadeCalls(dbx, () => importFleetRows('memories', [memory('one'), memory('two'), memory('one')]))
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
    expect(await memoryCount()).toBe(2) // the third row is a duplicate of the first
  })

  it('is atomic: a later row that is refused takes the earlier row of the same call back', async () => {
    await expect(importFleetRows('memories', [memory('kept?'), memory(null)])).rejects.toThrow()
    expect(await memoryCount()).toBe(0)
  })

  it('inside a transaction of the caller it opens a savepoint on the handle it is given, and a rollback of the caller takes it back', async () => {
    const counts = await countFacadeCalls(dbx, async () => {
      await expect(dbx.tx(async (tx) => {
        expect(await importFleetRows('labels', [label], tx)).toBe(1)
        expect(await importFleetRows('labels', [label], tx)).toBe(0) // the dedupe read sees the open transaction's own row
        throw new Error('caller rolls back')
      })).rejects.toThrow('caller rolls back')
    })
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
    expect(await labelCount()).toBe(0)
  })
})

describe('fleetRowExists', () => {
  it('reads on the handle it is given: a row written in an open transaction is seen there and not outside', async () => {
    await dbx.tx(async (tx) => {
      await tx.run("INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords) VALUES ('', 'seen', 'semantic', 1, 5, 5, 'agent-a', 'warm', 0, NULL)")
      expect(await fleetRowExists('memories', { agent_id: 'agent-a', content: 'seen' }, tx)).toBe(true)
    })
    expect(await fleetRowExists('memories', { agent_id: 'agent-a', content: 'seen' })).toBe(true)
    expect(await fleetRowExists('memories', { agent_id: 'agent-a', content: 'other' })).toBe(false)
  })
})

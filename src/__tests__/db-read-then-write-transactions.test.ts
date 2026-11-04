// The db-layer functions that READ and then WRITE (select-then-delete, select-then-update, delete-then-insert)
// must run both halves in one transaction: as two separate facade calls a concurrent writer can slip in
// between. One table-driven suite for all of them, instead of a spy test per module.
//
// The proof is structural (see helpers/single-transaction.ts): exactly one `dbx.tx`, and no statement run
// on `dbx` itself while the function executes. A behaviour test cannot show this on a single-connection
// SQLite, where the interleaving never happens.
import { describe, it, expect } from 'vitest'
import {
  dbx,
  upsertVaultBinding,
  deleteVaultBindingsForSecret,
  adoptChannelCredential,
  clearChannelAdoption,
  recordChannelDriftCheck,
} from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'
import { countFacadeCalls } from './helpers/single-transaction.js'

useTestDb()

const AGENT = 'agent-a'
const PROVIDER = 'telegram'

async function seedAdoption(): Promise<void> {
  await adoptChannelCredential({ agentId: AGENT, provider: PROVIDER, chatIds: ['100', '200'], tokenSha256: 'h-token', allowSha256: 'h-allow', adoptedBy: 'owner' })
}

interface Case {
  name: string
  /** Puts the rows in place so the function takes its read-then-write path, not an early return. */
  seed: () => Promise<void>
  run: () => Promise<unknown>
}

const CASES: Case[] = [
  {
    name: 'deleteVaultBindingsForSecret (select the rows, then delete them)',
    seed: () => upsertVaultBinding('default', { vaultSecretId: 'secret-a', envVar: 'API_KEY', targets: [] }),
    run: () => deleteVaultBindingsForSecret('default', 'secret-a'),
  },
  {
    name: 'adoptChannelCredential (replace the chat list and the baseline)',
    seed: seedAdoption,
    run: () => adoptChannelCredential({ agentId: AGENT, provider: PROVIDER, chatIds: ['300'], tokenSha256: 'h-token-2', allowSha256: 'h-allow-2', adoptedBy: 'owner' }),
  },
  {
    name: 'clearChannelAdoption (delete the chats, then the baseline)',
    seed: seedAdoption,
    run: () => clearChannelAdoption(AGENT, PROVIDER),
  },
  {
    name: 'recordChannelDriftCheck (read the drift state, then update it)',
    seed: seedAdoption,
    run: () => recordChannelDriftCheck(AGENT, PROVIDER, 'token', 1_800_000_000),
  },
]

describe('read-then-write db functions run as one transaction', () => {
  it.each(CASES)('$name', async ({ seed, run }) => {
    await seed()
    const counts = await countFacadeCalls(dbx, run)
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
  })

  // Negative control for the counter itself: two separate facade calls, the shape these functions must NOT
  // have, must read as a failure. Without it the assertion above could pass on a counter that counts nothing.
  it('the counter tells two separate facade calls from one transaction', async () => {
    const separate = await countFacadeCalls(dbx, async () => {
      await dbx.get('SELECT 1 AS n')
      await dbx.run('SELECT 1')
    })
    expect(separate).toEqual({ tx: 0, outsideTx: 2 })

    const single = await countFacadeCalls(dbx, () => dbx.tx(async (tx) => {
      await tx.get('SELECT 1 AS n')
      await tx.run('SELECT 1')
    }))
    expect(single).toEqual({ tx: 1, outsideTx: 0 })
  })

  it('a function that opens a transaction but runs its statements outside the handle is caught', async () => {
    const mixed = await countFacadeCalls(dbx, () => dbx.tx(async () => {
      await dbx.get('SELECT 1 AS n')
    }))
    expect(mixed).toEqual({ tx: 1, outsideTx: 1 })
  })
})

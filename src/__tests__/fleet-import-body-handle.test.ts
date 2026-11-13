// The body of the fleet import transaction (inFleetImportTransaction) runs every write on the handle it is given. On
// PostgreSQL a call on the outer `dbx` inside the body is refused (strict rule); on SQLite it would quietly join the
// transaction through the facade's ambient scope, so the structural counter (helpers/single-transaction.ts) is what
// tells the two apart there: exactly one `tx` (the wrapper) and zero plain facade calls while the body runs.
//
// This file holds the cells of the callees one family at a time (system_config here); each cell has three parts:
// the handle (0 plain facade calls), the rollback (a throw after the writes leaves the database as it was), and the
// commit (a body that finishes keeps every write).
//
// Privacy: neutral fixtures only (agent-a, model-a).
import { describe, expect, it } from 'vitest'
import { dbx } from '../db.js'
import { inFleetImportTransaction } from '../db/fleet-transfer.js'
import { loadSystemConfigCacheAsync, cachedSystemConfig } from '../db/config-cache.js'
import { setSystemConfig, setSystemConfigMany } from '../db/system-config.js'
import { setFederationConfigRaw } from '../db/federation.js'
import { setDesiredAgents } from '../web/agent-desired-state.js'
import { writeModelFallbackFieldsRaw } from '../web/model-fallback-store.js'
import { writeTerminalInputEnabled } from '../web/terminal-input-store.js'
import { useTestDb } from './helpers/with-test-db.js'
import { countFacadeCalls } from './helpers/single-transaction.js'
import { refuseWrite } from './helpers/refuse-write.js'

useTestDb()

const snapshot = async () => dbx.all<{ key: string; value: string }>('SELECT key, value FROM system_config ORDER BY key')
const valueOf = async (key: string) => (await dbx.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', key))?.value

/** Every system_config writer the import body calls, in one go, on the handle. */
async function writeAll(tx: Parameters<Parameters<typeof inFleetImportTransaction>[0]>[0]): Promise<void> {
  await setSystemConfig('probe_single', 'v1', 'db', tx)
  await setSystemConfigMany([['probe_many_a', '1'], ['probe_many_b', '2']], 'db', tx)
  await writeTerminalInputEnabled(true, tx)
  await writeModelFallbackFieldsRaw({ enabled: true, chain: ['model-a'], revertAfterMinutes: 5 }, tx)
  await setFederationConfigRaw('{"peers":[]}', 'db', tx)
  await setDesiredAgents(['agent-a'], tx)
}

const KEYS = [
  'probe_single', 'probe_many_a', 'probe_many_b', 'terminal_input_enabled', 'model_fallback_enabled',
  'model_fallback_chain', 'model_fallback_revert_after_minutes', 'federation_config_json', 'agents_desired',
]

describe('system_config writers on the import handle', () => {
  it('the handle: one transaction and no plain facade call while the body runs (the cache read-back included)', async () => {
    await loadSystemConfigCacheAsync() // a live cache, so the PG read-back after each write really runs
    const counts = await countFacadeCalls(dbx, () => inFleetImportTransaction(writeAll))
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
  })

  it('the commit: a body that finishes keeps every write, and the cache follows', async () => {
    await loadSystemConfigCacheAsync()
    await inFleetImportTransaction(writeAll)
    const rows = await snapshot()
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(KEYS))
    expect(await valueOf('probe_many_b')).toBe('2')
    expect(await valueOf('terminal_input_enabled')).toBe('1')
    expect(JSON.parse((await valueOf('agents_desired')) ?? 'null')).toEqual(['agent-a'])
    expect(cachedSystemConfig('probe_single')?.value).toBe('v1')
  })

  it('the rollback: a throw after the writes leaves system_config as it was', async () => {
    const before = await snapshot()
    await expect(inFleetImportTransaction(async (tx) => {
      await writeAll(tx)
      // the writes are inside the transaction (visible on its handle) before the throw takes them back
      expect(await tx.get('SELECT 1 AS x FROM system_config WHERE key = ?', 'probe_single')).toBeTruthy()
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await snapshot()).toEqual(before)
    expect(await valueOf('agents_desired')).toBeUndefined()
  })

  it('the rollback after a refused write in the middle: the earlier writers of the family are taken back too', async () => {
    const before = await snapshot()
    await refuseWrite(dbx, { name: 'no_federation_row', table: 'system_config', message: 'insert refused', when: { column: 'key', equals: 'federation_config_json' } })
    await expect(inFleetImportTransaction(writeAll)).rejects.toThrow('insert refused')
    expect(await snapshot()).toEqual(before)
  })
})

describe('setDesiredAgents', () => {
  it('without a handle a refused write is logged and swallowed, as before', async () => {
    await refuseWrite(dbx, { name: 'no_desired_row', table: 'system_config', message: 'insert refused', when: { column: 'key', equals: 'agents_desired' } })
    await expect(setDesiredAgents(['agent-a'])).resolves.toBeUndefined()
    expect(await valueOf('agents_desired')).toBeUndefined()
  })

  it('with a handle the refusal is rethrown, so the caller rolls back instead of committing into a failed transaction', async () => {
    await refuseWrite(dbx, { name: 'no_desired_row', table: 'system_config', message: 'insert refused', when: { column: 'key', equals: 'agents_desired' } })
    await expect(inFleetImportTransaction(async (tx) => {
      await setSystemConfig('probe_single', 'v1', 'db', tx)
      await setDesiredAgents(['agent-a'], tx)
    })).rejects.toThrow('insert refused')
    expect(await valueOf('probe_single')).toBeUndefined()
  })
})

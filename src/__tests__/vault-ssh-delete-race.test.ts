// Two overlapping deletes of one SSH key (db/vault.ts deleteVaultSshKey) under a real race: the first delete holds the
// assigned server rows (its UPDATE, the same statement the production delete runs) and keeps them locked, plus the key row,
// until it commits (PostgreSQL: the second delete is seen waiting in pg_stat_activity, interleave helper, no timing). After
// the first commits, the second delete must delete nothing and unassign nothing: exactly one call deletes the key, and the
// unassign count belongs to that one.
//
// The first delete is replicated by the test (two statements, the same SQL as deleteVaultSshKey): the production function
// has no pause point. Privacy: neutral fixtures only (key-1, srv-1, srv-2, default tenant).

import { describe, expect, it } from 'vitest'
import { createVaultSshKey, createVaultSshServer, dbx, deleteVaultSshKey, getVaultSshServer, updateVaultSshServer } from '../db.js'
import { useTestDb, testDbMode, testDdl } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

useTestDb()

const KEY = { id: 'key-1', label: 'k', username: 'root', vault_key_id: 'vk-1', public_key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:x', key_type: 'ed25519', tenant_id: 'default' }
const SERVER = { name: 's', host: 'h', port: 22, username: 'root', description: null, tenant_id: 'default' }

describe('deleteVaultSshKey under a race: two overlapping deletes of one key', () => {
  it('the second delete deletes nothing and unassigns nothing once the first has committed', async () => {
    await createVaultSshKey(KEY)
    await createVaultSshServer({ id: 'srv-1', ...SERVER })
    await createVaultSshServer({ id: 'srv-2', ...SERVER })
    await updateVaultSshServer('srv-1', { ssh_key_id: 'key-1' })
    await updateVaultSshServer('srv-2', { ssh_key_id: 'key-1' })
    const il = interleave()
    il.hold('first-delete-in-flight')
    // the first delete: the production statements, in one transaction, held until it commits
    const first = dbx.tx(async (tx) => {
      const unassigned = (await tx.run('UPDATE vault_ssh_servers SET ssh_key_id = NULL, updated_at = ? WHERE ssh_key_id = ?', 1_800_000_000, 'key-1')).changes
      const deleted = (await tx.run('DELETE FROM vault_ssh_keys WHERE id = ?', 'key-1')).changes > 0
      await il.pass('first-delete-in-flight')
      return { deleted, unassigned }
    })
    await il.reached('first-delete-in-flight')
    const second = deleteVaultSshKey('key-1')
    try {
      await waitBlockedOnLock(dbx, 1, testDbMode())
    } finally {
      il.open('first-delete-in-flight')
    }
    const firstResult = await first
    const secondResult = await second
    expect(firstResult).toEqual({ deleted: true, unassigned: 2 })
    expect(secondResult).toEqual({ deleted: false, unassigned: 0 })
    expect((await getVaultSshServer('srv-1'))?.ssh_key_id).toBeNull()
    expect((await getVaultSshServer('srv-2'))?.ssh_key_id).toBeNull()
  })

  it('a delete whose key row cannot be deleted leaves the server assignments in place (one transaction, both engines)', async () => {
    await createVaultSshKey({ ...KEY, id: 'key-2' })
    await createVaultSshServer({ id: 'srv-3', ...SERVER })
    await updateVaultSshServer('srv-3', { ssh_key_id: 'key-2' })
    // a trigger that refuses the key delete: the statement before it (the unassign) must roll back with it
    if (testDbMode() === 'pg') {
      await testDdl(dbx, "CREATE OR REPLACE FUNCTION vault_test_block_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$ LANGUAGE plpgsql")
      await testDdl(dbx, 'CREATE TRIGGER vault_key_delete_blocked BEFORE DELETE ON vault_ssh_keys FOR EACH ROW EXECUTE FUNCTION vault_test_block_delete()')
    } else {
      await testDdl(dbx, "CREATE TRIGGER vault_key_delete_blocked BEFORE DELETE ON vault_ssh_keys BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    }
    await expect(deleteVaultSshKey('key-2')).rejects.toThrow(/blocked/)
    expect((await getVaultSshServer('srv-3'))?.ssh_key_id).toBe('key-2')
  })
})

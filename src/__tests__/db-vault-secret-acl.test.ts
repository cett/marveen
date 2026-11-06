import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Same per-test STORE_DIR isolation as db-vault-bindings.test.ts: STORE_DIR is a
// module-level const in config.ts, so each test needs its own module instance.
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-vault-secret-acl-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('migration 0090: vault_secret_acl', () => {
  it('creates the table with the (secret, tenant, grantee) primary key and no value column', () => {
    const db = dbMod.getDb()
    const cols = db.prepare('PRAGMA table_info(vault_secret_acl)').all() as Array<{ name: string, pk: number }>
    expect(cols.map(c => c.name).sort()).toEqual(['created_at', 'grantee', 'tenant_id', 'vault_secret_id'])
    const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name)
    expect(pk).toEqual(['vault_secret_id', 'tenant_id', 'grantee'])
  })

  it('is not seeded: a fresh database has no row, so every secret is open', () => {
    const n = (dbMod.getDb().prepare('SELECT COUNT(*) AS n FROM vault_secret_acl').get() as { n: number }).n
    expect(n).toBe(0)
  })

  it('re-running the migration file does not throw and keeps the rows', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a'])
    const sql = readFileSync(new URL('../migrations/0090_vault_secret_acl.sql', import.meta.url), 'utf8')
    expect(() => dbMod.getDb().exec(sql)).not.toThrow()
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['agent:agent-a'])
  })

  it('rejects a duplicate (secret, tenant, grantee) at the database level', () => {
    const ins = dbMod.getDb().prepare("INSERT INTO vault_secret_acl (vault_secret_id, tenant_id, grantee) VALUES ('s1', 'default', 'scope:user')")
    ins.run()
    expect(() => ins.run()).toThrow(/UNIQUE|PRIMARY/i)
  })
})

describe('listSecretAcl / replaceSecretAcl / deleteSecretAcl', () => {
  it('lists an empty array for a secret nobody listed (open)', async () => {
    expect(await dbMod.listSecretAcl('default', 'nope')).toEqual([])
  })

  it('replaces the whole set: the previous grantees are gone, the new ones are sorted', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-b', 'agent:agent-a'])
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['agent:agent-a', 'agent:agent-b'])
    await dbMod.replaceSecretAcl('default', 's1', ['scope:project'])
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['scope:project'])
  })

  it('a repeated grantee in the input collapses to one row (no PK error)', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a', 'agent:agent-a', 'agent:agent-a'])
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['agent:agent-a'])
  })

  it('an empty array opens the secret again', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a'])
    await dbMod.replaceSecretAcl('default', 's1', [])
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual([])
  })

  it('does not touch the list of another secret', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a'])
    await dbMod.replaceSecretAcl('default', 's2', ['agent:agent-b'])
    await dbMod.replaceSecretAcl('default', 's1', [])
    expect(await dbMod.listSecretAcl('default', 's2')).toEqual(['agent:agent-b'])
  })

  it('isolates tenants: the same secret id has one list per tenant', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a'])
    await dbMod.replaceSecretAcl('tenant-x', 's1', ['agent:agent-b'])
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['agent:agent-a'])
    expect(await dbMod.listSecretAcl('tenant-x', 's1')).toEqual(['agent:agent-b'])
    await dbMod.replaceSecretAcl('tenant-x', 's1', [])
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['agent:agent-a'])
  })

  it('deleteSecretAcl drops the list of that secret and tenant only', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a'])
    await dbMod.replaceSecretAcl('default', 's2', ['agent:agent-a'])
    await dbMod.replaceSecretAcl('tenant-x', 's1', ['agent:agent-a'])
    await dbMod.deleteSecretAcl('default', 's1')
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual([])
    expect(await dbMod.listSecretAcl('default', 's2')).toEqual(['agent:agent-a'])
    expect(await dbMod.listSecretAcl('tenant-x', 's1')).toEqual(['agent:agent-a'])
  })

  it('deleteSecretAcl on a secret without a list is a no-op, not an error', async () => {
    await expect(dbMod.deleteSecretAcl('default', 'nope')).resolves.toBeUndefined()
  })

  // The transaction proof: an insert that fails half way (a NOT NULL violation on the
  // second grantee) must roll the DELETE back. Without the transaction the old set is
  // already gone when the error surfaces, and the secret silently turns "open".
  it('a failure in the middle of a replace leaves the previous set untouched (one transaction)', async () => {
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-a', 'agent:agent-b'])
    await expect(
      dbMod.replaceSecretAcl('default', 's1', ['agent:agent-c', null as unknown as string]),
    ).rejects.toThrow()
    expect(await dbMod.listSecretAcl('default', 's1')).toEqual(['agent:agent-a', 'agent:agent-b'])
  })
})

describe('listAllSecretAcls', () => {
  it('groups the grantees by secret, only for the asked tenant, and omits open secrets', async () => {
    await dbMod.replaceSecretAcl('default', 's2', ['scope:user', 'agent:agent-a'])
    await dbMod.replaceSecretAcl('default', 's1', ['agent:agent-b'])
    await dbMod.replaceSecretAcl('tenant-x', 's3', ['agent:agent-a'])
    expect(await dbMod.listAllSecretAcls('default')).toEqual({
      s1: ['agent:agent-b'],
      s2: ['agent:agent-a', 'scope:user'],
    })
  })

  it('is an empty object when nothing is listed', async () => {
    expect(await dbMod.listAllSecretAcls('default')).toEqual({})
  })
})

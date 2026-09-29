import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test STORE_DIR isolation (same pattern as db-cost-budgets.test.ts):
// each test gets its own module instance since STORE_DIR is a module-level
// const in config.ts resolved once, at import time.
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-vault-bindings-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function bindingsPath(): string {
  return join(storeDir, 'vault-bindings.json')
}

describe('listVaultBindings / upsertVaultBinding / deleteVaultBinding', () => {
  it('returns an empty array when nothing was ever set', () => {
    expect(dbMod.listVaultBindings('default')).toEqual([])
  })

  it('upsertVaultBinding persists a binding, readable via listVaultBindings', () => {
    dbMod.upsertVaultBinding('default', {
      vaultSecretId: 's1', envVar: 'API_KEY',
      targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }],
    })
    const rows = dbMod.listVaultBindings('default')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      vaultSecretId: 's1', envVar: 'API_KEY',
      targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }],
    })
  })

  it('upsertVaultBinding replaces the targets of an existing (vaultSecretId, envVar) pair', () => {
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/a', serverName: 'x' }] })
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/b', serverName: 'y' }] })
    const rows = dbMod.listVaultBindings('default')
    expect(rows).toHaveLength(1)
    expect(rows[0].targets).toEqual([{ mcpFilePath: '/b', serverName: 'y' }])
  })

  it('deleteVaultBinding removes the matching row and returns true', () => {
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
    expect(dbMod.deleteVaultBinding('default', 's1', 'API_KEY')).toBe(true)
    expect(dbMod.listVaultBindings('default')).toEqual([])
  })

  it('deleteVaultBinding returns false when nothing matched', () => {
    expect(dbMod.deleteVaultBinding('default', 'nope', 'NOPE')).toBe(false)
  })

  it('scopes reads/writes by tenant_id', () => {
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
    dbMod.upsertVaultBinding('other-tenant', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/x', serverName: 'y' }] })
    expect(dbMod.listVaultBindings('default')[0].targets).toEqual([])
    expect(dbMod.listVaultBindings('other-tenant')[0].targets).toEqual([{ mcpFilePath: '/x', serverName: 'y' }])
  })
})

describe('deleteVaultBindingsForSecret', () => {
  it('deletes every binding for the secret and returns the deleted rows (with their targets)', () => {
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/a', serverName: 'x' }] })
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'OTHER', targets: [] })
    dbMod.upsertVaultBinding('default', { vaultSecretId: 's2', envVar: 'UNRELATED', targets: [] })

    const deleted = dbMod.deleteVaultBindingsForSecret('default', 's1')

    expect(deleted).toHaveLength(2)
    expect(deleted.find(b => b.envVar === 'API_KEY')?.targets).toEqual([{ mcpFilePath: '/a', serverName: 'x' }])
    const remaining = dbMod.listVaultBindings('default')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].vaultSecretId).toBe('s2')
  })

  it('returns an empty array when the secret has no bindings', () => {
    expect(dbMod.deleteVaultBindingsForSecret('default', 'nope')).toEqual([])
  })
})

describe('replaceVaultBindings', () => {
  it('is a whole-value replace: a binding dropped from the new set disappears, not just left un-upserted', () => {
    dbMod.replaceVaultBindings('default', [
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] },
      { vaultSecretId: 's2', envVar: 'OTHER', targets: [] },
    ])
    dbMod.replaceVaultBindings('default', [{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/new', serverName: 'srv' }] }])
    const rows = dbMod.listVaultBindings('default')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ vaultSecretId: 's1', targets: [{ mcpFilePath: '/new', serverName: 'srv' }] })
  })

  it('scopes replace by tenant_id, leaving other tenants untouched', () => {
    dbMod.replaceVaultBindings('default', [{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
    dbMod.replaceVaultBindings('other-tenant', [{ vaultSecretId: 's-other', envVar: 'X', targets: [] }])
    dbMod.replaceVaultBindings('default', [])
    expect(dbMod.listVaultBindings('default')).toEqual([])
    expect(dbMod.listVaultBindings('other-tenant')).toHaveLength(1)
  })
})

describe('migrateVaultBindingsFromFile', () => {
  it('returns 0 and writes nothing when the file does not exist', () => {
    expect(dbMod.migrateVaultBindingsFromFile()).toBe(0)
    expect(dbMod.listVaultBindings('default')).toEqual([])
  })

  it('backfills every binding from an existing file into tenant=default', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(bindingsPath(), JSON.stringify({
      bindings: [
        { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] },
        { vaultSecretId: 's2', envVar: 'OTHER', targets: [] },
      ],
    }))

    const migrated = dbMod.migrateVaultBindingsFromFile()

    expect(migrated).toBe(2)
    const rows = dbMod.listVaultBindings('default')
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.vaultSecretId === 's1')?.targets).toEqual([{ mcpFilePath: '/mcp.json', serverName: 'srv' }])
  })

  it('is idempotent: a second run does not overwrite an operator-set row', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(bindingsPath(), JSON.stringify({
      bindings: [{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }],
    }))
    dbMod.migrateVaultBindingsFromFile()

    dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/operator-added', serverName: 'srv' }] })
    const secondRun = dbMod.migrateVaultBindingsFromFile()

    expect(secondRun).toBe(0)
    expect(dbMod.listVaultBindings('default')[0].targets).toEqual([{ mcpFilePath: '/operator-added', serverName: 'srv' }])
  })

  it('skips a corrupt JSON file without throwing', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(bindingsPath(), 'not valid json')
    expect(() => dbMod.migrateVaultBindingsFromFile()).not.toThrow()
    expect(dbMod.migrateVaultBindingsFromFile()).toBe(0)
  })

  it('skips a binding entry with a missing vaultSecretId or envVar, keeps the rest', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(bindingsPath(), JSON.stringify({
      bindings: [
        { envVar: 'NO_SECRET_ID', targets: [] },
        { vaultSecretId: 'no-env-var', targets: [] },
        { vaultSecretId: 's-ok', envVar: 'OK', targets: [] },
      ],
    }))
    expect(dbMod.migrateVaultBindingsFromFile()).toBe(1)
    expect(dbMod.listVaultBindings('default')).toHaveLength(1)
  })

  it('returns 0 when the file has no bindings array', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(bindingsPath(), JSON.stringify({}))
    expect(dbMod.migrateVaultBindingsFromFile()).toBe(0)
  })

  it('defaults a missing/non-array targets field to an empty array instead of throwing', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(bindingsPath(), JSON.stringify({
      bindings: [{ vaultSecretId: 's1', envVar: 'API_KEY' }],
    }))
    expect(dbMod.migrateVaultBindingsFromFile()).toBe(1)
    expect(dbMod.listVaultBindings('default')[0].targets).toEqual([])
  })
})

// SECURITY (plan #984, group 7): the table holds binding metadata only --
// never an actual secret value. A row's only string-shaped fields are
// vault_secret_id (a reference/id, not the secret itself), env_var, and the
// targets JSON (file paths + server names). This test pins that schema
// shape so a future column addition can't silently reintroduce a
// value-holding field without failing here.
describe('vault_bindings table holds no secret-value column', () => {
  it('every column is metadata-shaped (id/ref/env-var/targets/tenant/timestamps), never a "value"/"secret" column', async () => {
    const { db } = await import('../db/connection.js')
    const columns = (db.prepare('PRAGMA table_info(vault_bindings)').all() as Array<{ name: string }>).map(c => c.name)
    expect(columns.sort()).toEqual(
      ['vault_secret_id', 'env_var', 'targets', 'tenant_id', 'created_at', 'updated_at'].sort(),
    )
    expect(columns.some(c => /value|secret_value|^password$|^token$/i.test(c) && c !== 'vault_secret_id')).toBe(false)
  })
})

// VAULTMODE818, revised for #985 group 7/8 (team decision D2=B, plan #984
// section 7): the binding store itself moved from store/vault-bindings.json
// to the vault_bindings DB table, so the pre-migration version of this file
// (asserting every atomicWriteFileSync(target.mcpFilePath, ...) call in
// vault-bindings.ts pins mode 0o600) no longer belongs here -- that
// assertion is about the MCP credential files a binding syncs secrets INTO,
// unrelated to how the binding list itself is stored, and still lives (and
// still passes) via the real behavioral coverage in vault-bindings.test.ts's
// syncSecret/unsyncBinding/removeBindingsForSecret suites, which assert
// { mode: 0o600 } on every such write directly.
//
// This file's job under D2=B is now three-fold:
//  1. "no-file": store/vault-bindings.json is never created by a binding
//     write anymore -- the DB is the only store.
//  2. "DB file 0600": the SQLite file itself carries the 0600 mode that used
//     to protect the JSON file's readability (connection.ts already
//     guarantees this unconditionally for every table; this test pins the
//     guarantee specifically for this migration's context).
//  3. "metadata only": vault_bindings never holds an actual secret value --
//     see db-vault-bindings.test.ts's schema-shape test for the full
//     column-level version of this guarantee; the round-trip test here
//     confirms it end-to-end through the web/vault-bindings.ts API surface
//     a route handler actually calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let storeDir: string

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'vault-bindings-file-mode-test-'))
  mkdirSync(storeDir, { recursive: true })
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

describe('VAULTMODE818 (revised, #985 group 7/8): vault bindings are DB-backed, not file-backed', () => {
  it('no-file: adding/removing bindings through the real DB-backed store never creates store/vault-bindings.json', async () => {
    process.env['MARVEEN_STORE_DIR'] = storeDir
    vi.resetModules()
    try {
      const dbMod = await import('../db.js')
      dbMod.initDatabase(':memory:')
      dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
      dbMod.deleteVaultBinding('default', 's1', 'API_KEY')
      expect(existsSync(join(storeDir, 'vault-bindings.json'))).toBe(false)
    } finally {
      delete process.env['MARVEEN_STORE_DIR']
    }
  })

  it('DB file 0600: the SQLite file backing vault_bindings is created with mode 0600', async () => {
    process.env['MARVEEN_STORE_DIR'] = storeDir
    vi.resetModules()
    try {
      const dbMod = await import('../db.js')
      const dbPath = join(storeDir, 'claudeclaw.db')
      dbMod.initDatabase(dbPath)
      dbMod.upsertVaultBinding('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
      expect(statSync(dbPath).mode & 0o777).toBe(0o600)
    } finally {
      delete process.env['MARVEEN_STORE_DIR']
    }
  })

  it('metadata only: a binding round-tripped through getBindings()/addBinding() never carries an actual secret value, only references', async () => {
    process.env['MARVEEN_STORE_DIR'] = storeDir
    vi.resetModules()
    try {
      const dbMod = await import('../db.js')
      dbMod.initDatabase(':memory:')
      const { getBindings, addBinding } = await import('../web/vault-bindings.js')

      // vaultSecretId is a REFERENCE (the id vault.ts looks up), never the
      // decrypted secret string itself -- vault-bindings.ts has no import of
      // vault.ts's getSecret() anywhere near addBinding()/getBindings().
      addBinding({
        vaultSecretId: 'my-api-key-id',
        envVar: 'API_KEY',
        targets: [{ mcpFilePath: '/mock/.mcp.json', serverName: 'srv' }],
      })

      const bindings = getBindings()
      expect(bindings).toHaveLength(1)
      const serialized = JSON.stringify(bindings)
      // Structural guarantee: the object has exactly the metadata shape, no
      // value/secret-carrying field.
      expect(Object.keys(bindings[0]).sort()).toEqual(['envVar', 'targets', 'vaultSecretId'])
      // The stored reference is the id we passed in, not a resolved secret.
      expect(serialized).toContain('my-api-key-id')
    } finally {
      delete process.env['MARVEEN_STORE_DIR']
    }
  })
})

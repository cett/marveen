// VAULTMODE818, revised for #985 group 7/8 (team decision D2=B, plan #984
// section 7): the binding store itself moved from store/vault-bindings.json
// to the vault_bindings DB table. The original VAULTMODE818 guards are about
// the MCP credential files a binding syncs secrets INTO (for the user target
// this IS ~/.claude.json), not about how the binding list is stored, so they
// are kept unchanged in the second describe block below: every
// atomicWriteFileSync(target.mcpFilePath, ...) must pin mode 0o600.
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { atomicWriteFileSync } from '../web/atomic-write.js'

const here = dirname(fileURLToPath(import.meta.url))
const vaultBindingsSrc = join(here, '..', 'web', 'vault-bindings.ts')

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

// VAULTMODE818: the vault-binding sync rewrites credential-bearing MCP config
// files (for the user target this IS ~/.claude.json). atomicWriteFileSync
// renames a fresh tmp file over the target, so WITHOUT an explicit mode the
// result inherits the umask (0644) and silently loosens a 0600 credential file
// to group/other-readable. Every write of target.mcpFilePath must pin 0600.
describe('VAULTMODE818: vault-bindings pins 0600 on credential-bearing writes', () => {
  it('every atomicWriteFileSync(target.mcpFilePath, ...) passes mode 0o600', () => {
    const src = readFileSync(vaultBindingsSrc, 'utf8')
    // Each such write is a single line; the credential-file write must pin 0600.
    const lines = src.split('\n').filter(l => l.includes('atomicWriteFileSync(target.mcpFilePath'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, `credential-file write must set 0600:\n${line}`).toMatch(/mode:\s*0o600/)
    }
  })

  it('atomicWriteFileSync with mode 0600 keeps a file 0600 even overwriting a 0644 one', () => {
    const path = join(tmpdir(), `vaultmode-${process.pid}-${randomBytes(4).toString('hex')}.json`)
    try {
      // Simulate an existing world-readable file the sync would overwrite.
      writeFileSync(path, '{}')
      chmodSync(path, 0o644)
      expect(statSync(path).mode & 0o777).toBe(0o644)
      atomicWriteFileSync(path, JSON.stringify({ x: 1 }), { mode: 0o600 })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('atomicWriteFileSync WITHOUT mode inherits the umask (the bug being guarded)', () => {
    const path = join(tmpdir(), `vaultmode-nomode-${process.pid}-${randomBytes(4).toString('hex')}.json`)
    // The prior 0600 is lost on rewrite because rename swaps the inode: the new
    // file's perms come from the umask, not the old target. Tie the expectation
    // to THIS process's umask (0666 & ~umask) rather than hard-coding "not 0600"
    // -- under a restrictive umask (e.g. 077) the default is itself 0600 and a
    // bare "not 0600" would falsely fail.
    const um = process.umask()
    process.umask(um) // read-only: restore immediately
    const umaskDefault = 0o666 & ~um
    try {
      writeFileSync(path, '{}')
      chmodSync(path, 0o600)
      const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, '{"x":1}')
      renameSync(tmp, path)
      expect(statSync(path).mode & 0o777).toBe(umaskDefault)
    } finally {
      rmSync(path, { force: true })
    }
  })
})

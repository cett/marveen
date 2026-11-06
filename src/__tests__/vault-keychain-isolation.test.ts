// An isolated instance (MARVEEN_STORE_DIR set) must never touch the REAL Keychain master key.
//
// The Keychain item (service and account fixed in keychain.ts) is one per user and does not depend on the
// store directory. Before this change an isolated instance on darwin read the real key and, in the migration
// branch of getMasterKey, overwrote it with the key of the isolated vault. These tests run the REAL keychain.ts
// and the REAL vault.ts with only the two system edges mocked: node:os platform() is darwin and
// node:child_process execFileSync is a recorder. Nothing here can reach the real `security` binary: the mock
// never calls through, and every test counts the calls that WOULD have been made.
//
// Fixture names are neutral (no real agent, tenant or secret names).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return {
    tmpRoot: mkdtempSync(join(tmpdir(), 'vault-keychain-iso-')),
    // What the fake `security` binary answers to find-generic-password.
    find: { mode: 'empty' as 'empty' | 'ok' | 'unavailable', value: 'cmVhbC1rZXktcGxhY2Vob2xkZXI=' },
    calls: [] as string[][], // every would-be call: [file, ...args]
    os: { platform: 'darwin' as string },
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, default: { ...actual, platform: () => h.os.platform }, platform: () => h.os.platform }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    // A recorder, never a pass-through: the real keychain is out of reach of every test in this file.
    execFileSync: vi.fn((file: string, args: string[]) => {
      h.calls.push([file, ...(args ?? [])])
      if (args?.[0] === 'find-generic-password') {
        if (h.find.mode === 'ok') return `${h.find.value}\n`
        const err: any = new Error('find failed (test)')
        err.status = h.find.mode === 'empty' ? 44 : 1
        throw err
      }
      return ''
    }),
  }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: h.tmpRoot, STORE_DIR: `${h.tmpRoot}/store`, MAIN_AGENT_ID: 'main-a' }))

const storeDir = join(h.tmpRoot, 'store')
const keyPath = join(storeDir, '.vault-key')
const migratedPath = join(storeDir, '.vault-key.migrated')
const vaultPath = join(storeDir, 'vault.json')
const ENV = 'MARVEEN_STORE_DIR'
const savedEnv = process.env[ENV]

function isolated(on: boolean) {
  if (on) process.env[ENV] = storeDir
  else delete process.env[ENV]
}

async function freshVault() {
  vi.resetModules()
  return await import('../web/vault.js')
}

// The subcommands the fake `security` was asked for, in order.
const verbs = () => h.calls.map(c => c[1])

beforeEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })
  h.calls.length = 0
  h.find.mode = 'empty'
  h.os.platform = 'darwin'
  isolated(false)
})

afterEach(() => { isolated(false) })

afterAll(() => {
  rmSync(h.tmpRoot, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env[ENV]
  else process.env[ENV] = savedEnv
})

// Build a REAL vault with one secret and a REAL file key under the (isolated) store.
async function seedIsolatedVault(): Promise<string> {
  isolated(true)
  const v = await freshVault()
  v.setSecret('probe', 'Probe', 'probe-value-42')
  expect(existsSync(keyPath)).toBe(true)
  const key = readFileSync(keyPath, 'utf-8').trim()
  h.calls.length = 0
  return key
}

describe('isKeychainAvailable', () => {
  it('darwin + isolated = false; darwin + not isolated = true; not darwin = false either way', async () => {
    vi.resetModules()
    const { isKeychainAvailable } = await import('../web/keychain.js')
    h.os.platform = 'darwin'
    isolated(true)
    expect(isKeychainAvailable()).toBe(false)
    isolated(false)
    expect(isKeychainAvailable()).toBe(true)
    h.os.platform = 'linux'
    expect(isKeychainAvailable()).toBe(false)
    isolated(true)
    expect(isKeychainAvailable()).toBe(false)
    expect(h.calls).toEqual([]) // the gate itself never runs `security`
  })

  it('an empty MARVEEN_STORE_DIR is not isolated, the same as IS_ISOLATED_MODE (Boolean of the variable)', async () => {
    vi.resetModules()
    const { isKeychainAvailable } = await import('../web/keychain.js')
    process.env[ENV] = ''
    expect(isKeychainAvailable()).toBe(true)
  })
})

describe('the two writers refuse in an isolated instance, whoever calls them', () => {
  it('keychainStore and keychainDelete throw, run no `security`, and the message carries no value', async () => {
    vi.resetModules()
    const kc = await import('../web/keychain.js')
    isolated(true)
    const value = 'fixture-master-key-value'
    let storeErr: Error | undefined
    try { kc.keychainStore(value) } catch (e) { storeErr = e as Error }
    expect(storeErr).toBeInstanceOf(kc.KeychainIsolatedError)
    expect(storeErr?.name).toBe('KeychainIsolatedError')
    expect(storeErr?.message).not.toContain(value)
    expect(() => kc.keychainDelete()).toThrow(kc.KeychainIsolatedError) // a throw, not the false of a failed delete
    expect(h.calls).toEqual([])
  })

  it('not isolated they run exactly as before: one add, one delete, delete returns true', async () => {
    vi.resetModules()
    const kc = await import('../web/keychain.js')
    isolated(false)
    kc.keychainStore('fixture-key')
    expect(kc.keychainDelete()).toBe(true)
    expect(h.calls.map(c => c[1])).toEqual(['add-generic-password', 'delete-generic-password'])
  })

  it('the refusal does not depend on the platform or on the gate (a non-darwin isolated call still throws)', async () => {
    vi.resetModules()
    const kc = await import('../web/keychain.js')
    h.os.platform = 'linux'
    isolated(true)
    expect(() => kc.keychainStore('fixture-key')).toThrow(kc.KeychainIsolatedError)
    expect(() => kc.keychainDelete()).toThrow(kc.KeychainIsolatedError)
    expect(h.calls).toEqual([])
  })
})

describe('isolated store, darwin: the vault never runs `security`', () => {
  it('(a) no key file, empty vault: a new FILE key is created under the isolated store, no keychain call', async () => {
    isolated(true)
    const v = await freshVault()
    v.setSecret('probe', 'Probe', 'probe-value-42')
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(existsSync(keyPath)).toBe(true)
    expect(existsSync(vaultPath)).toBe(true)
    expect(h.calls).toEqual([])
  })

  it('(b) a key file that opens the isolated vault: it stays (no migration, no rename), no keychain call', async () => {
    const key = await seedIsolatedVault()
    const v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(existsSync(keyPath)).toBe(true)
    expect(existsSync(migratedPath)).toBe(false)
    expect(readFileSync(keyPath, 'utf-8').trim()).toBe(key)
    expect(h.calls).toEqual([])
  })

  it.each(['empty', 'ok', 'unavailable'] as const)('(c) whatever the keychain would answer (%s) is ignored: file key, no call', async (mode) => {
    h.find.mode = mode
    isolated(true)
    const v = await freshVault()
    v.setSecret('probe', 'Probe', 'probe-value-42')
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(existsSync(keyPath)).toBe(true)
    expect(h.calls).toEqual([])
  })

  it('a non-empty vault and no key file: VaultKeyError, no new key, no keychain call (fail-closed)', async () => {
    await seedIsolatedVault()
    rmSync(keyPath, { force: true })
    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrow(v.VaultKeyError)
    expect(existsSync(keyPath)).toBe(false) // no replacement key was written
    expect(existsSync(migratedPath)).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('a copy of a live vault.json cannot be opened: the real key is out of reach, a new key is not generated', async () => {
    // The vault of "another instance": encrypted with a key this isolated store does not hold.
    await seedIsolatedVault()
    const copy = readFileSync(vaultPath, 'utf-8')
    rmSync(storeDir, { recursive: true, force: true })
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(vaultPath, copy)
    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrow(v.VaultKeyError)
    expect(readdirSync(storeDir).sort()).toEqual(['vault.json'])
    expect(h.calls).toEqual([])
  })
})

describe('NOT isolated, darwin: the old behaviour, byte for byte', () => {
  it('migration branch: a key file that opens the vault is written to the keychain, then renamed', async () => {
    const key = await seedIsolatedVault()
    isolated(false)
    const v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    const adds = h.calls.filter(c => c[1] === 'add-generic-password')
    expect(adds).toHaveLength(1)
    expect(adds[0]).toEqual(['/usr/bin/security', 'add-generic-password', '-U', '-s', 'com.marveen.vault', '-a', 'master-key', '-w', key, '-A'])
    expect(existsSync(keyPath)).toBe(false)
    expect(existsSync(migratedPath)).toBe(true)
  })

  it('new-key branch: an empty keychain and an empty vault generate a key and store it in the keychain', async () => {
    h.find.mode = 'empty'
    const v = await freshVault()
    v.setSecret('probe', 'Probe', 'probe-value-42')
    expect(verbs()).toContain('find-generic-password')
    expect(h.calls.filter(c => c[1] === 'add-generic-password')).toHaveLength(1)
    expect(existsSync(keyPath)).toBe(false) // it went to the keychain, not to a file
  })

  it('read branch: an answering keychain is only read, never written', async () => {
    h.find.mode = 'ok'
    const v = await freshVault()
    v.setSecret('probe', 'Probe', 'probe-value-42')
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(new Set(verbs())).toEqual(new Set(['find-generic-password']))
  })
})

describe('the isolation test of the vault does not depend on a mocked gate', () => {
  it('keychain.ts reads the same variable as IS_ISOLATED_MODE in config.ts (the two definitions agree)', () => {
    const cfg = readFileSync(join(__dirname, '..', 'config.ts'), 'utf-8')
    const kc = readFileSync(join(__dirname, '..', 'web', 'keychain.ts'), 'utf-8')
    const def = "Boolean(process.env['MARVEEN_STORE_DIR'])"
    expect(cfg).toContain(`export const IS_ISOLATED_MODE = ${def}`)
    expect(kc).toContain(`return ${def}`)
  })

  it('with the real config, IS_ISOLATED_MODE follows the variable the keychain gate reads', async () => {
    try {
      vi.resetModules()
      vi.doUnmock('../config.js')
      isolated(false)
      const plain = await import('../config.js')
      expect(plain.IS_ISOLATED_MODE).toBe(false)
      vi.resetModules()
      isolated(true)
      const iso = await import('../config.js')
      expect(iso.IS_ISOLATED_MODE).toBe(true)
      const { isKeychainAvailable } = await import('../web/keychain.js')
      expect(isKeychainAvailable()).toBe(false)
      isolated(false)
      expect(isKeychainAvailable()).toBe(true)
    } finally {
      vi.doMock('../config.js', () => ({ PROJECT_ROOT: h.tmpRoot, STORE_DIR: `${h.tmpRoot}/store`, MAIN_AGENT_ID: 'main-a' }))
    }
  })
})

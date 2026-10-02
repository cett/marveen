// The vault files live under STORE_DIR (MARVEEN_STORE_DIR when set), not under PROJECT_ROOT/store:
// an isolated verify instance must read and write its own vault.json and .vault-key, never the ones of
// the worktree it runs from. Without an override STORE_DIR is PROJECT_ROOT/store, so a normal install
// keeps the same paths.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { PROJECT_ROOT, ISOLATED_STORE } = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vault-root-'))
  const isolated = mkdtempSync(join(tmpdir(), 'vault-isolated-store-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { PROJECT_ROOT: root, ISOLATED_STORE: isolated }
})

vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: vi.fn().mockReturnValue(false),
  keychainStore: vi.fn(),
  keychainRetrieve: vi.fn().mockReturnValue(null),
  keychainRetrieveStatus: vi.fn().mockReturnValue({ status: 'empty', value: null }),
}))
// An isolated instance: STORE_DIR is somewhere else than PROJECT_ROOT/store.
vi.mock('../config.js', () => ({ PROJECT_ROOT, STORE_DIR: ISOLATED_STORE, MAIN_AGENT_ID: 'main' }))

import { setSecret, getSecret, deleteSecret } from '../web/vault.js'

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true })
  rmSync(ISOLATED_STORE, { recursive: true, force: true })
})

describe('vault paths follow STORE_DIR', () => {
  it('writes vault.json and the key into the isolated store and nothing into PROJECT_ROOT/store', () => {
    setSecret('iso-key', 'Iso', 'value-1')
    expect(getSecret('iso-key')).toBe('value-1')
    expect(existsSync(join(ISOLATED_STORE, 'vault.json'))).toBe(true)
    expect(existsSync(join(ISOLATED_STORE, '.vault-key'))).toBe(true)
    expect(existsSync(join(PROJECT_ROOT, 'store', 'vault.json'))).toBe(false)
    expect(existsSync(join(PROJECT_ROOT, 'store', '.vault-key'))).toBe(false)
    deleteSecret('iso-key')
  })

  it('does not read a vault.json that sits under PROJECT_ROOT/store', () => {
    // A secret planted in the worktree's own vault (the file an isolated instance used to pick up) stays invisible.
    mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(PROJECT_ROOT, 'store', 'vault.json'), JSON.stringify({ entries: [{ id: 'planted', label: 'x', encrypted: 'AAAA', tenant_id: 'default', createdAt: '', updatedAt: '' }] }))
    expect(getSecret('planted')).toBeNull()
  })
})

describe('config STORE_DIR default', () => {
  it('is PROJECT_ROOT/store without MARVEEN_STORE_DIR, and the override when it is set', async () => {
    const saved = process.env['MARVEEN_STORE_DIR']
    try {
      vi.resetModules()
      vi.doUnmock('../config.js')
      delete process.env['MARVEEN_STORE_DIR']
      const plain = await import('../config.js')
      expect(plain.STORE_DIR).toBe(join(plain.PROJECT_ROOT, 'store'))

      vi.resetModules()
      const dir = mkdtempSync(join(tmpdir(), 'vault-env-store-'))
      process.env['MARVEEN_STORE_DIR'] = dir
      const isolated = await import('../config.js')
      expect(isolated.STORE_DIR).toBe(dir)
      rmSync(dir, { recursive: true, force: true })
    } finally {
      if (saved === undefined) delete process.env['MARVEEN_STORE_DIR']
      else process.env['MARVEEN_STORE_DIR'] = saved
    }
  })
})

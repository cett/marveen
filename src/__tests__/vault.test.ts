import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vault-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

// Disable keychain so vault falls back to file-based key (deterministic in CI)
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: vi.fn().mockReturnValue(false),
  keychainStore: vi.fn(),
  keychainRetrieve: vi.fn().mockReturnValue(null),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  MAIN_AGENT_ID: 'marveen',
}))

import { setSecret, getSecret, deleteSecret, listSecrets, getSecretsForEnv, findSecretTenant, purgeSecretsForTenant, VaultKeyError } from '../web/vault.js'

const VAULT_JSON = join(STORE_DIR, 'vault.json')
const VAULT_KEY = join(STORE_DIR, '.vault-key')

function cleanVault(): void {
  if (existsSync(VAULT_JSON)) unlinkSync(VAULT_JSON)
  if (existsSync(VAULT_KEY)) unlinkSync(VAULT_KEY)
}

beforeEach(cleanVault)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('setSecret / getSecret roundtrip', () => {
  it('stores and retrieves a secret', () => {
    setSecret('my-api-key', 'API Key', 'super-secret-value')
    const val = getSecret('my-api-key')
    expect(val).toBe('super-secret-value')
  })

  it('returns null for a nonexistent secret', () => {
    expect(getSecret('does-not-exist')).toBeNull()
  })

  it('overwrites an existing secret on second write', () => {
    setSecret('token', 'Token', 'v1')
    setSecret('token', 'Token', 'v2')
    expect(getSecret('token')).toBe('v2')
  })

  it('stores multiple independent secrets', () => {
    setSecret('a', 'A', 'aaa')
    setSecret('b', 'B', 'bbb')
    expect(getSecret('a')).toBe('aaa')
    expect(getSecret('b')).toBe('bbb')
  })

  it('preserves createdAt across updates', () => {
    setSecret('keep', 'Keep', 'original')
    const before = listSecrets().find(s => s.id === 'keep')!.createdAt
    setSecret('keep', 'Keep', 'updated')
    const after = listSecrets().find(s => s.id === 'keep')!.createdAt
    expect(after).toBe(before)
  })
})

describe('deleteSecret', () => {
  it('removes an existing secret', () => {
    setSecret('del-me', 'Del', 'gone')
    expect(deleteSecret('del-me')).toBe(true)
    expect(getSecret('del-me')).toBeNull()
  })

  it('returns false for nonexistent secret', () => {
    expect(deleteSecret('phantom')).toBe(false)
  })
})

describe('listSecrets', () => {
  it('returns empty array when vault is empty', () => {
    expect(listSecrets()).toEqual([])
  })

  it('lists stored secret metadata (no values)', () => {
    setSecret('s1', 'Secret 1', 'val1')
    setSecret('s2', 'Secret 2', 'val2')
    const list = listSecrets()
    expect(list).toHaveLength(2)
    const ids = list.map(s => s.id)
    expect(ids).toContain('s1')
    expect(ids).toContain('s2')
    expect(list.every(s => !('encrypted' in s))).toBe(true)
  })
})

describe('getSecretsForEnv', () => {
  it('resolves vault ids to env values', () => {
    setSecret('db-password', 'DB Pass', 'secret123')
    const env = getSecretsForEnv({ DB_PASS: 'db-password' })
    expect(env.DB_PASS).toBe('secret123')
  })

  it('skips missing vault ids', () => {
    const env = getSecretsForEnv({ MISSING: 'no-such-id' })
    expect(env.MISSING).toBeUndefined()
  })

  it('resolves multiple entries', () => {
    setSecret('key1', 'K1', 'v1')
    setSecret('key2', 'K2', 'v2')
    const env = getSecretsForEnv({ A: 'key1', B: 'key2', C: 'key-absent' })
    expect(env.A).toBe('v1')
    expect(env.B).toBe('v2')
    expect(env.C).toBeUndefined()
  })
})

// Compound (tenant_id, id) key: without this, a tenant-scoped caller could
// shadow or clobber another tenant's (or the fleet-default) secret sharing
// the same id.
describe('tenant isolation (compound key)', () => {
  it('defaults every call to the "default" tenant', () => {
    setSecret('shared-id', 'Shared', 'default-value')
    expect(getSecret('shared-id')).toBe('default-value')
    expect(getSecret('shared-id', 'default')).toBe('default-value')
  })

  it('a write under a different tenant creates a separate entry, not a shadow', () => {
    setSecret('github-GITHUB_TOKEN', 'Fleet token', 'fleet-value')
    setSecret('github-GITHUB_TOKEN', 'Tenant token', 'eszter-value', 'eszter')

    expect(getSecret('github-GITHUB_TOKEN')).toBe('fleet-value')
    expect(getSecret('github-GITHUB_TOKEN', 'default')).toBe('fleet-value')
    expect(getSecret('github-GITHUB_TOKEN', 'eszter')).toBe('eszter-value')

    const rows = listSecrets().filter(s => s.id === 'github-GITHUB_TOKEN')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.tenant_id).sort()).toEqual(['default', 'eszter'])
  })

  it('getSecret for a tenant that never wrote the id returns null, not another tenant\'s value', () => {
    setSecret('only-in-default', 'X', 'v', 'default')
    expect(getSecret('only-in-default', 'eszter')).toBeNull()
  })

  it('deleteSecret only removes the given tenant\'s copy', () => {
    setSecret('dup-id', 'Dup', 'default-value')
    setSecret('dup-id', 'Dup', 'eszter-value', 'eszter')

    expect(deleteSecret('dup-id', 'eszter')).toBe(true)
    expect(getSecret('dup-id', 'eszter')).toBeNull()
    expect(getSecret('dup-id')).toBe('default-value')
  })

  it('overwrite (upsert) only replaces the matching tenant\'s entry', () => {
    setSecret('over', 'O', 'default-v1')
    setSecret('over', 'O', 'eszter-v1', 'eszter')
    setSecret('over', 'O', 'eszter-v2', 'eszter')

    expect(getSecret('over')).toBe('default-v1')
    expect(getSecret('over', 'eszter')).toBe('eszter-v2')
    expect(listSecrets().filter(s => s.id === 'over')).toHaveLength(2)
  })

  it('findSecretTenant reports the owning tenant, or null if the id does not exist anywhere', () => {
    setSecret('owned', 'O', 'v', 'eszter')
    expect(findSecretTenant('owned')).toBe('eszter')
    expect(findSecretTenant('missing-entirely')).toBeNull()
  })
})

// #789/#788: deleteTenant() must not leave orphaned secrets behind. Proving
// isolation (not just "count went to zero") matters because a bug that
// purges everything would also show zero for the target tenant.
describe('purgeSecretsForTenant', () => {
  it('removes only the target tenant\'s entries and leaves other tenants intact', () => {
    setSecret('key1', 'K1', 'v1', 'tenant-a')
    setSecret('key2', 'K2', 'v2', 'tenant-b')

    const removed = purgeSecretsForTenant('tenant-a')

    expect(removed).toBe(1)
    const ids = listSecrets().map(s => s.id)
    expect(ids).not.toContain('key1')
    expect(ids).toContain('key2')
    expect(getSecret('key2', 'tenant-b')).toBe('v2')
  })

  it('returns 0 and writes nothing when the tenant owns no entries', () => {
    setSecret('untouched', 'U', 'v', 'tenant-b')
    expect(purgeSecretsForTenant('tenant-with-no-secrets')).toBe(0)
    expect(getSecret('untouched', 'tenant-b')).toBe('v')
  })
})

describe('backfill: entries written before tenant_id existed', () => {
  it('normalises a legacy vault.json entry (no tenant_id) to "default" on read', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(STORE_DIR, { recursive: true })
    // Simulate a pre-migration vault.json entry: encrypted value doesn't
    // matter for this test, only that tenant_id is absent from the JSON.
    setSecret('legacy-entry', 'Legacy', 'legacy-value')
    const raw = JSON.parse(require('node:fs').readFileSync(VAULT_JSON, 'utf-8'))
    delete raw.entries[0].tenant_id
    writeFileSync(VAULT_JSON, JSON.stringify(raw, null, 2) + '\n')

    const list = listSecrets()
    expect(list).toHaveLength(1)
    expect(list[0].tenant_id).toBe('default')
    expect(getSecret('legacy-entry')).toBe('legacy-value')
  })
})

describe('decrypt: corrupt/truncated entry (#817, Semgrep gcm-no-tag-length triage)', () => {
  it('throws VaultKeyError instead of silently accepting a short auth tag', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    setSecret('truncated-entry', 'Truncated', 'some-value')
    const raw = JSON.parse(require('node:fs').readFileSync(VAULT_JSON, 'utf-8'))
    // salt(32) + iv(16) + tag(16) = 64 bytes minimum before any ciphertext.
    // Truncate the packed blob to well under that so `tag` would end up
    // short if the pre-slice length guard weren't there.
    const buf = Buffer.from(raw.entries[0].encrypted, 'base64')
    raw.entries[0].encrypted = buf.subarray(0, 40).toString('base64')
    writeFileSync(VAULT_JSON, JSON.stringify(raw, null, 2) + '\n')

    expect(() => getSecret('truncated-entry')).toThrow(VaultKeyError)
  })
})

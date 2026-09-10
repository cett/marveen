// Round-trip coverage for vault_ssh_keys/vault_ssh_servers in fleet export/import
// (P4). CRITICAL security property under test: the SSH private key material
// (a generic vault secret, referenced by vault_key_id) must NEVER appear in a
// plaintext (unencrypted) export, and must appear ONLY inside the encrypted,
// password-protected `vault` section. The vault_ssh_keys/servers rows themselves
// are metadata-only (public key, fingerprint, host/port) and travel in plaintext.
//
// Does not need real vault.ts crypto: exportVault() just reads store/vault.json's
// `entries` array as opaque JSON and passes it through -- so a hand-written
// vault.json with a distinctive marker string standing in for a real ciphertext
// is enough to prove presence/absence without decrypting anything at that layer.
// The OUTER fleet-JSON encryption (the actual thing being tested) uses the real
// _encryptForTest/_decryptForTest exported by fleet-transfer.ts for tests.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, getDb } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-vault-ssh-test-'))
  const store = join(root, 'store')
  mkdirSync(store, { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: store, TASKS_DIR: join(root, 'tasks') }
})

afterAll(() => {
  const { rmSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [] }))
vi.mock('../web/atomic-write.js', async () => {
  const { writeFileSync } = await import('node:fs')
  return { atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8') }
})
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: TASKS_DIR }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'TestBot',
  BRAND_NAME: 'TestBot',
  OWNER_NAME: 'test',
  CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PRIVATE_KEY_MARKER = 'FAKE-PRIVATE-KEY-CIPHERTEXT-MARKER-do-not-leak'

function seedVaultSecret() {
  writeFileSync(join(STORE_DIR, '.vault-key'), 'fake-vault-master-key-material', 'utf-8')
  writeFileSync(join(STORE_DIR, 'vault.json'), JSON.stringify({
    entries: [{ id: 'ssh-key-abc123', label: 'SSH private key: test', encrypted: PRIVATE_KEY_MARKER, tenant_id: 'default', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  }, null, 2), 'utf-8')
}

function insertSshKey(overrides: Partial<{ id: string; vault_key_id: string; tenant_id: string }> = {}) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    `INSERT INTO vault_ssh_keys (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.id ?? 'abc123', 'Test key', 'deploy',
    overrides.vault_key_id ?? 'ssh-key-abc123',
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest test-comment',
    'SHA256:fingerprint-placeholder', 'ed25519', now, overrides.tenant_id ?? 'default',
  )
  return overrides.id ?? 'abc123'
}

function insertSshServer(sshKeyId: string | null, id = 'srv-1') {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    `INSERT INTO vault_ssh_servers (id, name, host, port, username, ssh_key_id, description, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, 'Test server', 'server.example.com', 22, 'deploy', sshKeyId, null, 'default', now, now)
  return id
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

describe('exportFleet -- vault_ssh_keys/servers metadata', () => {
  it('always exports the metadata (public key, fingerprint, host/port), plaintext or encrypted', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const keyId = insertSshKey()
    insertSshServer(keyId)

    const plain = JSON.parse(exportFleet().data)
    expect(plain.vaultSshKeys).toHaveLength(1)
    expect(plain.vaultSshKeys[0].public_key).toContain('ssh-ed25519')
    expect(plain.vaultSshServers).toHaveLength(1)
    expect(plain.vaultSshServers[0].host).toBe('server.example.com')
  })

  it('NEVER includes the private key material in a plaintext (unencrypted) export', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    seedVaultSecret()
    insertSshKey()

    const result = exportFleet() // no vaultPassword -- plaintext export
    expect(result.data).not.toContain(PRIVATE_KEY_MARKER)
    // sanity: the export DID happen and the key metadata is there, so this isn't
    // a vacuously-true "didn't export anything" pass
    expect(JSON.parse(result.data).vaultSshKeys).toHaveLength(1)
  })

  it('includes the private key material ONLY inside the encrypted vault section', async () => {
    const { exportFleet, _decryptForTest } = await import('../web/fleet-transfer.js')
    seedVaultSecret()
    insertSshKey()

    const result = exportFleet({ vaultPassword: 'correct-horse-battery-staple' })
    const wrapper = JSON.parse(result.data)
    expect(wrapper.enc).toBe(1)
    // the outer encrypted blob must not leak the marker in the open
    expect(result.data).not.toContain(PRIVATE_KEY_MARKER)

    const decrypted = JSON.parse(_decryptForTest(wrapper.blob, 'correct-horse-battery-staple'))
    expect(decrypted.vault.entries.some((e: any) => e.encrypted === PRIVATE_KEY_MARKER)).toBe(true)
    expect(decrypted.vaultSshKeys).toHaveLength(1)
  })
})

describe('importFleet -- vault_ssh_keys/servers round-trip', () => {
  it('apply (encrypted, with password) recreates both the metadata rows and the secret', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    seedVaultSecret()
    const keyId = insertSshKey()
    insertSshServer(keyId)

    const exported = exportFleet({ vaultPassword: 'correct-horse-battery-staple' })

    initDatabase(':memory:') // fresh target DB
    // fresh target filesystem too -- simulate a clean install with no prior vault
    if (existsSync(join(STORE_DIR, 'vault.json'))) writeFileSync(join(STORE_DIR, 'vault.json'), JSON.stringify({ entries: [] }))
    if (existsSync(join(STORE_DIR, '.vault-key'))) writeFileSync(join(STORE_DIR, '.vault-key'), '')

    const applied = importFleet(exported.data, { apply: true, vaultPassword: 'correct-horse-battery-staple' }) as any
    expect(applied.ok).toBe(true)
    expect(applied.imported.vaultSshKeys).toBe(1)
    expect(applied.imported.vaultSshServers).toBe(1)

    const keyRow = getDb().prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get('abc123') as any
    expect(keyRow).toBeTruthy()
    expect(keyRow.vault_key_id).toBe('ssh-key-abc123')

    const serverRow = getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get('srv-1') as any
    expect(serverRow).toBeTruthy()
    expect(serverRow.ssh_key_id).toBe('abc123')

    // the actual secret must have been re-materialized on the target via importVaultSection()
    const targetVault = JSON.parse(readFileSync(join(STORE_DIR, 'vault.json'), 'utf-8'))
    expect(targetVault.entries.some((e: any) => e.id === 'ssh-key-abc123' && e.encrypted === PRIVATE_KEY_MARKER)).toBe(true)
  })

  it('is idempotent on id for both tables', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    const keyId = insertSshKey()
    insertSshServer(keyId)
    const exported = exportFleet()

    initDatabase(':memory:')
    importFleet(exported.data, { apply: true })
    importFleet(exported.data, { apply: true })

    expect(getDb().prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').all('abc123')).toHaveLength(1)
    expect(getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').all('srv-1')).toHaveLength(1)
  })

  it('dry-run warns that private key material is missing when the vault section is absent', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    insertSshKey() // no seedVaultSecret() -- no vault files on this "source"
    const exported = exportFleet() // plaintext, no vault section

    initDatabase(':memory:')
    const dry = importFleet(exported.data, { apply: false }) as any
    expect(dry.wouldCreate.vaultSshKeys).toBe(1)
    expect(dry.warnings.some((w: string) => w.includes('PRIVÁT'))).toBe(true)
  })

  it('skips a malformed SSH key/server row (missing required fields) without failing the whole import', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const now = 1700000000
    const fleetJson = JSON.stringify({
      schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', sourceHost: 'test-host',
      agents: [], skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      schedules: [], importSources: [],
      vaultSshKeys: [{ id: 'bad-key' }, { id: 'good-key', label: 'l', username: 'u', vault_key_id: 'ssh-key-good', public_key: 'pk', fingerprint: 'fp', key_type: 'ed25519', created_at: now, tenant_id: 'default' }],
      vaultSshServers: [{ id: 'bad-srv' }, { id: 'good-srv', name: 'n', host: 'h', username: 'u', created_at: now, updated_at: now }],
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {}, modelFallback: {}, federation: {}, costopsConfig: {}, egressAllowlist: {} },
    })
    const applied = importFleet(fleetJson, { apply: true }) as any
    expect(applied.ok).toBe(true)
    expect(getDb().prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get('bad-key')).toBeUndefined()
    expect(getDb().prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get('good-key')).toBeTruthy()
    expect(getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get('bad-srv')).toBeUndefined()
    expect(getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get('good-srv')).toBeTruthy()
  })
})

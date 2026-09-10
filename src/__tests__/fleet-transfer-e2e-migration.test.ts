// End-to-end round-trip (ST5): seeds ALL P1-P4 sections together on a "source"
// fleet (DB schedules, import_sources, the four store/*.json config fields,
// vault_ssh_keys/servers + the underlying vault secret), exports encrypted,
// resets to a fresh "target" DB + filesystem, imports with apply, and verifies
// every section landed correctly in one combined run -- not just per-table in
// isolation (that's what the four fleet-transfer-*.test.ts files above already
// cover in depth).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, getDb } from '../db.js'

const { TMP_ROOT, STORE_DIR, TASKS_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'fleet-e2e-migration-test-'))
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

import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function seedSourceFleet() {
  const now = Math.floor(Date.now() / 1000)
  const db = getDb()

  db.prepare(
    `INSERT INTO schedules (id, prompt, description, schedule, agent, type, enabled, tenant_id, created_at, updated_at)
     VALUES ('morning-chain', 'p', 'd', '0 7 * * *', 'agent-a', 'task', 1, NULL, ?, ?)`
  ).run(now, now)

  db.prepare(
    `INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
     VALUES ('local-docs', 'local', '/home/user/docs', 'Docs', 4, 1, ?, ?, ?, 'default')`
  ).run(now, now, now)

  db.prepare(
    `INSERT INTO vault_ssh_keys (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at, tenant_id)
     VALUES ('abc123', 'Deploy key', 'deploy', 'ssh-key-abc123', 'ssh-ed25519 AAAA test', 'SHA256:test', 'ed25519', ?, 'default')`
  ).run(now)
  db.prepare(
    `INSERT INTO vault_ssh_servers (id, name, host, port, username, ssh_key_id, description, tenant_id, created_at, updated_at)
     VALUES ('srv-1', 'Prod server', 'prod.example.com', 22, 'deploy', 'abc123', NULL, 'default', ?, ?)`
  ).run(now, now)

  writeFileSync(join(STORE_DIR, '.vault-key'), 'fake-vault-master-key-material', 'utf-8')
  writeFileSync(join(STORE_DIR, 'vault.json'), JSON.stringify({
    entries: [{ id: 'ssh-key-abc123', label: 'SSH private key: test', encrypted: 'FAKE-CIPHERTEXT', tenant_id: 'default', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  }), 'utf-8')

  writeFileSync(join(STORE_DIR, 'model-fallback.json'), JSON.stringify({ enabled: true, chain: ['source-chain'], revertAfterMinutes: 60 }), 'utf-8')
  writeFileSync(join(STORE_DIR, 'federation.json'), JSON.stringify({ enabled: true, systemId: 'source-system' }), 'utf-8')
  writeFileSync(join(STORE_DIR, 'costops-config.json'), JSON.stringify({ version: 1, currency: 'USD', budgets: [] }), 'utf-8')
  writeFileSync(join(STORE_DIR, 'egress-allowlist.json'), JSON.stringify({ domains: ['source.example.com', 'shared.example.com'] }), 'utf-8')
}

function resetToFreshTarget(preserveEgressDomains: string[] | null) {
  initDatabase(':memory:')
  writeFileSync(join(STORE_DIR, 'vault.json'), JSON.stringify({ entries: [] }), 'utf-8')
  writeFileSync(join(STORE_DIR, '.vault-key'), '', 'utf-8')
  for (const f of ['model-fallback.json', 'federation.json', 'costops-config.json']) {
    writeFileSync(join(STORE_DIR, f), '{}', 'utf-8')
  }
  writeFileSync(join(STORE_DIR, 'egress-allowlist.json'), JSON.stringify({ domains: preserveEgressDomains ?? [] }), 'utf-8')
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

describe('end-to-end: export a fully-populated source fleet, apply onto a fresh target', () => {
  it('recreates every P1-P4 section correctly in a single combined run', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    seedSourceFleet()

    const exported = exportFleet({ vaultPassword: 'correct-horse-battery-staple' })

    // Fresh target: empty DB, and a target that already has its OWN egress domain
    // (to prove the merge, not overwrite, semantics survive a full combined run).
    resetToFreshTarget(['target-only.example.com', 'shared.example.com'])

    const dry = importFleet(exported.data, { apply: false, vaultPassword: 'correct-horse-battery-staple' }) as any
    expect(dry.errors).toEqual([])
    expect(dry.wouldCreate.schedules).toBe(1)
    expect(dry.wouldCreate.importSources).toBe(1)
    expect(dry.wouldCreate.vaultSshKeys).toBe(1)
    expect(dry.wouldCreate.vaultSshServers).toBe(1)

    const applied = importFleet(exported.data, { apply: true, vaultPassword: 'correct-horse-battery-staple' }) as any
    expect(applied.ok).toBe(true)
    expect(applied.imported.schedules).toBe(1)
    expect(applied.imported.importSources).toBe(1)
    expect(applied.imported.vaultSshKeys).toBe(1)
    expect(applied.imported.vaultSshServers).toBe(1)

    // P1: schedule landed, force-disabled
    const schedule = getDb().prepare('SELECT * FROM schedules WHERE id = ?').get('morning-chain') as any
    expect(schedule.enabled).toBe(0)

    // P2: import source landed, force-disabled, last_run_at cleared
    const source = getDb().prepare('SELECT * FROM import_sources WHERE id = ?').get('local-docs') as any
    expect(source.enabled).toBe(0)
    expect(source.last_run_at).toBeNull()

    // P4: SSH key metadata + server landed, and the actual secret was re-materialized
    const key = getDb().prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get('abc123') as any
    expect(key.public_key).toContain('ssh-ed25519')
    const server = getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get('srv-1') as any
    expect(server.ssh_key_id).toBe('abc123')
    const targetVault = JSON.parse(readFileSync(join(STORE_DIR, 'vault.json'), 'utf-8'))
    expect(targetVault.entries.some((e: any) => e.id === 'ssh-key-abc123' && e.encrypted === 'FAKE-CIPHERTEXT')).toBe(true)

    // P3: overwrite fields replaced wholesale
    expect(JSON.parse(readFileSync(join(STORE_DIR, 'model-fallback.json'), 'utf-8'))).toEqual({ enabled: true, chain: ['source-chain'], revertAfterMinutes: 60 })
    expect(JSON.parse(readFileSync(join(STORE_DIR, 'federation.json'), 'utf-8')).systemId).toBe('source-system')
    expect(JSON.parse(readFileSync(join(STORE_DIR, 'costops-config.json'), 'utf-8')).currency).toBe('USD')

    // P3: egress-allowlist MERGED, not overwritten -- target's own domain survives
    const mergedDomains = JSON.parse(readFileSync(join(STORE_DIR, 'egress-allowlist.json'), 'utf-8')).domains as string[]
    expect(mergedDomains.sort()).toEqual(['shared.example.com', 'source.example.com', 'target-only.example.com'])
  })

  it('re-applying the same encrypted export a second time is a clean no-op (fully idempotent combined run)', async () => {
    const { exportFleet, importFleet } = await import('../web/fleet-transfer.js')
    seedSourceFleet()
    const exported = exportFleet({ vaultPassword: 'correct-horse-battery-staple' })

    resetToFreshTarget(null)
    importFleet(exported.data, { apply: true, vaultPassword: 'correct-horse-battery-staple' })
    const secondApply = importFleet(exported.data, { apply: true, vaultPassword: 'correct-horse-battery-staple' }) as any
    expect(secondApply.ok).toBe(true)

    expect(getDb().prepare('SELECT * FROM schedules WHERE id = ?').all('morning-chain')).toHaveLength(1)
    expect(getDb().prepare('SELECT * FROM import_sources WHERE id = ?').all('local-docs')).toHaveLength(1)
    expect(getDb().prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').all('abc123')).toHaveLength(1)
    expect(getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').all('srv-1')).toHaveLength(1)
  })
})

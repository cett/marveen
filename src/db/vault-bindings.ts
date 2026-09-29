// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).
//
// Read/write access to vault_bindings (migration 0062, #985 group 7/8) plus
// the one-time migrator that copies an existing install's
// store/vault-bindings.json into it. Unlike group 6's costops-config.json,
// the WHOLE file's content moves here -- nothing else lives in
// vault-bindings.json, so it is fully retired (see retireVaultBindingsFile
// in db/index.ts), not merely one field of it.
//
// SECURITY: this module never stores or returns an actual secret value --
// only the metadata a binding is (which vault_secret_id maps to which
// env_var, and which MCP file/server it syncs into). See the migration
// file's own header comment for the full rationale.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './connection.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export interface VaultBindingTarget {
  mcpFilePath: string
  serverName: string
}

export interface VaultBinding {
  vaultSecretId: string
  envVar: string
  targets: VaultBindingTarget[]
}

interface VaultBindingRow {
  vault_secret_id: string
  env_var: string
  targets: string
  tenant_id: string
}

function rowToBinding(row: VaultBindingRow): VaultBinding {
  let targets: VaultBindingTarget[]
  try { targets = JSON.parse(row.targets) } catch { targets = [] }
  return { vaultSecretId: row.vault_secret_id, envVar: row.env_var, targets }
}

export function listVaultBindings(tenantId: string = 'default'): VaultBinding[] {
  const rows = db
    .prepare('SELECT vault_secret_id, env_var, targets, tenant_id FROM vault_bindings WHERE tenant_id = ? ORDER BY vault_secret_id, env_var')
    .all(tenantId) as VaultBindingRow[]
  return rows.map(rowToBinding)
}

// Insert-or-replace keyed by (vaultSecretId, envVar, tenantId) -- mirrors
// the pre-migration addBinding()'s find-by-pair-and-replace semantics.
export function upsertVaultBinding(tenantId: string, binding: VaultBinding): void {
  db.prepare(`
    INSERT INTO vault_bindings (vault_secret_id, env_var, targets, tenant_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(vault_secret_id, env_var, tenant_id) DO UPDATE SET
      targets = excluded.targets,
      updated_at = excluded.updated_at
  `).run(binding.vaultSecretId, binding.envVar, JSON.stringify(binding.targets), tenantId)
}

// Returns true iff a matching row existed and was deleted -- mirrors
// removeBinding()'s pre-migration boolean return.
export function deleteVaultBinding(tenantId: string, vaultSecretId: string, envVar: string): boolean {
  const result = db
    .prepare('DELETE FROM vault_bindings WHERE vault_secret_id = ? AND env_var = ? AND tenant_id = ?')
    .run(vaultSecretId, envVar, tenantId)
  return result.changes > 0
}

// Returns the bindings that were deleted (their targets are still needed by
// the caller -- removeBindingsForSecret() -- to strip the env var from each
// target MCP file before the row itself disappears).
export function deleteVaultBindingsForSecret(tenantId: string, vaultSecretId: string): VaultBinding[] {
  const rows = db
    .prepare('SELECT vault_secret_id, env_var, targets, tenant_id FROM vault_bindings WHERE vault_secret_id = ? AND tenant_id = ?')
    .all(vaultSecretId, tenantId) as VaultBindingRow[]
  db.prepare('DELETE FROM vault_bindings WHERE vault_secret_id = ? AND tenant_id = ?').run(vaultSecretId, tenantId)
  return rows.map(rowToBinding)
}

// Whole-value replace within a transaction: used by fleet-transfer import
// (P3 semantics, matching the old whole-file overwrite this store used to
// get from trackedWrite('vault-bindings.json', ...)).
export function replaceVaultBindings(tenantId: string, bindings: VaultBinding[]): void {
  const now = Math.floor(Date.now() / 1000)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vault_bindings WHERE tenant_id = ?').run(tenantId)
    const stmt = db.prepare(`
      INSERT INTO vault_bindings (vault_secret_id, env_var, targets, tenant_id, created_at, updated_at)
      VALUES (@vault_secret_id, @env_var, @targets, @tenant_id, @now, @now)
    `)
    for (const b of bindings) {
      stmt.run({
        vault_secret_id: b.vaultSecretId,
        env_var: b.envVar,
        targets: JSON.stringify(b.targets ?? []),
        tenant_id: tenantId,
        now,
      })
    }
  })
  tx()
}

// One-time backfill of an existing install's store/vault-bindings.json into
// vault_bindings. INSERT OR IGNORE per row (same idiom as the other #985
// group file-backfill migrators): an operator's later DB edit is never
// overwritten by a stale re-read, and a fresh install with no file gets zero
// rows -- matching getBindings()'s own pre-migration default of an empty
// list. Safe to call on every boot.
export function migrateVaultBindingsFromFile(): number {
  const filePath = join(STORE_DIR, 'vault-bindings.json')
  if (!existsSync(filePath)) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    logger.warn({ err, filePath }, 'vault_bindings migration: failed to parse vault-bindings.json, skipping')
    return 0
  }
  if (!parsed || typeof parsed !== 'object') return 0
  const rawBindings = (parsed as Record<string, unknown>).bindings
  if (!Array.isArray(rawBindings)) return 0

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO vault_bindings (vault_secret_id, env_var, targets, tenant_id, created_at, updated_at)
    VALUES (@vault_secret_id, @env_var, @targets, 'default', unixepoch(), unixepoch())
  `)
  let migrated = 0
  for (const e of rawBindings) {
    const b = e as Record<string, unknown>
    if (typeof b?.vaultSecretId !== 'string' || !b.vaultSecretId) continue
    if (typeof b?.envVar !== 'string' || !b.envVar) continue
    const targets = Array.isArray(b.targets) ? b.targets : []
    const result = stmt.run({
      vault_secret_id: b.vaultSecretId,
      env_var: b.envVar,
      targets: JSON.stringify(targets),
    })
    if (result.changes > 0) migrated++
  }
  return migrated
}

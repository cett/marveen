// Read/write access to vault_secret_acl (migration 0090): the per-secret list of
// grantees that may receive the secret in their MCP file.
//
// An EMPTY list means "open" (the behaviour before the table existed); the
// enforcement lives in web/vault-bindings.ts, this module only stores the set.
//
// Named vault-secret-acl (not vault-acl) on purpose: src/web/vault-acl.ts is the
// unrelated READER allowlist (store/vault-acl.json), and two modules with one
// basename in db/ and web/ invite the wrong import.
//
// SECURITY: this module never stores or returns a secret value, only the secret
// id and the grantee names.
import { dbx } from './facade.js'

interface VaultSecretAclRow {
  grantee: string
}

// Sorted so the answer is stable for the API and the tests.
export async function listSecretAcl(tenantId: string, vaultSecretId: string): Promise<string[]> {
  const rows = await dbx.all<VaultSecretAclRow>(
    'SELECT grantee FROM vault_secret_acl WHERE tenant_id = ? AND vault_secret_id = ? ORDER BY grantee',
    tenantId, vaultSecretId,
  )
  return rows.map(r => r.grantee)
}

// Whole-set replace in ONE transaction: delete + insert. A failure half way rolls
// back to the previous set, so the list is never left half written (a half-written
// list would silently turn a restricted secret into a narrower, or an open one into
// a restricted, set). A repeated grantee collapses to one row. An empty array opens
// the secret.
export async function replaceSecretAcl(tenantId: string, vaultSecretId: string, grantees: readonly string[]): Promise<void> {
  const unique = [...new Set(grantees)]
  await dbx.tx(async (tx) => {
    await tx.run('DELETE FROM vault_secret_acl WHERE tenant_id = ? AND vault_secret_id = ?', tenantId, vaultSecretId)
    for (const grantee of unique) {
      await tx.run(
        'INSERT INTO vault_secret_acl (vault_secret_id, tenant_id, grantee) VALUES (?, ?, ?)',
        vaultSecretId, tenantId, grantee,
      )
    }
  })
}

// Drops the whole list of a secret (the secret itself is deleted). Without this a
// reused id would inherit the old restriction: fail-closed, but surprising.
export async function deleteSecretAcl(tenantId: string, vaultSecretId: string): Promise<void> {
  await dbx.run('DELETE FROM vault_secret_acl WHERE tenant_id = ? AND vault_secret_id = ?', tenantId, vaultSecretId)
}

// Every secret that has a list, for the secret listing (one query, not one per row).
export async function listAllSecretAcls(tenantId: string): Promise<Record<string, string[]>> {
  const rows = await dbx.all<VaultSecretAclRow & { vault_secret_id: string }>(
    'SELECT vault_secret_id, grantee FROM vault_secret_acl WHERE tenant_id = ? ORDER BY vault_secret_id, grantee',
    tenantId,
  )
  const out: Record<string, string[]> = {}
  for (const r of rows) (out[r.vault_secret_id] ??= []).push(r.grantee)
  return out
}

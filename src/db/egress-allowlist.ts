// Read/write access to egress_allowlist (migration 0056; the 199 domains this
// install had in store/egress-allowlist.json at authoring time are hardcoded
// into the migration's seed, same pattern as autonomy_categories/0053).
//
// The WebFetch egress-gate hook (scripts/hooks/egress-gate.mjs) runs OUTSIDE
// this process -- it reaches this table only indirectly, through
// GET /api/v1/egress-allowlist (src/web/routes/egress-allowlist.ts), never by
// importing this module. Everything in-process (agent-scaffold-hooks.ts's
// quarantine-reader template render, fleet-transfer.ts export/import) calls
// straight into these functions.

import { dbx } from './facade.js'

export type EgressAllowlistType = 'domain' | 'prefix' | 'quarantine_domain'

export interface EgressAllowlistRow {
  id: number
  value: string
  type: EgressAllowlistType
  added_by: string
  added_at: number
  tenant_id: string
}

const SELECT_COLUMNS = 'id, value, type, added_by, added_at, tenant_id'

/**
 * List allowlist rows. `tenantId` narrows to one tenant; `null` (the
 * default) returns every tenant's rows -- the "admin, no ?tenant filter"
 * shape the dashboard uses, and also what the hook's own effective allowlist
 * must be (the hook enforces one fleet-wide policy, not a per-tenant one --
 * see the route module for why).
 */
export async function listEgressAllowlistRows(tenantId: string | null = null): Promise<EgressAllowlistRow[]> {
  if (tenantId === null) {
    return dbx.all<EgressAllowlistRow>(`SELECT ${SELECT_COLUMNS} FROM egress_allowlist ORDER BY type, value`)
  }
  return dbx.all<EgressAllowlistRow>(`SELECT ${SELECT_COLUMNS} FROM egress_allowlist WHERE tenant_id = ? ORDER BY type, value`, tenantId)
}

export async function getEgressAllowlistRow(id: number): Promise<EgressAllowlistRow | undefined> {
  return dbx.get<| EgressAllowlistRow>(`SELECT ${SELECT_COLUMNS} FROM egress_allowlist WHERE id = ?`, id)
}

/**
 * Insert one entry. INSERT OR IGNORE on the (value, type, tenant_id) unique
 * key -- adding an entry that already exists is a no-op, not a conflict (the
 * route treats that as success, matching the old file's "domain already in
 * the list" behavior).
 */
export async function insertEgressAllowlistEntry(entry: {
  value: string
  type: EgressAllowlistType
  tenant_id?: string
  added_by?: string
}): Promise<void> {
  await dbx.run(`INSERT INTO egress_allowlist (value, type, added_by, added_at, tenant_id)
     VALUES (?, ?, ?, unixepoch(), ?)
     ON CONFLICT DO NOTHING`, entry.value, entry.type, entry.added_by ?? 'dashboard', entry.tenant_id ?? 'default')
}

export async function deleteEgressAllowlistEntry(id: number): Promise<boolean> {
  const result = await dbx.run('DELETE FROM egress_allowlist WHERE id = ?', id)
  return result.changes > 0
}

/**
 * fleet-transfer.ts import: union merge, never overwrite. INSERT OR IGNORE
 * per row is the exact DB equivalent of the old file logic's
 * `[...new Set([...existingDomains, ...sourceDomains])]` -- an entry the
 * target already has is left completely untouched, one it doesn't gets
 * added. `added_by`/`added_at` on an already-existing row are therefore
 * never touched by an import, by construction (IGNORE never fires UPDATE).
 */
export async function mergeEgressAllowlistEntries(
  entries: Array<{ value: string; type: EgressAllowlistType; tenant_id?: string; added_by?: string }>
): Promise<void> {
  await dbx.tx(async (tx) => {
    for (const row of entries) {
      await tx.run(
        `INSERT INTO egress_allowlist (value, type, added_by, added_at, tenant_id)
         VALUES (?, ?, ?, unixepoch(), ?)
         ON CONFLICT DO NOTHING`,
        row.value, row.type, row.added_by ?? 'seed_migration', row.tenant_id ?? 'default'
      )
    }
  })
}

/** Just the values of one type, across all tenants -- what a fleet-wide consumer (quarantine-reader template render) wants. */
export async function listEgressAllowlistValues(type: EgressAllowlistType): Promise<string[]> {
  return (
    (await dbx.all('SELECT value FROM egress_allowlist WHERE type = ? ORDER BY value', type)) as { value: string }[]
  ).map((r) => r.value)
}

import { writeAgentAuditLog } from '../db.js'
import type { Tx } from '../db/facade.js'
import { resolveWriteTenant } from '../db/write-tenant.js'

/** The transaction an audit row is written in, and the tenant the caller resolved before the transaction opened. */
export interface AutonomyAuditWithin {
  tx: Tx
  tenantId: string | null
}

/**
 * The tenant an audit row of `who` is stamped with, for a caller that will write the row inside a transaction (where the
 * lookup, which runs on the facade, cannot run on Postgres). Resolved BEFORE the transaction opens. `undefined` when
 * the lookup itself failed: the row is then not written, exactly as a failing lookup inside the audit write skipped it.
 */
export async function resolveAutonomyAuditTenant(who: string): Promise<{ tenantId: string | null } | undefined> {
  try {
    return { tenantId: await resolveWriteTenant(who) }
  } catch {
    return undefined
  }
}

/**
 * The audit row of one autonomy level change, written by every path that changes a level (the dashboard route and the
 * fleet import) so the shape cannot drift: who, the category, and the level before and after. A failure to write the row
 * never aborts the change it describes.
 *
 * `within` is the transaction the row belongs to when the caller writes it inside one (the fleet import body). The
 * insert then runs in a savepoint of that transaction: a failed insert is rolled back to the savepoint, so swallowing
 * the error leaves the outer transaction usable (on Postgres a swallowed failed statement would otherwise leave it
 * aborted, and the change it describes would be lost with it).
 */
export async function auditAutonomyLevelChange(
  who: string,
  key: string,
  levelFrom: unknown,
  levelTo: unknown,
  within?: AutonomyAuditWithin,
): Promise<void> {
  const entry = {
    agent_id: who,
    entity: 'approval' as const,
    action: 'update' as const,
    entity_id: key,
    detail: { autonomy_category: key, level_from: levelFrom, level_to: levelTo },
  }
  try {
    if (within === undefined) await writeAgentAuditLog(entry)
    else await within.tx.tx((sp) => writeAgentAuditLog({ ...entry, tenant_id: within.tenantId }, sp))
  } catch { /* audit failure must not abort the write */ }
}

import { writeAgentAuditLog } from '../db.js'

/**
 * The audit row of one autonomy level change, written by every path that changes a level (the dashboard route and the
 * fleet import) so the shape cannot drift: who, the category, and the level before and after. A failure to write the row
 * never aborts the change it describes.
 */
export async function auditAutonomyLevelChange(who: string, key: string, levelFrom: unknown, levelTo: unknown): Promise<void> {
  try {
    await writeAgentAuditLog({
      agent_id: who,
      entity: 'approval',
      action: 'update',
      entity_id: key,
      detail: { autonomy_category: key, level_from: levelFrom, level_to: levelTo },
    })
  } catch { /* audit failure must not abort the write */ }
}

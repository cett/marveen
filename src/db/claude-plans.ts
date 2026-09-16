// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).
//
// Claude Plans registry (#886): a DB mirror of store/claude-plans.json
// (claude_plans_registry) plus a NEW per-agent active-plan binding
// (agent_active_plans) with a real lifecycle -- unlike the JSON side-car
// store/claude-plans-state.json, a dead agent's binding does not stay
// "active" forever (see sweepStaleActivePlans / deactivatePlanForAgent).
//
// IMPORTANT: claude_plans_registry is a DERIVED mirror, not the operational
// source of truth. src/web/claude-plans.ts (store/claude-plans.json) stays
// authoritative for launch-time config-dir resolution, because
// resolveMainAgentRotatedConfigDir() is called from
// scripts/main-agent-isolated-config.mjs -- a standalone script that runs
// BEFORE the web server (and its DB connection) exists, at main-agent boot.
// Making that path DB-only would risk exactly the class of main-agent auth
// outage documented in agent-process-config.ts (2026-07-23, 2026-09-12).
// The registry mirror exists so the dashboard's blackboard badge and audit
// views have a place to read plan metadata from without importing a web/
// domain module into src/db/ (kept acyclic, see db/index.ts). Callers that
// create/update/delete a plan (src/web/routes/claude-plans.ts) write the
// file first (unchanged) and best-effort mirror the same write here.
import { db } from './connection.js'

export type ClaudePlanType = 'personal' | 'team'
export type ActivePlanSource = 'manual' | 'rotation' | 'handoff-recovery'

export interface ClaudePlanRegistryRow {
  id: string
  label: string
  config_dir: string
  plan_type: ClaudePlanType
  channels_allowed: number
  expected_org_type: string | null
  expected_email: string | null
  created_at: number
  updated_at: number
}

export interface ActivePlanForAgent {
  id: string
  label: string
  planType: ClaudePlanType
  channelsAllowed: boolean
  source: ActivePlanSource
  activatedAt: number
  lastHeartbeat: number
  /** True when plan_id no longer resolves in claude_plans_registry (the
   *  registry mirror and the binding fell out of sync -- should be rare,
   *  since deleteClaudePlanRow cascades explicitly, but a direct DB edit or
   *  a missed mirror write could still produce it). */
  planUnresolved: boolean
}

// ── claude_plans_registry: DB mirror, upsert-on-write from claude-plans.ts ──

export function upsertClaudePlanRow(plan: {
  id: string
  label: string
  configDir: string
  planType: ClaudePlanType
  channelsAllowed: boolean
  expectedOrgType?: string
  expectedEmail?: string
}): void {
  db.prepare(`
    INSERT INTO claude_plans_registry
      (id, label, config_dir, plan_type, channels_allowed, expected_org_type, expected_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      label             = excluded.label,
      config_dir        = excluded.config_dir,
      plan_type         = excluded.plan_type,
      channels_allowed  = excluded.channels_allowed,
      expected_org_type = excluded.expected_org_type,
      expected_email    = excluded.expected_email,
      updated_at        = unixepoch()
  `).run(
    plan.id, plan.label, plan.configDir, plan.planType, plan.channelsAllowed ? 1 : 0,
    plan.expectedOrgType ?? null, plan.expectedEmail ?? null,
  )
}

// Replace the whole registry mirror in one transaction -- mirrors the file
// side's read-modify-write-full-array shape (writeClaudePlans), so the two
// never partially diverge mid-write.
// Explicit cascade (foreign_keys enforcement is off for this connection, as
// elsewhere in this schema -- see 0041_confluence_source_type.sql): whatever
// this leaves out of claude_plans_registry, agent_active_plans cannot keep
// pointing at either -- run on every replace, not just an explicit
// single-id delete, so a plan dropped by any write path (dashboard delete,
// a future bulk import) can never leave a dangling binding.
function cascadeDropOrphanedActivePlans(): void {
  db.prepare('DELETE FROM agent_active_plans WHERE plan_id NOT IN (SELECT id FROM claude_plans_registry)').run()
}

export function replaceClaudePlanRows(plans: {
  id: string
  label: string
  configDir: string
  planType: ClaudePlanType
  channelsAllowed: boolean
  expectedOrgType?: string
  expectedEmail?: string
}[]): void {
  const tx = db.transaction((rows: typeof plans) => {
    db.prepare('DELETE FROM claude_plans_registry').run()
    for (const plan of rows) upsertClaudePlanRow(plan)
    cascadeDropOrphanedActivePlans()
  })
  tx(plans)
}

export function deleteClaudePlanRow(id: string): void {
  const tx = db.transaction((planId: string) => {
    db.prepare('DELETE FROM claude_plans_registry WHERE id = ?').run(planId)
    cascadeDropOrphanedActivePlans()
  })
  tx(id)
}

export function listClaudePlanRows(): ClaudePlanRegistryRow[] {
  return db.prepare('SELECT * FROM claude_plans_registry ORDER BY id').all() as ClaudePlanRegistryRow[]
}

// ── agent_active_plans: per-agent binding lifecycle ──────────────────────────

// INSERT OR REPLACE, source-tagged (design section 4: manual / rotation /
// handoff-recovery). Also refreshes activated_at + last_heartbeat, so an
// agent re-activating the SAME plan it was already on still counts as a
// fresh binding for staleness purposes.
export function activatePlanForAgent(agentId: string, planId: string, source: ActivePlanSource): void {
  db.prepare(`
    INSERT INTO agent_active_plans (agent_id, plan_id, activated_at, last_heartbeat, source)
    VALUES (?, ?, unixepoch(), unixepoch(), ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      plan_id        = excluded.plan_id,
      activated_at   = unixepoch(),
      last_heartbeat = unixepoch(),
      source         = excluded.source
  `).run(agentId, planId, source)
}

// Called by every write path that means "this agent no longer has a plan
// binding worth keeping": blackboard done/stale transitions, plan-sweeper
// timeout, and a clean agent-process stop. Explicit call rather than a
// trigger, so each caller stays independently unit-testable (design section
// 3A). Safe no-op when the agent has no active binding.
export function deactivatePlanForAgent(agentId: string): void {
  db.prepare('DELETE FROM agent_active_plans WHERE agent_id = ?').run(agentId)
}

// Refresh last_heartbeat without touching source/activated_at -- called by a
// still-alive agent's regular plan-state poll, so the plan-sweeper's
// PLAN_STALE_MIN timeout measures actual liveness, not just the original
// activation time.
export function touchActivePlanHeartbeat(agentId: string): void {
  db.prepare('UPDATE agent_active_plans SET last_heartbeat = unixepoch() WHERE agent_id = ?').run(agentId)
}

function toActivePlan(row: {
  plan_id: string; activated_at: number; last_heartbeat: number; source: ActivePlanSource
  reg_label: string | null; reg_plan_type: ClaudePlanType | null; reg_channels_allowed: number | null
}): ActivePlanForAgent {
  return {
    id: row.plan_id,
    label: row.reg_label ?? row.plan_id,
    planType: row.reg_plan_type ?? 'personal',
    channelsAllowed: !!row.reg_channels_allowed,
    source: row.source,
    activatedAt: row.activated_at,
    lastHeartbeat: row.last_heartbeat,
    planUnresolved: row.reg_label === null,
  }
}

export function getActivePlanForAgent(agentId: string): ActivePlanForAgent | null {
  const row = db.prepare(`
    SELECT aap.plan_id, aap.activated_at, aap.last_heartbeat, aap.source,
           r.label AS reg_label, r.plan_type AS reg_plan_type, r.channels_allowed AS reg_channels_allowed
      FROM agent_active_plans aap
      LEFT JOIN claude_plans_registry r ON r.id = aap.plan_id
     WHERE aap.agent_id = ?
  `).get(agentId) as Parameters<typeof toActivePlan>[0] | undefined
  return row ? toActivePlan(row) : null
}

// Bulk lookup for GET /api/blackboard -- one query for every row on the
// page instead of one per row.
export function listActivePlansForAgents(agentIds: string[]): Map<string, ActivePlanForAgent> {
  const map = new Map<string, ActivePlanForAgent>()
  if (agentIds.length === 0) return map
  const placeholders = agentIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT aap.agent_id, aap.plan_id, aap.activated_at, aap.last_heartbeat, aap.source,
           r.label AS reg_label, r.plan_type AS reg_plan_type, r.channels_allowed AS reg_channels_allowed
      FROM agent_active_plans aap
      LEFT JOIN claude_plans_registry r ON r.id = aap.plan_id
     WHERE aap.agent_id IN (${placeholders})
  `).all(...agentIds) as ({ agent_id: string } & Parameters<typeof toActivePlan>[0])[]
  for (const row of rows) map.set(row.agent_id, toActivePlan(row))
  return map
}

// Plan-sweeper (design section 4, "meglévő BB sweeper mellé"): drop bindings
// whose last_heartbeat is older than ttlMin minutes. Runs alongside (not
// instead of) the blackboard stale sweeper -- see blackboard-stale-sweeper.ts.
// Returns how many rows were removed.
export function sweepStaleActivePlans(ttlMin: number, nowSec = Math.floor(Date.now() / 1000)): number {
  const cutoff = nowSec - ttlMin * 60
  return db.prepare('DELETE FROM agent_active_plans WHERE last_heartbeat < ?').run(cutoff).changes
}

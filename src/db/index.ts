// Re-export surface for the split db.ts modules, plus the wired
// initDatabase() that orchestrates connection bootstrap + vector-domain
// post-migration setup. connection.ts never imports a domain module (kept
// acyclic on purpose -- every domain module imports connection.ts, not the
// other way round); this file is the one place allowed to know about all of
// them, so it is also the one place that sequences cross-domain boot steps.
//
// src/db.ts re-exports everything from here, so the 153 existing importers
// of '../../db.js' (or similar relative paths) keep working unchanged.
export * from './connection.js'
export * from './agents.js'
export * from './audit.js'
export * from './claude-plans.js'
export * from './kanban.js'
export * from './memory.js'
export * from './misc.js'
export * from './observability.js'
export * from './sessions.js'
export * from './tasks.js'
export * from './vault.js'
export * from './vector.js'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { initDatabase as connectionInitDatabase, db } from './connection.js'
import { backfillImportShadowRows, initVecSupport, migrateExistingEmbeddingsToBLOB } from './vector.js'
import { replaceClaudePlanRows, activatePlanForAgent, type ClaudePlanType } from './claude-plans.js'
import { logger } from '../logger.js'

export function initDatabase(dbPathOverride?: string): void {
  connectionInitDatabase(dbPathOverride)

  // Convert any remaining JSON-text embeddings to compact Float32 BLOB and null
  // out the TEXT column. Idempotent: rows already having embedding_blob are
  // skipped; on fresh installs or after a full backfill this is a no-op.
  migrateExistingEmbeddingsToBLOB()

  // Load sqlite-vec extension and set up the ANN virtual table + sync triggers.
  // Safe no-op if the extension binary is unavailable; vectorSearch falls back
  // to full-scan BLOB cosine similarity in that case.
  initVecSupport()

  // Create shadow rows in memories for any import_memories entries that lack
  // them. Must run after initVecSupport so that vec0 is loaded and the
  // vec_memories virtual table exists before the backfill inserts into it.
  void backfillImportShadowRows().catch(err => logger.warn({ err }, 'Import shadow backfill failed'))

  // One-time seed of the claude_plans_registry / agent_active_plans DB mirror
  // from the two JSON side-cars (#886). UNLIKE migrateTaskRunsFromJson in
  // connection.ts, the source files are NOT renamed/retired afterward: they
  // stay the operational source of truth for the DB-less main-agent boot path
  // (scripts/main-agent-isolated-config.mjs -> resolveMainAgentRotatedConfigDir,
  // which runs before this initDatabase() ever executes). This seed only
  // back-fills the mirror so the dashboard/blackboard badge has data for
  // plans/rotations that existed before this DB migration shipped; every
  // subsequent write goes through the mirror-write helpers below and in
  // src/web/routes/claude-plans.ts.
  seedClaudePlansRegistryMirror()
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function seedClaudePlansRegistryMirror(): void {
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM claude_plans_registry').get() as { c: number }).c
  if (existingCount === 0) {
    const plansPath = join(STORE_DIR, 'claude-plans.json')
    if (existsSync(plansPath)) {
      try {
        const raw = JSON.parse(readFileSync(plansPath, 'utf-8'))
        if (Array.isArray(raw)) {
          const plans: Parameters<typeof replaceClaudePlanRows>[0] = []
          for (const entry of raw) {
            if (!entry || typeof entry !== 'object') continue
            const o = entry as Record<string, unknown>
            if (!isNonEmptyString(o.id) || !isNonEmptyString(o.label) || !isNonEmptyString(o.configDir)) continue
            if (o.planType !== 'personal' && o.planType !== 'team') continue
            plans.push({
              id: o.id, label: o.label, configDir: o.configDir,
              planType: o.planType as ClaudePlanType,
              channelsAllowed: o.channelsAllowed === true,
              expectedOrgType: isNonEmptyString(o.expectedOrgType) ? o.expectedOrgType : undefined,
              expectedEmail: isNonEmptyString(o.expectedEmail) ? o.expectedEmail : undefined,
            })
          }
          replaceClaudePlanRows(plans)
        }
      } catch (err) {
        logger.warn({ err }, 'claude-plans-registry mirror seed: failed to read/parse claude-plans.json, skipping')
      }
    }
  }

  const activeCount = (db.prepare('SELECT COUNT(*) as c FROM agent_active_plans').get() as { c: number }).c
  if (activeCount === 0) {
    const statePath = join(STORE_DIR, 'claude-plans-state.json')
    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
        const activePlanByAgent = raw && typeof raw === 'object' ? raw.activePlanByAgent : null
        if (activePlanByAgent && typeof activePlanByAgent === 'object') {
          for (const [agentId, planId] of Object.entries(activePlanByAgent as Record<string, unknown>)) {
            if (!isNonEmptyString(planId)) continue
            // This connection enforces `PRAGMA foreign_keys` (see
            // db/claude-plans.ts header) -- a plan id in the state file that
            // no longer exists in the just-seeded registry (removed from
            // claude-plans.json since the state file was last written) throws
            // here. Per-entry try/catch so one stale reference cannot abort
            // the whole seed (and therefore initDatabase()) on upgrade.
            try { activatePlanForAgent(agentId, planId, 'manual') }
            catch (err) { logger.warn({ err, agentId, planId }, 'claude-plans-registry mirror seed: skipping stale activePlanByAgent entry') }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'claude-plans-registry mirror seed: failed to read/parse claude-plans-state.json, skipping')
      }
    }
  }
}

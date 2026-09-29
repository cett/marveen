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
export * from './autonomy.js'
export * from './claude-plans.js'
export * from './egress-allowlist.js'
export * from './kanban.js'
export * from './memory.js'
export * from './misc.js'
export * from './model-profile-map.js'
export * from './observability.js'
export * from './sessions.js'
export * from './system-config.js'
export * from './tasks.js'
export * from './vault.js'
export * from './vector.js'

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { initDatabase as connectionInitDatabase, db } from './connection.js'
import { backfillImportShadowRows, initVecSupport, migrateExistingEmbeddingsToBLOB } from './vector.js'
import { replaceClaudePlanRows, activatePlanForAgent, type ClaudePlanType } from './claude-plans.js'
import { migrateConfigOverridesToSystemConfig, getSystemConfig, setSystemConfig } from './system-config.js'
import { migrateScheduleLastRunFromFile } from './tasks.js'
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

  // Backfill system_config from store/config-overrides.json, same
  // every-boot-but-effectively-once shape as the seed above (INSERT OR
  // IGNORE makes repeat calls a no-op for keys already migrated).
  //
  // S8B's file-retirement rename (retireConfigOverridesFile()) deliberately
  // does NOT live here even though it must run right after this migrator:
  // this initDatabase() is called from every test file's beforeEach against
  // the SAME real, shared worktree store/ dir (no per-test STORE_DIR
  // isolation in this codebase), so a rename here would race other
  // concurrently-running test files that read/write the same physical path.
  // The migrator above is read-only w.r.t. the filesystem (writes only to
  // its own process-local DB connection), so it doesn't have this problem.
  // See src/index.ts's real boot sequence for the rename call.
  migrateConfigOverridesToSystemConfig()

  // Migration 0057 (#985 group 2/8): one-time import of
  // store/schedule-last-run.json + store/schedule-tick-state.json into the
  // schedules.last_run_at column and the schedule_last_tick_ms system_config
  // row this migration added. Same every-boot-but-effectively-once shape as
  // the config-overrides migrator above (each write is itself idempotent --
  // see migrateScheduleLastRunFromFile's "only if still NULL" guard and the
  // tick-ms guard below), so calling this on every boot is harmless once the
  // JSON side-cars are gone.
  migrateScheduleStateFromFiles()
}

// Migration 0057 (#985 group 2/8) file retirement, mirroring
// retireConfigOverridesFile(): rename to .deprecated (matches store-watcher's
// SYSTEM_RE so the rename itself never surfaces as an audited "new file").
// Deliberately NOT called from initDatabase() -- same reason as
// retireConfigOverridesFile(): initDatabase() also runs from every test
// file's beforeEach against the same real, shared worktree store/ dir, and a
// rename there would race other concurrently-running test files. Called once
// from src/index.ts's real process boot, right after migrateScheduleStateFromFiles()
// (via initDatabase()) has guaranteed every value either file held is already
// imported.
export function retireScheduleStateFiles(): void {
  for (const name of ['schedule-last-run.json', 'schedule-tick-state.json']) {
    const p = join(STORE_DIR, name)
    if (!existsSync(p)) continue
    try {
      renameSync(p, `${p}.deprecated`)
      logger.info({ path: p }, 'schedule state file retired (renamed to .deprecated) -- schedules/system_config DB is now the only read source')
    } catch (err) {
      logger.warn({ err, path: p }, 'schedule state migration: failed to rename file to .deprecated')
    }
  }
}

function migrateScheduleStateFromFiles(): void {
  const lastRunPath = join(STORE_DIR, 'schedule-last-run.json')
  if (existsSync(lastRunPath)) {
    try {
      const raw = JSON.parse(readFileSync(lastRunPath, 'utf-8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        migrateScheduleLastRunFromFile(raw as Record<string, unknown>)
      }
    } catch (err) {
      logger.warn({ err }, 'schedule state migration: failed to parse schedule-last-run.json, skipping')
    }
  }

  // schedule_last_tick_ms is seeded to '0' by migration 0057 itself; only
  // overwrite that placeholder with the file's real value the first time
  // (source stays 'db' either way -- the runner writes through setSystemConfig
  // on every subsequent tick, same as before the migration, just DB instead
  // of file).
  const tickStatePath = join(STORE_DIR, 'schedule-tick-state.json')
  if (existsSync(tickStatePath)) {
    const current = getSystemConfig('schedule_last_tick_ms')
    if (!current || current.value === '0') {
      try {
        const raw = JSON.parse(readFileSync(tickStatePath, 'utf-8')) as { lastTickMs?: unknown }
        if (typeof raw?.lastTickMs === 'number' && Number.isFinite(raw.lastTickMs)) {
          setSystemConfig('schedule_last_tick_ms', String(raw.lastTickMs))
        }
      } catch (err) {
        logger.warn({ err }, 'schedule state migration: failed to parse schedule-tick-state.json, skipping')
      }
    }
  }
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

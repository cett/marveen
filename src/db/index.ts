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
export * from './agent-settings.js'
export * from './agent-state.js'
export * from './agents.js'
export * from './audit.js'
export * from './autonomy.js'
export * from './claude-plans.js'
export * from './cost-budgets.js'
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
import { STORE_DIR, MAIN_AGENT_ID } from '../config.js'
import { initDatabase as connectionInitDatabase, db } from './connection.js'
import { backfillImportShadowRows, initVecSupport, migrateExistingEmbeddingsToBLOB } from './vector.js'
import { replaceClaudePlanRows, activatePlanForAgent, type ClaudePlanType } from './claude-plans.js'
import { migrateConfigOverridesToSystemConfig, migrateGroup5StateFromFiles, getSystemConfig, setSystemConfig } from './system-config.js'
import { migrateScheduleLastRunFromFile } from './tasks.js'
import { importAgentSettingsFromFile, type AgentSettingKey } from './agent-settings.js'
import { getAgentState, setAgentState, importAgentStateFromFile, type AgentStateKey } from './agent-state.js'
import { migrateCostBudgetsFromFile } from './cost-budgets.js'
import { resolveAgentOwningTenantId } from './agents.js'
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
  migrateGroup5StateFromFiles()

  // Migration 0057 (#985 group 2/8): one-time import of
  // store/schedule-last-run.json + store/schedule-tick-state.json into the
  // schedules.last_run_at column and the schedule_last_tick_ms system_config
  // row this migration added. Same every-boot-but-effectively-once shape as
  // the config-overrides migrator above (each write is itself idempotent --
  // see migrateScheduleLastRunFromFile's "only if still NULL" guard and the
  // tick-ms guard below), so calling this on every boot is harmless once the
  // JSON side-cars are gone.
  migrateScheduleStateFromFiles()

  // Migration 0058 (#985 group 3/8): one-time import of
  // store/context-guard.json, store/auto-restart.json and the config half of
  // store/context-restart-gate.json into agent_settings. Same every-boot-
  // but-effectively-once shape as the migrators above (INSERT OR IGNORE per
  // row in importAgentSettingsFromFile, so a value already in the DB --
  // hand-edited or imported on a prior boot -- is never clobbered by a stale
  // file re-read).
  migrateAgentSettingsFromFiles()

  // Migration 0060 (#985 group 4/8, part 1): one-time import of the
  // context-restart-gate run-state half of #985 group 4 --
  // store/context-restart-gate-state.json -- into agent_state. Same
  // every-boot-but-effectively-once shape as the migrators above.
  migrateAgentStateFromFiles()

  // #985 group 4/8, part 2 (item 2A): one-time import of
  // store/kanban-audit-state.json into agent_state (same table as part 1,
  // no new migration number needed -- just a new state_key). Same
  // every-boot-but-effectively-once shape, via migrateKanbanAuditStateFromFile's
  // own "only if absent" guard.
  migrateKanbanAuditStateFromFile()

  // Migration 0061 (#985 group 6/8): one-time import of
  // store/costops-config.json's `budgets[]` array into cost_budgets.
  // version/currency/fixed_costs stay in the JSON file. Same every-boot-
  // but-effectively-once shape as the migrators above (INSERT OR IGNORE per
  // row in migrateCostBudgetsFromFile).
  migrateCostBudgetsFromFile()
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

// Migration 0058 (#985 group 3/8) file retirement, mirroring
// retireScheduleStateFiles() above -- rename to .deprecated, deliberately
// NOT called from initDatabase() for the same shared-worktree-store/-dir
// test-race reason. Called once from src/index.ts's real process boot,
// right after migrateAgentSettingsFromFiles() (via initDatabase()) has
// guaranteed every value all three files held is already imported.
export function retireAgentSettingsFiles(): void {
  for (const name of ['context-guard.json', 'auto-restart.json', 'context-restart-gate.json']) {
    const p = join(STORE_DIR, name)
    if (!existsSync(p)) continue
    try {
      renameSync(p, `${p}.deprecated`)
      logger.info({ path: p }, 'agent settings file retired (renamed to .deprecated) -- agent_settings DB is now the only read source')
    } catch (err) {
      logger.warn({ err, path: p }, 'agent settings migration: failed to rename file to .deprecated')
    }
  }
}

function migrateAgentSettingsFromFiles(): void {
  const files: Array<{ file: string; key: AgentSettingKey }> = [
    { file: 'context-guard.json', key: 'context_guard' },
    { file: 'auto-restart.json', key: 'auto_restart' },
    // Config half only -- context-restart-gate-state.json (run-state) is
    // migrated separately by migrateAgentStateFromFiles() below (group 4/8).
    { file: 'context-restart-gate.json', key: 'context_restart_gate' },
  ]
  for (const { file, key } of files) {
    const p = join(STORE_DIR, file)
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        importAgentSettingsFromFile(key, raw as Record<string, unknown>, resolveAgentOwningTenantId)
      }
    } catch (err) {
      logger.warn({ err, file }, 'agent settings migration: failed to parse file, skipping')
    }
  }
}

// Migration 0060 (#985 group 4/8, part 1) file retirement, mirroring
// retireAgentSettingsFiles() above. Deliberately NOT called from
// initDatabase() for the same shared-worktree-store/-dir test-race reason.
// Called once from src/index.ts's real process boot, right after
// migrateAgentStateFromFiles() (via initDatabase()) has guaranteed every
// value the file held is already imported.
export function retireAgentStateFiles(): void {
  const p = join(STORE_DIR, 'context-restart-gate-state.json')
  if (!existsSync(p)) return
  try {
    renameSync(p, `${p}.deprecated`)
    logger.info({ path: p }, 'agent state file retired (renamed to .deprecated) -- agent_state DB is now the only read source')
  } catch (err) {
    logger.warn({ err, path: p }, 'agent state migration: failed to rename file to .deprecated')
  }
}

function migrateAgentStateFromFiles(): void {
  const files: Array<{ file: string; key: AgentStateKey }> = [
    { file: 'context-restart-gate-state.json', key: 'gate_run_state' },
  ]
  for (const { file, key } of files) {
    const p = join(STORE_DIR, file)
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        importAgentStateFromFile(key, raw as Record<string, unknown>)
      }
    } catch (err) {
      logger.warn({ err, file }, 'agent state migration: failed to parse file, skipping')
    }
  }
}

// #985 group 4/8, part 2 (item 2A) file retirement, mirroring
// retireAgentStateFiles() above. Deliberately NOT called from initDatabase()
// for the same shared-worktree-store/-dir test-race reason. Called once from
// src/index.ts's real process boot, right after migrateKanbanAuditStateFromFile()
// (via initDatabase()) has guaranteed the file's value is already imported.
export function retireKanbanAuditStateFile(): void {
  const p = join(STORE_DIR, 'kanban-audit-state.json')
  if (!existsSync(p)) return
  try {
    renameSync(p, `${p}.deprecated`)
    logger.info({ path: p }, 'kanban-audit state file retired (renamed to .deprecated) -- agent_state DB is now the only read source')
  } catch (err) {
    logger.warn({ err, path: p }, 'kanban-audit state migration: failed to rename file to .deprecated')
  }
}

// #985 group 4/8, part 2 (item 2A): store/kanban-audit-state.json is a flat
// { last_audit_at } object, not the { [agentId]: state } map shape
// importAgentStateFromFile expects (that shape fits context-restart-gate's
// run-state, tracked per agent; kanban-audit is a single scheduled task run
// by MAIN_AGENT_ID, so it has exactly one owner). Hence a small dedicated
// importer instead of reusing importAgentStateFromFile, with the same
// "only if absent" idempotence (checked via getAgentState, since there is no
// bulk INSERT OR IGNORE helper for a single row).
function migrateKanbanAuditStateFromFile(): void {
  const p = join(STORE_DIR, 'kanban-audit-state.json')
  if (!existsSync(p)) return
  if (getAgentState(MAIN_AGENT_ID, 'kanban_audit_last_audit_at')) return
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { last_audit_at?: unknown }
    if (typeof raw?.last_audit_at === 'number' && Number.isFinite(raw.last_audit_at)) {
      setAgentState(MAIN_AGENT_ID, 'kanban_audit_last_audit_at', raw.last_audit_at)
    }
  } catch (err) {
    logger.warn({ err, file: 'kanban-audit-state.json' }, 'kanban-audit state migration: failed to parse file, skipping')
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

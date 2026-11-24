// The database part of the dashboard process boot, extracted from main() so it can run without the process: no listen,
// no timers, no runners, no signal handlers. main() calls it after the port takeover. Order as before the extraction:
// the backend (PostgreSQL when MARVEEN_PG_URL is set, SQLite otherwise), the agent tenant resolver, the RBAC mode, and the
// file retirements. A failing PostgreSQL step throws to the caller (main().catch ends the process; no SQLite fallback).
import { initDatabaseAsync, resolveAgentTenant, retireConfigOverridesFile, retireScheduleStateFiles, retireAgentSettingsFiles, retireAgentStateFiles, retireKanbanAuditStateFile, retireVaultBindingsFile, retireFederationConfigFile, retireGroup5StateFiles } from './db.js'
import { setAgentTenantResolver } from './db/background-jobs.js'
import { loadRbacMode } from './web/rbac-mode.js'
import { logger } from './logger.js'

export async function bootProcessDatabase(): Promise<'sqlite' | 'pg'> {
  const dbBackend = await initDatabaseAsync()
  logger.info({ backend: dbBackend }, 'Adatbazis inicializalva')
  // The agent jobs (auto-restart, context guard, restart gate, background tasks) run as the agent in its tenant.
  setAgentTenantResolver((agentId) => resolveAgentTenant(agentId))

  // RBAC_MODE: seed the system_config row from the env once (idempotent) and read the live mode. The refresh timer is
  // started by main(), not here.
  await loadRbacMode()

  // File retirements (rename a store JSON to .deprecated once its import ran). Only here, in the real process boot, never
  // from initDatabase() (that also runs from every test file against the shared store). Each step does nothing on
  // PostgreSQL (db/retire-guard.ts), so the source files stay in place there.
  retireConfigOverridesFile()
  retireScheduleStateFiles()
  retireAgentSettingsFiles()
  retireAgentStateFiles()
  retireKanbanAuditStateFile()
  retireVaultBindingsFile()
  retireFederationConfigFile()
  retireGroup5StateFiles()

  return dbBackend
}

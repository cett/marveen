import { getAgentSetting, setAgentSetting, listAgentSettingsByKey } from '../db/agent-settings.js'
import {
  normalizeAutoRestartConfig,
  DEFAULT_AUTO_RESTART,
  type AutoRestartConfig,
} from '../auto-restart.js'

// Per-agent auto-restart config, DB-backed (migration 0058, agent_settings
// table, setting_key='auto_restart' -- #985 group 3/8, replaces the former
// store/auto-restart.json single-file map keyed by agent name). A single
// table keeps the main session and sub-agents uniform, same as the file it
// replaces.

/** All configured agents, normalized. Agents with no row are simply absent. */
export function readAllAutoRestartConfigs(): Record<string, AutoRestartConfig> {
  const raw = listAgentSettingsByKey('auto_restart')
  const out: Record<string, AutoRestartConfig> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    out[name] = normalizeAutoRestartConfig(cfg)
  }
  return out
}

/** One agent's config, normalized; the disabled default when unset. */
export function readAutoRestartConfig(name: string): AutoRestartConfig {
  const row = getAgentSetting(name, 'auto_restart')
  if (!row) return { ...DEFAULT_AUTO_RESTART }
  try {
    return normalizeAutoRestartConfig(JSON.parse(row.setting_value))
  } catch {
    return { ...DEFAULT_AUTO_RESTART }
  }
}

/** Persist one agent's config (normalized first so the store stays clean).
 *  `tenantId` stamps ownership for the RBAC own-tenant-vs-cross-tenant check
 *  (agents-process.ts) -- defaults to 'default' for callers with no tenant
 *  context (tests, scripts). */
export function writeAutoRestartConfig(name: string, cfg: unknown, tenantId = 'default'): AutoRestartConfig {
  const normalized = normalizeAutoRestartConfig(cfg)
  setAgentSetting(name, 'auto_restart', normalized, tenantId)
  return normalized
}

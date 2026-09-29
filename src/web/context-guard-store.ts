import { getAgentSetting, setAgentSetting, listAgentSettingsByKey } from '../db/agent-settings.js'
import {
  normalizeContextGuardConfig,
  DEFAULT_CONTEXT_GUARD,
  type ContextGuardConfig,
} from '../context-guard.js'

// Per-agent context-guard config, DB-backed (migration 0058, agent_settings
// table, setting_key='context_guard' -- #985 group 3/8, replaces the former
// store/context-guard.json single-file map keyed by agent name). Like
// auto-restart, the guard is DEFAULT-OFF (opt-in): an agent with no row is
// unprotected until an operator enables it. Default-off keeps the guard from
// double-restarting against the existing context-clean path (#525) until the
// two systems share a trigger.

/** All explicitly-configured agents, normalized. */
export function readAllContextGuardConfigs(): Record<string, ContextGuardConfig> {
  const raw = listAgentSettingsByKey('context_guard')
  const out: Record<string, ContextGuardConfig> = {}
  for (const [name, cfg] of Object.entries(raw)) {
    out[name] = normalizeContextGuardConfig(cfg)
  }
  return out
}

/** One agent's config, normalized; the DISABLED default when unset. */
export function readContextGuardConfig(name: string): ContextGuardConfig {
  const row = getAgentSetting(name, 'context_guard')
  if (!row) return { ...DEFAULT_CONTEXT_GUARD }
  try {
    return normalizeContextGuardConfig(JSON.parse(row.setting_value))
  } catch {
    return { ...DEFAULT_CONTEXT_GUARD }
  }
}

/** Persist one agent's config (normalized first so the store stays clean).
 *  `tenantId` stamps ownership for the RBAC own-tenant-vs-cross-tenant check
 *  (agents-process.ts) -- defaults to 'default' for callers with no tenant
 *  context (tests, scripts). */
export function writeContextGuardConfig(name: string, cfg: unknown, tenantId = 'default'): ContextGuardConfig {
  const normalized = normalizeContextGuardConfig(cfg)
  setAgentSetting(name, 'context_guard', normalized, tenantId)
  return normalized
}

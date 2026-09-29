import { DEFAULT_AGENT_MODEL } from '../config.js'
import { getSystemConfig, setSystemConfig } from '../db/system-config.js'
import {
  normalizeModelFallbackConfig,
  DEFAULT_MODEL_CHAIN,
  type ModelFallbackConfig,
} from '../model-fallback.js'

// Single global config for the model-fallback-on-limit feature (one safety-net
// policy for the whole fleet, unlike per-agent auto-restart). Default disabled,
// so an upgrade is inert until the operator turns it on from the dashboard.
// Migrated off store/model-fallback.json into system_config (#985 group 5/8) --
// see migrateGroup5StateFromFiles() in db/system-config.ts for the one-time
// backfill of an existing install's file into these three keys.
const KEY_ENABLED = 'model_fallback_enabled'
const KEY_CHAIN = 'model_fallback_chain'
const KEY_REVERT_MINUTES = 'model_fallback_revert_after_minutes'

// chain[0] is what the runner reverts UP to, so it has to be the model this
// install actually runs -- not the distribution literal in model-fallback.ts
// (kept zero-import there so the decision logic stays trivially testable).
// Without this, an install on a non-default DEFAULT_AGENT_MODEL would "revert"
// onto a model it never ran. Filtered first so a default that already sits
// further down the ladder cannot end up in the chain twice.
export function defaultChainForInstall(): string[] {
  return [DEFAULT_AGENT_MODEL, ...DEFAULT_MODEL_CHAIN.filter((m) => m !== DEFAULT_AGENT_MODEL)]
}

/** Parses the stored chain row; null when absent, malformed, or too short for
 *  normalize() to actually honour (same >=2-entry bar as the file version). */
function explicitChainFromRow(raw: string | undefined): string[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const cleaned = parsed.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
  return cleaned.length >= 2 ? cleaned : null
}

export function readModelFallbackConfig(): ModelFallbackConfig {
  const explicitChain = explicitChainFromRow(getSystemConfig(KEY_CHAIN)?.value)
  const revertRow = getSystemConfig(KEY_REVERT_MINUTES)?.value
  const cfg = normalizeModelFallbackConfig({
    enabled: getSystemConfig(KEY_ENABLED)?.value === '1',
    chain: explicitChain ?? undefined,
    revertAfterMinutes: revertRow !== undefined ? Number(revertRow) : undefined,
  })
  // normalize() substitutes the module's literal chain whenever the stored one
  // is missing or too short; swap in the install chain for exactly that case,
  // so an operator-configured chain is still never overridden.
  return explicitChain ? cfg : { ...cfg, chain: defaultChainForInstall() }
}

export function writeModelFallbackConfig(cfg: Partial<ModelFallbackConfig>): ModelFallbackConfig {
  const current = readModelFallbackConfig()
  const merged = normalizeModelFallbackConfig({ ...current, ...cfg })
  setSystemConfig(KEY_ENABLED, merged.enabled ? '1' : '0')
  setSystemConfig(KEY_CHAIN, JSON.stringify(merged.chain))
  setSystemConfig(KEY_REVERT_MINUTES, String(merged.revertAfterMinutes))
  return merged
}

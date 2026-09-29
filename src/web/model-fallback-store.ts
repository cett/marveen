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
  // Only persist the fields the caller actually sent (same reasoning as
  // writeModelFallbackFieldsRaw() above). `current` may carry a merely
  // COMPUTED chain (defaultChainForInstall(), substituted by
  // readModelFallbackConfig() because nothing was stored yet) -- a caller
  // that only sent `{ enabled: true }` must not have that computed chain
  // baked into system_config as if the operator had explicitly configured
  // it: it would then stop tracking DEFAULT_AGENT_MODEL if that ever
  // changes, and readModelFallbackConfig()'s explicitChainFromRow() would
  // treat the now-stale baked value as an operator override forever after.
  if (cfg.enabled !== undefined) setSystemConfig(KEY_ENABLED, merged.enabled ? '1' : '0')
  if (cfg.chain !== undefined) setSystemConfig(KEY_CHAIN, JSON.stringify(merged.chain))
  if (cfg.revertAfterMinutes !== undefined) setSystemConfig(KEY_REVERT_MINUTES, String(merged.revertAfterMinutes))
  return merged
}

/** Only the fields an operator actually set, with no code-level default
 *  substituted in -- for fleet-transfer export. Unlike readModelFallbackConfig(),
 *  a field this fleet never explicitly configured is simply absent, not filled
 *  with (e.g.) this install's defaultChainForInstall(). That distinction matters
 *  on import: the chain's primary entry must match the TARGET's actually-running
 *  model, so importing a source's merely-computed default would silently point
 *  the target's fallback chain at a model it may never run (see the
 *  #985 group 5/8 comment on migrateGroup5StateFromFiles() in
 *  db/system-config.ts for the same reasoning applied to the install-time
 *  migration). */
export function readModelFallbackFieldsRaw(): Partial<ModelFallbackConfig> {
  const out: Partial<ModelFallbackConfig> = {}
  const enabledRow = getSystemConfig(KEY_ENABLED)
  if (enabledRow) out.enabled = enabledRow.value === '1'
  const explicitChain = explicitChainFromRow(getSystemConfig(KEY_CHAIN)?.value)
  if (explicitChain) out.chain = explicitChain
  const revertRow = getSystemConfig(KEY_REVERT_MINUTES)
  if (revertRow !== undefined) out.revertAfterMinutes = Number(revertRow.value)
  return out
}

/** Counterpart to readModelFallbackFieldsRaw(): sets exactly the given fields,
 *  one row each, with no merge against the current value and no normalization.
 *  A field left out of `fields` is left untouched -- see the reasoning above for
 *  why fleet-transfer must not blanket-overwrite an unconfigured chain/enabled/
 *  revertAfterMinutes with whatever the source fleet's code-level default was. */
export function writeModelFallbackFieldsRaw(fields: Partial<ModelFallbackConfig>): void {
  if (fields.enabled !== undefined) setSystemConfig(KEY_ENABLED, fields.enabled ? '1' : '0')
  if (fields.chain !== undefined) setSystemConfig(KEY_CHAIN, JSON.stringify(fields.chain))
  if (fields.revertAfterMinutes !== undefined) setSystemConfig(KEY_REVERT_MINUTES, String(fields.revertAfterMinutes))
}

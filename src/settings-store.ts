import { readEnvFile } from './env.js'
import { getSettingDefinition, validateSettingValue, type SettingDefinition } from './config-registry.js'
import { getSystemConfig, setSystemConfig } from './db/system-config.js'

// Read layer for registry-backed settings. Resolution order for any
// registered key is: system_config DB > .env > registry default.

function coerce(def: SettingDefinition, raw: string | number): string | number {
  if (def.type === 'int') return typeof raw === 'number' ? raw : parseInt(raw, 10)
  return String(raw)
}

// getSystemConfig() hits the real DB connection (src/db/connection.ts),
// which is undefined until initDatabase() runs -- true in production well
// before any request reaches here, but not guaranteed in a unit test that
// exercises this module without booting the DB. Tolerate that the same way
// config.ts's readSystemConfigTable() tolerates a missing DB file: fall
// through to the next layer rather than throwing.
function tryGetSystemConfigValue(key: string): string | undefined {
  try {
    return getSystemConfig(key)?.value
  } catch {
    return undefined
  }
}

// Resolves the effective value for a registered key: system_config DB >
// .env > registry default. Reads .env fresh (cheap, scoped to one key)
// rather than relying on the boot-time config.ts constants, so this
// resolution stays correct independent of when the process last restarted.
export function getEffectiveSettingValue(key: string): string | number {
  const def = getSettingDefinition(key)
  if (!def) throw new Error(`Unknown setting key: ${key}`)
  const dbValue = tryGetSystemConfigValue(key)
  if (dbValue !== undefined) return coerce(def, dbValue)
  const envValue = readEnvFile([key])[key]
  if (envValue !== undefined) return coerce(def, envValue)
  return def.default
}

export interface SetOverrideResult {
  ok: boolean
  error?: string
}

// Validates against the registry, then writes to the system_config DB
// (source='db'). Validation happens before the write, so an invalid value
// never reaches the DB.
export function setOverride(key: string, rawValue: unknown): SetOverrideResult {
  const def = getSettingDefinition(key)
  if (!def) return { ok: false, error: `Ismeretlen kulcs: ${key}` }

  const validation = validateSettingValue(def, rawValue)
  if (!validation.ok) return { ok: false, error: validation.error }

  setSystemConfig(key, String(validation.value!), 'db')
  return { ok: true }
}

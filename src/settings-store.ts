import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { readEnvFile } from './env.js'
import { getSettingDefinition, validateSettingValue, type SettingDefinition } from './config-registry.js'
import { getSystemConfig, setSystemConfig } from './db/system-config.js'

// Read layer for registry-backed settings. Resolution order for any
// registered key is: system_config DB > config-overrides.json > .env >
// registry default. config-overrides.json is READ-ONLY here now (legacy
// values from before the DB-only write path below shipped); a directory
// watch keeps the in-memory cache of it in sync if the file is edited by
// hand outside this process. Retained as a fallback until a later step
// retires the file entirely.
export const OVERRIDES_PATH = join(STORE_DIR, 'config-overrides.json')

let cache: Record<string, string | number> = {}
let watcher: FSWatcher | undefined

function loadFromDisk(): Record<string, string | number> {
  try {
    if (!existsSync(OVERRIDES_PATH)) return {}
    const raw = readFileSync(OVERRIDES_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}

cache = loadFromDisk()

// Lazily start the directory watch on first use rather than at import time,
// so importing this module in a test (no STORE_DIR yet) does not throw.
function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    watcher = watch(STORE_DIR, { persistent: false }, (_event, filename) => {
      if (filename === 'config-overrides.json') cache = loadFromDisk()
    })
  } catch {
    // Best-effort: if the platform/FS doesn't support watching the
    // directory, the cache simply stays as of the last read/write from this
    // process -- still correct for the common single-process case.
  }
}

export function getOverrides(): Record<string, string | number> {
  ensureWatching()
  return { ...cache }
}

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
// config-overrides.json > .env > registry default. Reads .env fresh (cheap,
// scoped to one key) rather than relying on the boot-time config.ts
// constants, so this resolution stays correct independent of when the
// process last restarted.
export function getEffectiveSettingValue(key: string): string | number {
  ensureWatching()
  const def = getSettingDefinition(key)
  if (!def) throw new Error(`Unknown setting key: ${key}`)
  const dbValue = tryGetSystemConfigValue(key)
  if (dbValue !== undefined) return coerce(def, dbValue)
  if (key in cache) return coerce(def, cache[key])
  const envValue = readEnvFile([key])[key]
  if (envValue !== undefined) return coerce(def, envValue)
  return def.default
}

export interface SetOverrideResult {
  ok: boolean
  error?: string
}

// Validates against the registry, then writes ONLY to the system_config DB
// (source='db'). config-overrides.json is no longer written by this
// function -- it stays a read-only legacy fallback (see getEffectiveSettingValue)
// until a later step retires it. Validation happens before the write, so an
// invalid value never reaches the DB.
export function setOverride(key: string, rawValue: unknown): SetOverrideResult {
  const def = getSettingDefinition(key)
  if (!def) return { ok: false, error: `Ismeretlen kulcs: ${key}` }

  const validation = validateSettingValue(def, rawValue)
  if (!validation.ok) return { ok: false, error: validation.error }

  setSystemConfig(key, String(validation.value!), 'db')
  return { ok: true }
}

// Test-only escape hatch: forces the in-memory cache back to whatever is
// currently on disk (or empty if absent), bypassing the watch debounce.
export function reloadOverridesForTest(): void {
  cache = loadFromDisk()
}

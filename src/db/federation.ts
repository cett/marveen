// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).
//
// Federation config (#985 group 5/8's deferred part -- see the CHANGELOG
// entry for group 5: "federation stays file-based, deferred to a later
// step"). Unlike vault_bindings (a normalized table, migration 0062), the
// whole store/federation.json blob is kept as ONE raw JSON string under a
// single system_config key: validateFederationConfig() (web/federation/
// config.ts) must still be able to fail-closed on a partially-invalid or
// garbage document while still round-tripping the RAW bytes byte-for-byte
// (the "lossless disable" contract -- an invalid stored peer must not be
// silently dropped from what a flag-flip writes back). A normalized peers
// table cannot hold an invalid row at all, which would break that contract;
// a single opaque blob preserves it exactly, matching the file's own
// semantics with only the storage medium swapped.
//
// SECURITY NOTE: this key's value contains live peer bearer tokens
// (inboundToken/outboundToken) -- the same sensitivity the file had at 0600.
// system_config carries no per-row file permission of its own, but it lives
// inside claudeclaw.db, which is unconditionally 0600 (src/db/connection.ts)
// -- the same protection vault_bindings' migration note relies on.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemConfig, setSystemConfig, setSystemConfigSync, updateSystemConfig, deleteSystemConfig } from './system-config.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const FEDERATION_CONFIG_KEY = 'federation_config_json'

export function getFederationConfigRaw(): string | undefined {
  return getSystemConfig(FEDERATION_CONFIG_KEY)?.value
}

export async function setFederationConfigRaw(json: string, source: string = 'db'): Promise<void> {
  await setSystemConfig(FEDERATION_CONFIG_KEY, json, source)
}

/**
 * Read-modify-write of the raw document that cannot lose an update (see updateSystemConfig): `mutate` gets the
 * stored text read from the database and returns the next text, or `undefined` to leave it as it is.
 */
export function updateFederationConfigRaw(
  mutate: (current: string | undefined) => string | undefined,
  source: string = 'db',
): Promise<boolean> {
  return updateSystemConfig(FEDERATION_CONFIG_KEY, mutate, source)
}

export async function deleteFederationConfigRaw(): Promise<void> {
  await deleteSystemConfig(FEDERATION_CONFIG_KEY)
}

// One-time backfill of an existing install's store/federation.json into
// system_config. Skipped entirely once the key already exists -- whether set
// by an operator (source='db') or a previous run of this same migration --
// same never-overwrite guarantee migrateVaultBindingsFromFile() gives (INSERT
// OR IGNORE there; the equivalent here is the getSystemConfig() guard, since
// setSystemConfig() itself is an unconditional upsert). The raw file text is
// stored AS-IS, even if it turns out to be invalid JSON: the same "keep the
// raw bytes, validate only at read time" contract the file gave
// loadConfigFromDisk() in web/federation/config.ts. Safe to call on every
// boot.
// Boot twin: initDatabase() runs it before anything can await, so it writes through the synchronous twin of
// setFederationConfigRaw. Only db/index.ts calls it (db-boot-sync-twins.test.ts).
// @boot-sync-twin
export function migrateFederationConfigFromFile(): boolean {
  if (getSystemConfig(FEDERATION_CONFIG_KEY) !== undefined) return false
  const filePath = join(STORE_DIR, 'federation.json')
  if (!existsSync(filePath)) return false
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (err) {
    logger.warn({ err, filePath }, 'federation migration: failed to read federation.json, skipping')
    return false
  }
  setSystemConfigSync(FEDERATION_CONFIG_KEY, content, 'migrated_from_json')
  return true
}

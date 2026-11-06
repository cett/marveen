// Boot marker: lets a boot tell whether the previous process stopped cleanly.
//
// Two system_config keys (neither is in SETTINGS_REGISTRY, neither is in the fleet transfer export):
//   last_boot       {boot_id, started_at, prev_shutdown}   written at every real process boot
//   clean_shutdown  {boot_id, at}                          written by the SIGTERM flush `shutdown-marker`
//
// prev_shutdown is decided at boot from the PREVIOUS last_boot and the clean_shutdown marker:
//   no previous last_boot (first boot, or an unreadable value) -> 'unknown'
//   clean_shutdown.boot_id === previous last_boot.boot_id        -> 'clean'
//   anything else                                                -> 'unclean'
// Matching on boot_id (not on "a marker exists") is what stops a stale marker from making a later crash look clean:
// the marker is never deleted, and boot N+1 writes a new boot_id, so boot N+2 only sees `clean` if boot N+1 itself
// wrote its marker on the way down.
//
// What counts as clean: SIGTERM (index.ts runs the registered flushes, this marker first, before the database
// closes). SIGINT (dev only) and SIGKILL / a crash leave no marker and read as `unclean` next time. That is the
// correct reading, not a gap: those cases cannot be told apart from a crash, and index.ts's shutdown() is unchanged.
//
// Called from src/index.ts at the real process boot, NOT from initDatabase(): that also runs from every test
// against the shared store (see retireConfigOverridesFile in index.ts).

import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { getSystemConfig, setSystemConfig, setSystemConfigMany, writeAgentAuditLog } from '../db.js'
import { registerSigtermFlush } from './sigterm-flush.js'

export const LAST_BOOT_KEY = 'last_boot'
export const CLEAN_SHUTDOWN_KEY = 'clean_shutdown'

export type PrevShutdown = 'clean' | 'unclean' | 'unknown'

export interface LastBoot {
  boot_id: string
  started_at: number
  prev_shutdown: PrevShutdown
}

function parseObject(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function bootIdOf(raw: string | undefined): string | null {
  const id = parseObject(raw)?.['boot_id']
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Pure: how the previous process ended, from the stored `last_boot` and `clean_shutdown` values. */
export function decidePrevShutdown(prevLastBootRaw: string | undefined, cleanShutdownRaw: string | undefined): PrevShutdown {
  const prevBootId = bootIdOf(prevLastBootRaw)
  if (prevBootId === null) return 'unknown'
  return bootIdOf(cleanShutdownRaw) === prevBootId ? 'clean' : 'unclean'
}

/** The stored `last_boot`, validated; null when absent or malformed. Read-only (tick-status). */
export function readLastBoot(): LastBoot | null {
  const o = parseObject(getSystemConfig(LAST_BOOT_KEY)?.value)
  if (!o) return null
  const { boot_id: bootId, started_at: startedAt, prev_shutdown: prev } = o
  if (typeof bootId !== 'string' || bootId.length === 0) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  if (prev !== 'clean' && prev !== 'unclean' && prev !== 'unknown') return null
  return { boot_id: bootId, started_at: startedAt, prev_shutdown: prev }
}

/** Record this boot: decide prev_shutdown, write `last_boot`, log and audit it. Resolves to the record written. */
export async function recordBoot(now: number = Date.now()): Promise<LastBoot> {
  const prevShutdown = decidePrevShutdown(getSystemConfig(LAST_BOOT_KEY)?.value, getSystemConfig(CLEAN_SHUTDOWN_KEY)?.value)
  const record: LastBoot = { boot_id: randomUUID(), started_at: now, prev_shutdown: prevShutdown }
  // One write; clean_shutdown stays as it is (the boot_id match, not a delete, is what makes it unambiguous).
  await setSystemConfigMany([[LAST_BOOT_KEY, JSON.stringify(record)]])
  logger.info({ boot_id: record.boot_id, prev_shutdown: record.prev_shutdown }, 'boot recorded')
  try {
    await writeAgentAuditLog({
      agent_id: 'scheduler',
      entity: 'boot',
      action: 'boot',
      entity_id: record.boot_id,
      detail: { boot_id: record.boot_id, prev_shutdown: record.prev_shutdown },
    })
  } catch (err) {
    logger.warn({ err }, 'boot-marker: audit row not written')
  }
  return record
}

/** SIGTERM flush that stamps this boot's clean shutdown. ONE write, and registered before every other flush. */
export function registerShutdownMarker(bootId: string): () => void {
  return registerSigtermFlush('shutdown-marker', () =>
    setSystemConfig(CLEAN_SHUTDOWN_KEY, JSON.stringify({ boot_id: bootId, at: Date.now() })),
  )
}

/**
 * Boot step for src/index.ts: record the boot, then register the marker. Never throws: a boot marker is
 * diagnostics, and a failure here must not stop the process from starting. Without a recorded boot there is no
 * boot_id to stamp, so no marker is registered (the next boot then reads `unknown` or `unclean`, which is honest).
 */
export async function startBootMarker(): Promise<LastBoot | null> {
  try {
    const record = await recordBoot()
    registerShutdownMarker(record.boot_id)
    return record
  } catch (err) {
    logger.warn({ err }, 'boot-marker: could not record this boot')
    return null
  }
}

// Durable mirror of the schedule runner's in-flight map (the post-fire timeout watchdog's evidence).
//
// The runner keeps `taskInflightMap` in memory; a dashboard restart used to drop every entry, so a task that was
// running across the restart never got its "done" blackboard write or its timeout alert. This module mirrors the
// map into ONE system_config key (`scheduled_inflight`) and reads it back at runner start.
//
// Contract:
//  - Memory is primary, the database is a mirror. Every write here swallows its own failure (logger.warn): a
//    persistence error must never break an injection, a sweep or a tick.
//  - The stored value is UNTRUSTED input on the way back in (a hand edit, a stale row from another build): the
//    reader validates strictly and DROPS what does not fit. `session` and `host` end up as tmux / ssh targets, so a
//    restored entry is only accepted when both equal what the runner derives for that agent TODAY; free text never
//    reaches a command.
//  - workingDir / configDir are not stored: they are re-derived on restore, so a config edit after the restart is
//    honoured and the stored evidence cannot point the transcript probe at an arbitrary directory.
//  - The key is deliberately NOT in SETTINGS_REGISTRY (no generic PUT can write it) and is not part of the fleet
//    transfer export (that one copies an explicit key list).

import { logger } from '../logger.js'
import { updateSystemConfig, setSystemConfig, deleteSystemConfig } from '../db.js'

export const SCHEDULED_INFLIGHT_KEY = 'scheduled_inflight'

export interface PersistedBlackboardSnapshot {
  status: string
  summary: string
  task_ref: string | null
}

/** What survives a restart. The runner adds workingDir / configDir back (re-derived) and marks the entry restored. */
export interface PersistedInflight {
  taskName: string
  agentName: string
  session: string
  host: string | null
  injectedAt: number
  alerted: boolean
  sawTurn: boolean
  timeoutMs: number
  blackboardSnapshot: PersistedBlackboardSnapshot | undefined
}

export function inflightKey(taskName: string, agentName: string): string {
  return `${taskName}@${agentName}`
}

/** Pick exactly the persisted fields (never workingDir / configDir / restored). */
export function toPersisted(entry: PersistedInflight): PersistedInflight {
  return {
    taskName: entry.taskName,
    agentName: entry.agentName,
    session: entry.session,
    host: entry.host,
    injectedAt: entry.injectedAt,
    alerted: entry.alerted,
    sawTurn: entry.sawTurn,
    timeoutMs: entry.timeoutMs,
    blackboardSnapshot: entry.blackboardSnapshot,
  }
}

// ---- writes (all best effort) -------------------------------------------------------------------------------------

/** Parse the stored object for a read-modify-write; anything that is not a plain object restarts from empty. */
function parseStoredObject(current: string | undefined): Record<string, unknown> {
  if (current === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(current)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Upsert one entry (an injection on an existing key replaces the older entry, as the in-memory map does). */
export async function persistInflightUpsert(entry: PersistedInflight): Promise<void> {
  const key = inflightKey(entry.taskName, entry.agentName)
  try {
    await updateSystemConfig(SCHEDULED_INFLIGHT_KEY, (current) => {
      const all = parseStoredObject(current)
      all[key] = toPersisted(entry)
      return JSON.stringify(all)
    })
  } catch (err) {
    logger.warn({ err, key }, 'schedule-runner: failed to persist in-flight entry')
  }
}

/** Remove one entry (clear / lost / max-track eviction). A key that is not stored is a no-op (no write). */
export async function persistInflightRemove(key: string): Promise<void> {
  try {
    await updateSystemConfig(SCHEDULED_INFLIGHT_KEY, (current) => {
      const all = parseStoredObject(current)
      if (!(key in all)) return undefined
      delete all[key]
      return JSON.stringify(all)
    })
  } catch (err) {
    logger.warn({ err, key }, 'schedule-runner: failed to remove persisted in-flight entry')
  }
}

/**
 * Mirror the `alerted` / `sawTurn` flags of an entry that is still tracked. A key that is no longer stored is left
 * alone: this must never resurrect an entry a concurrent clear already removed.
 */
export async function persistInflightFlags(key: string, flags: { alerted: boolean; sawTurn: boolean }): Promise<void> {
  try {
    await updateSystemConfig(SCHEDULED_INFLIGHT_KEY, (current) => {
      const all = parseStoredObject(current)
      const stored = all[key]
      if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return undefined
      all[key] = { ...(stored as Record<string, unknown>), alerted: flags.alerted, sawTurn: flags.sawTurn }
      return JSON.stringify(all)
    })
  } catch (err) {
    logger.warn({ err, key }, 'schedule-runner: failed to persist in-flight flags')
  }
}

// ---- read-back (strict validation) --------------------------------------------------------------------------------

export interface InflightRestoreEnv {
  now: number
  /** TASK_FIRE_MAX_TRACK_MS: an entry older than this is evicted by the watchdog anyway, so it is not restored. */
  maxTrackMs: number
  /** Syntactically safe AND an agent this install knows (the main agent counts). */
  isKnownAgent: (agentName: string) => boolean
  /** The tmux session the runner would target for this agent today (resolveTaskTarget without a targetSession). */
  sessionFor: (agentName: string) => string
  /** The remote host the runner would target for this agent today, or null for a local one. */
  hostFor: (agentName: string) => string | null
}

export interface InflightRestoreResult {
  entries: Map<string, PersistedInflight>
  dropped: Array<{ key: string; reason: string }>
  /** True when the stored value was not a JSON object at all. */
  corrupt: boolean
}

const MAX_NAME_LEN = 200
const MAX_TEXT_LEN = 2000
const MIN_TIMEOUT_MS = 60_000
// Clock-skew allowance for an injectedAt a little in the future (same tolerance as computeTickStatus).
const FUTURE_SKEW_MS = 60_000

function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function cleanName(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME_LEN && !hasControlChar(v) ? v : null
}

function parseSnapshot(v: unknown): { ok: true; value: PersistedBlackboardSnapshot | undefined } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: undefined }
  if (!isPlainObject(v)) return { ok: false }
  const { status, summary, task_ref: taskRef } = v
  if (typeof status !== 'string' || status.length === 0 || status.length > 64) return { ok: false }
  if (typeof summary !== 'string' || summary.length > MAX_TEXT_LEN) return { ok: false }
  if (taskRef !== null && (typeof taskRef !== 'string' || taskRef.length > MAX_NAME_LEN)) return { ok: false }
  return { ok: true, value: { status, summary, task_ref: taskRef } }
}

/** Why one stored entry does not fit, or the entry itself. Pure. */
function validateEntry(key: string, raw: unknown, env: InflightRestoreEnv): { ok: true; entry: PersistedInflight } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not-an-object' }
  const taskName = cleanName(raw['taskName'])
  const agentName = cleanName(raw['agentName'])
  if (!taskName || !agentName) return { ok: false, reason: 'bad-name' }
  if (key !== inflightKey(taskName, agentName)) return { ok: false, reason: 'key-mismatch' }
  if (!env.isKnownAgent(agentName)) return { ok: false, reason: 'unknown-agent' }
  // session and host are command targets: accept only exactly what the runner derives for this agent today.
  if (raw['session'] !== env.sessionFor(agentName)) return { ok: false, reason: 'bad-session' }
  if (raw['host'] !== env.hostFor(agentName)) return { ok: false, reason: 'bad-host' }
  const injectedAt = raw['injectedAt']
  if (typeof injectedAt !== 'number' || !Number.isFinite(injectedAt)) return { ok: false, reason: 'bad-injected-at' }
  if (injectedAt > env.now + FUTURE_SKEW_MS) return { ok: false, reason: 'injected-in-future' }
  if (injectedAt <= env.now - env.maxTrackMs) return { ok: false, reason: 'older-than-max-track' }
  const alerted = raw['alerted']
  const sawTurn = raw['sawTurn']
  if (typeof alerted !== 'boolean' || typeof sawTurn !== 'boolean') return { ok: false, reason: 'bad-flags' }
  const timeoutMs = raw['timeoutMs']
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > env.maxTrackMs) {
    return { ok: false, reason: 'bad-timeout' }
  }
  const snapshot = parseSnapshot(raw['blackboardSnapshot'])
  if (!snapshot.ok) return { ok: false, reason: 'bad-snapshot' }
  return {
    ok: true,
    entry: {
      taskName,
      agentName,
      session: raw['session'] as string,
      host: raw['host'] as string | null,
      injectedAt,
      alerted,
      sawTurn,
      timeoutMs,
      blackboardSnapshot: snapshot.value,
    },
  }
}

/**
 * Parse and validate the stored value. Never throws: invalid JSON gives `corrupt: true` and no entries; an entry
 * that does not fit is listed in `dropped` and the rest still load.
 */
export function parseStoredInflight(raw: string | undefined, env: InflightRestoreEnv): InflightRestoreResult {
  const result: InflightRestoreResult = { entries: new Map(), dropped: [], corrupt: false }
  if (raw === undefined) return result
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    result.corrupt = true
    return result
  }
  if (!isPlainObject(parsed)) {
    result.corrupt = true
    return result
  }
  for (const [key, value] of Object.entries(parsed)) {
    const checked = validateEntry(key, value, env)
    if (checked.ok) result.entries.set(key, checked.entry)
    else result.dropped.push({ key, reason: checked.reason })
  }
  return result
}

/** Drop a corrupt value outright, or rewrite the stored object without the entries that were dropped. Best effort. */
export async function persistInflightCleanup(result: InflightRestoreResult): Promise<void> {
  try {
    if (result.corrupt) {
      await deleteSystemConfig(SCHEDULED_INFLIGHT_KEY)
    } else if (result.dropped.length > 0) {
      await setSystemConfig(SCHEDULED_INFLIGHT_KEY, JSON.stringify(Object.fromEntries([...result.entries].map(([k, v]) => [k, toPersisted(v)]))))
    }
  } catch (err) {
    logger.warn({ err }, 'schedule-runner: failed to clean up the persisted in-flight value')
  }
}

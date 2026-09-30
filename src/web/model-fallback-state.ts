import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { isValidModelId, InvalidModelIdError } from '../model-id.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Persistent "currently downgraded" state for the model-fallback runner.
//
// The runner used to rewrite the operator's own model config (.env
// MAIN_AGENT_MODEL / agent-config.json model) to downgrade an agent, and kept
// "when did I downgrade" only in memory. Result: a downgrade destroyed the
// operator's choice, and a dashboard restart lost the revert timer, so the agent
// stayed on the fallback model forever. The downgrade now lives HERE instead, as
// an overlay the model resolvers consult first while it is active; the
// operator's config is never touched and `primary` remembers what to revert to.
//
// A plain JSON file (not system_config) on purpose: scripts/channels.sh has to
// read it before any node process exists, and it does so with jq -- the same
// way it already reads .claude/settings.json.
//
//   store/model-fallback-state.json
//   { "<agent-id>": { "primary": "<model>", "current": "<model>", "downgradedAt": <ms> } }

export interface FallbackOverride {
  /** The model the agent ran on before the downgrade -- what a revert goes back to. */
  primary: string
  /** The fallback model the agent is currently pinned to. */
  current: string
  /** When the downgrade happened (ms epoch); also the cooldown / revert anchor. */
  downgradedAt: number
}

export const MODEL_FALLBACK_STATE_FILE = 'model-fallback-state.json'

function statePath(): string {
  return join(STORE_DIR, MODEL_FALLBACK_STATE_FILE)
}

function parseEntry(raw: unknown): FallbackOverride | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isValidModelId(o.primary) || !isValidModelId(o.current)) return null
  if (typeof o.downgradedAt !== 'number' || !Number.isFinite(o.downgradedAt)) return null
  return { primary: o.primary, current: o.current, downgradedAt: o.downgradedAt }
}

// Tolerant read: a missing, unreadable or corrupt file means "nothing is
// downgraded", so the resolvers fall through to the operator's own config
// instead of throwing on the agent-launch path. Individual malformed entries
// are dropped for the same reason.
function readAll(): Record<string, FallbackOverride> {
  const out: Record<string, FallbackOverride> = {}
  try {
    const p = statePath()
    if (!existsSync(p)) return out
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = parseEntry(raw)
      if (entry) out[name] = entry
    }
  } catch { /* fall through: no override */ }
  return out
}

function writeAll(state: Record<string, FallbackOverride>): void {
  atomicWriteFileSync(statePath(), JSON.stringify(state, null, 2))
}

export function getFallbackOverride(name: string): FallbackOverride | null {
  return readAll()[name] ?? null
}

export function setFallbackOverride(name: string, entry: FallbackOverride): void {
  if (!isValidModelId(entry.primary)) throw new InvalidModelIdError(entry.primary)
  if (!isValidModelId(entry.current)) throw new InvalidModelIdError(entry.current)
  const state = readAll()
  state[name] = { primary: entry.primary, current: entry.current, downgradedAt: entry.downgradedAt }
  writeAll(state)
}

/** Drops the agent's override. No-op (and no write) when there is none. */
export function clearFallbackOverride(name: string): void {
  const state = readAll()
  if (!(name in state)) return
  delete state[name]
  writeAll(state)
}

export function listFallbackOverrides(): Record<string, FallbackOverride> {
  return readAll()
}

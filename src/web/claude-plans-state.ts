// store/claude-plans-state.json, the machine-managed rotation side-car
// described in
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md section 5.2.
//
// PR2b shipped ONLY the reader (behind GET /api/claude-plans/state, for the
// dashboard's plan cards), with a deliberately lenient schema because open
// question #1 (decided 2026-09-12: sub-agents rotate too) had not yet been
// reflected. PR2c finalizes the schema per that decision: `activePlanId` is
// now `activePlanByAgent`, keyed by agent id (MAIN_AGENT_ID for the main
// channels agent, or a sub-agent's name), because rotation runs per agent,
// not once for the fleet. `plans` stays a flat map keyed by plan id -- a
// plan's own usage does not depend on which agent currently points at it.
//
// PR2c also ships the writer: recordObservation() and applyRotation() are
// pure state-transition functions (no fs), unit-tested in isolation, and
// writeClaudePlansState() is the one atomic-write call site. The heartbeat
// entry point (scripts/claude-plan-rotate-check.ts) is the only production
// caller of the writer.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const CLAUDE_PLANS_STATE_PATH = join(STORE_DIR, 'claude-plans-state.json')

export interface ObservedPlanWindow {
  usedPercent: number
  /** Unix epoch seconds. */
  resetsAt: number
}

export interface ObservedPlanState {
  /** Unix epoch ms. */
  observedAt: number
  source: string
  windows: Record<string, ObservedPlanWindow>
}

/** Why a rotation was decided. 'hard-bypass' is the one immediate re-rotation
 *  the cooldown allows when the NEW active plan is already spent. */
export type RotationTrigger = 'soft' | 'hard' | 'hard-bypass'

/** What became of a decision. Only mode 'act' + 'rotated' counts toward the
 *  cooldown and the breaker; mode 'act' + 'failed' toward the restart backoff. */
export type RotationOutcome = 'rotated' | 'would-rotate' | 'failed' | 'refused' | 'stale-decision'

export interface RotationLogEntry {
  /** Unix epoch ms. */
  ts: number
  agentId: string
  from: string | null
  to: string
  trigger: RotationTrigger
  window?: string
  usedPercent?: number
  mode: 'observe' | 'act'
  result: RotationOutcome
}

/** Last verdict the monitor reached for one plan (dashboard telemetry). */
export interface PlanHealthRecord {
  /** Unix epoch ms. */
  observedAt: number
  status: 'ok' | 'pressure' | 'exhausted' | 'unknown'
  window?: string
  usedPercent?: number
}

/** Everything the backend rotation monitor persists. Optional as a whole and
 *  field by field: a state file written before the monitor existed reads back
 *  without it, and a damaged field is dropped without losing the rest. */
export interface RotationMonitorState {
  /** Unix epoch ms of the last completed tick. */
  lastTickAt?: number
  health?: Record<string, PlanHealthRecord>
  /** Newest last; capped at ROTATION_LOG_MAX. */
  rotationLog?: RotationLogEntry[]
  /** Consecutive ticks on which the active plan could not be measured. */
  consecutiveUnknown?: number
  /** Set when the breaker tripped (too many rotations in a window); the
   *  monitor acts as observe until a person writes the mode setting again. */
  breaker?: { tripped: boolean; since: number }
}

export const ROTATION_LOG_MAX = 50

export interface ClaudePlansState {
  /** Which plan id each agent is currently on. A missing key means that agent
   *  has never been rotated (not on the isolated-config path yet, or
   *  rotation has not run for it). */
  activePlanByAgent: Record<string, string>
  plans: Record<string, ObservedPlanState>
  /** Absent on a file written before the backend monitor. */
  monitor?: RotationMonitorState
}

const EMPTY_STATE: ClaudePlansState = { activePlanByAgent: {}, plans: {} }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

const HEALTH_STATUSES: readonly string[] = ['ok', 'pressure', 'exhausted', 'unknown']
const TRIGGERS: readonly string[] = ['soft', 'hard', 'hard-bypass']
const OUTCOMES: readonly string[] = ['rotated', 'would-rotate', 'failed', 'refused', 'stale-decision']

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseLogEntry(v: unknown): RotationLogEntry | null {
  if (!isPlainObject(v)) return null
  if (!isFiniteNumber(v.ts)) return null
  if (typeof v.agentId !== 'string' || typeof v.to !== 'string') return null
  if (v.from !== null && typeof v.from !== 'string') return null
  if (typeof v.trigger !== 'string' || !TRIGGERS.includes(v.trigger)) return null
  if (typeof v.result !== 'string' || !OUTCOMES.includes(v.result)) return null
  if (v.mode !== 'observe' && v.mode !== 'act') return null
  return {
    ts: v.ts,
    agentId: v.agentId,
    from: v.from,
    to: v.to,
    trigger: v.trigger as RotationTrigger,
    ...(typeof v.window === 'string' ? { window: v.window } : {}),
    ...(isFiniteNumber(v.usedPercent) ? { usedPercent: v.usedPercent } : {}),
    mode: v.mode,
    result: v.result as RotationOutcome,
  }
}

function parseHealthRecord(v: unknown): PlanHealthRecord | null {
  if (!isPlainObject(v)) return null
  if (!isFiniteNumber(v.observedAt)) return null
  if (typeof v.status !== 'string' || !HEALTH_STATUSES.includes(v.status)) return null
  return {
    observedAt: v.observedAt,
    status: v.status as PlanHealthRecord['status'],
    ...(typeof v.window === 'string' ? { window: v.window } : {}),
    ...(isFiniteNumber(v.usedPercent) ? { usedPercent: v.usedPercent } : {}),
  }
}

// Field by field: one damaged field must not cost the rest (the log is the
// restart-safe memory of the cooldown/breaker/backoff, the breaker flag is a
// safety state). Nothing is invented: a field that is absent or invalid stays
// absent, so an old file reads back exactly as before.
function parseMonitorState(raw: unknown): RotationMonitorState | undefined {
  if (!isPlainObject(raw)) return undefined
  const out: RotationMonitorState = {}
  if (isFiniteNumber(raw.lastTickAt)) out.lastTickAt = raw.lastTickAt
  if (isFiniteNumber(raw.consecutiveUnknown) && raw.consecutiveUnknown >= 0) {
    out.consecutiveUnknown = Math.floor(raw.consecutiveUnknown)
  }
  if (isPlainObject(raw.health)) {
    const health: Record<string, PlanHealthRecord> = {}
    for (const [planId, rec] of Object.entries(raw.health)) {
      const parsed = parseHealthRecord(rec)
      if (parsed) health[planId] = parsed
    }
    out.health = health
  }
  if (Array.isArray(raw.rotationLog)) {
    const entries = raw.rotationLog.map(parseLogEntry).filter((e): e is RotationLogEntry => e !== null)
    out.rotationLog = entries.slice(-ROTATION_LOG_MAX)
  }
  if (isPlainObject(raw.breaker) && typeof raw.breaker.tripped === 'boolean' && isFiniteNumber(raw.breaker.since)) {
    out.breaker = { tripped: raw.breaker.tripped, since: raw.breaker.since }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function readClaudePlansState(): ClaudePlansState {
  if (!existsSync(CLAUDE_PLANS_STATE_PATH)) return EMPTY_STATE
  try {
    const raw: unknown = JSON.parse(readFileSync(CLAUDE_PLANS_STATE_PATH, 'utf8'))
    if (!isPlainObject(raw)) return EMPTY_STATE
    const activePlanByAgent = isStringRecord(raw.activePlanByAgent) ? raw.activePlanByAgent : {}
    const plans = isPlainObject(raw.plans) ? (raw.plans as unknown as ClaudePlansState['plans']) : {}
    const monitor = parseMonitorState(raw.monitor)
    return monitor ? { activePlanByAgent, plans, monitor } : { activePlanByAgent, plans }
  } catch {
    return EMPTY_STATE
  }
}

// Atomic overwrite of the whole side-car. Callers read-modify-write via
// recordObservation()/applyRotation() below, then call this once -- mirrors
// writeClaudePlans()'s single-writer-per-call shape in claude-plans.ts.
export function writeClaudePlansState(state: ClaudePlansState): void {
  mkdirSync(dirname(CLAUDE_PLANS_STATE_PATH), { recursive: true })
  atomicWriteFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

// Pure state transition: record a freshly observed quota snapshot for
// `planId` (the plan `agentId` is CURRENTLY on) and make sure `agentId` is
// marked as being on that plan. Called every heartbeat tick regardless of
// whether a rotation decision follows, so the dashboard's "last known %"
// badge stays current even when nothing rotates.
export function recordObservation(
  state: ClaudePlansState,
  agentId: string,
  planId: string,
  observed: ObservedPlanState,
): ClaudePlansState {
  // `...state` carries the monitor block through: this transition is also the
  // legacy heartbeat's, and it must not wipe what the backend monitor keeps.
  return {
    ...state,
    activePlanByAgent: { ...state.activePlanByAgent, [agentId]: planId },
    plans: { ...state.plans, [planId]: observed },
  }
}

/** Pure: merge a patch into the monitor block (absent keys of the patch keep
 *  their value), cap the log, leave everything else of the state alone. */
export function patchMonitorState(
  state: ClaudePlansState,
  patch: Partial<RotationMonitorState>,
): ClaudePlansState {
  const merged: RotationMonitorState = { ...state.monitor, ...patch }
  if (merged.rotationLog) merged.rotationLog = merged.rotationLog.slice(-ROTATION_LOG_MAX)
  return { ...state, monitor: merged }
}

/** Pure: append one entry to the rotation log (newest last, capped). */
export function appendRotationLog(state: ClaudePlansState, entry: RotationLogEntry): ClaudePlansState {
  return patchMonitorState(state, { rotationLog: [...(state.monitor?.rotationLog ?? []), entry] })
}

// Pure state transition: point `agentId` at `targetPlanId`. Used both by an
// actual rotation and by the one-time bootstrap assignment (design 6.5/4's
// open bootstrap question, resolved in the PR2c description: the very first
// assignment for an agent is just a rotation with no prior active plan --
// there is no separate bootstrap code path).
export function applyRotation(
  state: ClaudePlansState,
  agentId: string,
  targetPlanId: string,
): ClaudePlansState {
  return { ...state, activePlanByAgent: { ...state.activePlanByAgent, [agentId]: targetPlanId } }
}

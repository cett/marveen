// Backend plan-rotation monitor (c3b-3): a 60 s tick inside the dashboard process that measures the main
// agent's Claude plan from the statusLine rate-limit snapshots and, when the mode allows, moves the agent
// onto another plan. It replaces the heartbeat that ran inside the main agent's own session: that one died
// with the very session it was supposed to rescue (a spent plan freezes the session, the heartbeat never
// fires, the plan stays spent). This one needs no agent session, no HTTP hop and no token.
//
// Everything the tick touches comes in through MonitorDeps, so the tests drive it with a fake clock, fake
// snapshots and a fake apply, and prove the independence from any agent session by never providing one.
//
// What a tick does (the pure parts live in claude-plan-health.ts, claude-plan-rotation.ts and
// claude-plan-rotation-guard.ts):
//   mode off      -> nothing at all (not even a measurement)
//   no active plan / fewer than 2 plans -> a tick stamp only
//   otherwise     -> classify the active plan, record health, decide, and for a rotate decision ask the guard
//   mode observe  -> a 'would-rotate' log line (once per change), the fleet is untouched
//   mode act      -> Telegram BEFORE, a re-check, performRotation, Telegram AFTER; a failed restart restores the
//                    pointer and lands in the log, where the guard's backoff reads it
//
// The log is the restart-safe memory of the guard, and it holds only 50 entries: a line per tick would push
// the entries the cooldown and the breaker need out of it, so repeated identical outcomes are written once.

import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { deliverToChannel } from '../notify.js'
import { systemJob } from '../db/background-jobs.js'
import { readClaudePlans, type ClaudePlan } from './claude-plans.js'
import { capturePane } from './agent-process-session.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import {
  readClaudePlansState,
  writeClaudePlansState,
  patchMonitorState,
  appendRotationLog,
  applyRotation,
  type ClaudePlansState,
  type RotationLogEntry,
  type RotationOutcome,
  type RotationTrigger,
} from './claude-plans-state.js'
import { readPlanSnapshot, type PlanSnapshotRead } from './plan-usage-source.js'
import { readRotationMode, parseRotationModeStrict, type RotationMode, type RotationModeReading } from './plan-rotation-mode.js'
import { performRotation, isRotationEnabled, type RotationApplyResult } from './plan-rotation-apply.js'
import {
  classifyPlanHealth,
  FRESH_SNAPSHOT_MAX_AGE_SEC,
  type PlanHealth,
  type PlanSnapshot,
} from '../claude-plan-health.js'
import {
  decidePlanRotation,
  estimateCandidateHealth,
  pickEligibleTarget,
  type ObservedWindow,
  type PlanCandidateHealth,
} from '../claude-plan-rotation.js'
import { evaluateRotationGuard, nextSoftStreak } from '../claude-plan-rotation-guard.js'
import { evaluateS4, type S4Result } from '../claude-plan-s4-signal.js'

export const MONITOR_TICK_MS = 60_000
/** A Telegram notice that takes longer than this is given up on: it must never hold up a rotation. */
export const NOTIFY_TIMEOUT_MS = 5_000
/** After a switch the new plan's snapshot file must show a write newer than the switch within this time. */
export const FRESH_AFTER_SWITCH_MS = 10 * 60_000
/** Consecutive ticks on which the active plan cannot be measured before the owner is told (60 min at 60 s). */
export const UNKNOWN_ALERT_TICKS = 60

/** A window with no known reset is blocked "forever": the frozen estimate then never expires. */
const FAR_FUTURE_S = Number.MAX_SAFE_INTEGER / 1000

export interface MonitorDeps {
  now(): number
  mainAgentId: string
  readMode(): Promise<RotationModeReading>
  /** CLAUDE_ROTATION_ENABLED, the older on/off switch of the apply path. */
  isEnabled(): boolean
  readPlans(): ClaudePlan[]
  readSnapshot(plan: ClaudePlan, nowSec: number): PlanSnapshotRead
  readState(): ClaudePlansState
  writeState(state: ClaudePlansState): void
  apply(input: { agentId: string; targetPlanId: string }): Promise<RotationApplyResult>
  /** Best effort, resolves to whether the owner got it; the monitor adds the timeout. */
  notify(text: string): Promise<boolean>
  /** The main session's pane text (S4, observe mode only); null when there is no session. Optional. */
  capturePane?(): string | null
}

export type TickOutcome =
  | 'skipped'
  | 'off'
  | 'inactive'
  | 'no-pressure'
  | 'unknown'
  | 'near-reset'
  | 'no-alternative'
  | 'wait-debounce'
  | 'wait-cooldown'
  | 'wait-backoff'
  | 'breaker-trip'
  | 'breaker-open'
  | 'gave-up'
  | 'blocked-no-fresh'
  | 'would-rotate'
  | 'rotated'
  | 'failed'
  | 'refused'
  | 'stale-decision'

// The dashboard view (GET /api/claude-plans/state -> monitor.live). Every field is listed on purpose: this is a
// whitelist, see live() below. There is no config dir, hash, token, key path or pane text in any of these types.
export interface MonitorLiveWindows {
  five_hour?: { usedPercent: number; resetsAt: number | null }
  seven_day?: { usedPercent: number; resetsAt: number | null }
}

export interface MonitorLiveCore {
  lastTick: { at: number; outcome: TickOutcome } | null
  activePlan: { id: string; label: string; measuredAt: number } | null
  health: { status: PlanHealth['status']; reason: string; sticky: boolean; windows: MonitorLiveWindows } | null
  candidates: Array<{ id: string; label: string; freeFivePct: number; freeSevenDayPct: number; exhausted: boolean }>
  unknownTicks: number
  pendingFresh: { planId: string; since: number; blocked: boolean } | null
  s4: { at: number; pattern: string; line: number; corroborated: boolean } | null
}

export interface TickResult {
  outcome: TickOutcome
  detail?: string
}

function observedOf(snapshot: PlanSnapshot): { five_hour?: ObservedWindow; seven_day?: ObservedWindow } | null {
  if (snapshot.kind !== 'snapshot') return null
  const out: { five_hour?: ObservedWindow; seven_day?: ObservedWindow } = {}
  for (const key of ['five_hour', 'seven_day'] as const) {
    const w = snapshot.windows[key]
    if (w) out[key] = { usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? FAR_FUTURE_S }
  }
  return out
}

/** Telegram text, plain and short. No secrets: plan ids and a reason code only. */
const text = {
  before: (from: string | null, to: string, reason: string) =>
    `🔄 Plan-rotáció: ${from ?? '?'} -> ${to} (${reason}). A fő agent újraindul.`,
  after: (to: string) => `✅ Plan-rotáció kész: a fő agent mostantól a(z) ${to} planon fut.`,
  failed: (from: string | null, hint: string) =>
    `⚠️ Plan-rotáció sikertelen (${hint}). Visszaállítva: ${from ?? 'nincs előző plan'}.`,
  cancelled: (to: string) => `ℹ️ Plan-rotáció lemondva (${to}): a feltételek közben megváltoztak.`,
  breaker: () =>
    '⛔ Plan-rotáció megszakító: túl sok váltás rövid időn belül, a monitor mostantól nem vált. Újraindításhoz írd át a CLAUDE_ROTATION_MODE értékét a dashboardon.',
  gaveUp: () =>
    '⛔ Plan-rotáció feladva: ismétlődő sikertelen újraindítás. A hibák 6 óra múlva nem számítanak, vagy írd át a módot a dashboardon.',
  noAlternative: (reason: string) => `⚠️ Plan-rotáció: nincs alkalmas másik plan (${reason}).`,
  noFresh: (to: string) =>
    `⚠️ Plan-rotáció: a váltás után 10 percen belül nincs friss mérés az új (${to}) planon, további automata váltás letiltva, amíg nem jön.`,
  unknown: (reason: string) => `⚠️ Plan-rotáció: az aktív plan régóta nem mérhető (${reason}).`,
}

export function createPlanRotationMonitor(deps: MonitorDeps) {
  // In-memory only. Losing it on a restart is the conservative direction: one more debounce tick, one repeated
  // owner notice at worst. What must survive a restart (cooldown, breaker, backoff) is derived from the log.
  let running = false
  let softStreak = 0
  /** Last "logged outcome" key, so an unchanged repeating outcome is written once. */
  let lastLogKey: string | null = null
  /** Statuses the owner was already told about, cleared when the status goes away. */
  const told = new Set<string>()
  /** After a switch: the plan that must show a snapshot written after `since`. */
  let pendingFresh: { planId: string; since: number } | null = null
  let blockedUntilFresh = false
  /** S4 (observe): the last pane hit as class + position (never pane text), and the key of the episode already logged. */
  let lastS4: { at: number; planId: string; pattern: string; line: number; corroborated: boolean } | null = null
  let lastS4Key: string | null = null
  /** For the dashboard view (live()): what the last tick measured and decided. In memory only. */
  let lastTick: { at: number; outcome: TickOutcome } | null = null
  let lastMeasure: { planId: string; at: number; health: PlanHealth } | null = null
  let lastCandidates: PlanCandidateHealth[] = []

  const mutate = (fn: (s: ClaudePlansState) => ClaudePlansState): void => {
    deps.writeState(fn(deps.readState()))
  }

  async function notify(message: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), NOTIFY_TIMEOUT_MS)
      })
      return await Promise.race([deps.notify(message), timeout])
    } catch (err) {
      logger.warn({ err }, 'Plan-rotation notice failed')
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Tell the owner once per episode of `key`; `active=false` re-arms it. */
  async function tellOnce(key: string, active: boolean, message: () => string): Promise<void> {
    if (!active) {
      told.delete(key)
      return
    }
    if (told.has(key)) return
    told.add(key)
    await notify(message())
  }

  function logEntry(entry: RotationLogEntry, dedupe: boolean): void {
    const key = `${entry.result}:${entry.mode}:${entry.from}->${entry.to}:${entry.trigger}`
    if (dedupe && key === lastLogKey) return
    lastLogKey = key
    mutate((s) => appendRotationLog(s, entry))
  }

  function candidatesFor(plans: ClaudePlan[], activeId: string, state: ClaudePlansState, nowMs: number): PlanCandidateHealth[] {
    const nowSec = Math.floor(nowMs / 1000)
    return plans
      .filter((p) => p.id !== activeId && p.channelsAllowed)
      .map((p) => {
        const own = observedOf(deps.readSnapshot(p, nowSec).snapshot)
        const legacy = state.plans[p.id]?.windows
        // Own snapshot file first, then the legacy frozen record, else nothing is known (fail open, as the
        // legacy estimate does: unknown must not strand the fleet; the guard and the re-check still apply).
        const observed = own ?? {
          ...(legacy?.['five_hour'] ? { five_hour: legacy['five_hour'] } : {}),
          ...(legacy?.['seven_day'] ? { seven_day: legacy['seven_day'] } : {}),
        }
        return estimateCandidateHealth(p.id, observed, nowMs)
      })
  }

  /** S4, observe only. Never throws, never changes a decision, never writes the rotation log (the guard reads it). */
  function observeS4(capture: () => string | null, planId: string, health: PlanHealth, nowMs: number): void {
    let result: S4Result
    try {
      result = evaluateS4(capture(), health)
    } catch (err) {
      // A tmux hiccup must not cost a tick.
      logger.warn({ err }, 'Plan-rotation S4 pane capture failed')
      return
    }
    if (!result.hit) {
      lastS4Key = null
      return
    }
    lastS4 = { at: nowMs, planId, pattern: result.pattern, line: result.line, corroborated: result.corroborated }
    // One entry per episode: there is no pane text to tell two hits apart, and the position moves as the screen
    // scrolls. A hit that goes away and comes back, or whose corroboration flips, is a new episode.
    const key = `${result.pattern}:${result.corroborated}`
    if (key === lastS4Key) return
    lastS4Key = key
    // The pane holds user messages: only the class and the position of the line are logged, never its text.
    logger.warn(
      { planId, pattern: result.pattern, line: result.line, corroborated: result.corroborated, health: health.reason },
      'Plan-rotation S4 (observe): quota error on the main session pane',
    )
  }

  async function checkFreshAfterSwitch(plans: ClaudePlan[], activeId: string, nowMs: number): Promise<boolean> {
    if (!pendingFresh) return false
    // A manual rotation or a restore moved the pointer meanwhile: nothing left to verify.
    if (activeId !== pendingFresh.planId) {
      pendingFresh = null
      blockedUntilFresh = false
      await tellOnce('no-fresh', false, () => '')
      return false
    }
    const plan = plans.find((p) => p.id === pendingFresh!.planId)
    const read = plan ? deps.readSnapshot(plan, Math.floor(nowMs / 1000)) : null
    const fresh =
      read !== null &&
      read.snapshot.kind === 'snapshot' &&
      read.writtenAt !== null &&
      read.writtenAt * 1000 >= pendingFresh.since &&
      read.snapshot.ageSec <= FRESH_SNAPSHOT_MAX_AGE_SEC
    if (fresh) {
      pendingFresh = null
      blockedUntilFresh = false
      await tellOnce('no-fresh', false, () => '')
      return false
    }
    if (nowMs - pendingFresh.since > FRESH_AFTER_SWITCH_MS) {
      blockedUntilFresh = true
      await tellOnce('no-fresh', true, () => text.noFresh(pendingFresh!.planId))
    }
    return blockedUntilFresh
  }

  async function tick(): Promise<TickResult> {
    if (running) return { outcome: 'skipped' }
    running = true
    try {
      const result = await tickInner()
      lastTick = { at: deps.now(), outcome: result.outcome }
      return result
    } finally {
      running = false
    }
  }

  async function tickInner(): Promise<TickResult> {
    const nowMs = deps.now()
    const nowSec = Math.floor(nowMs / 1000)
    const mode = (await deps.readMode()).mode
    // off: the monitor does not even measure.
    if (mode === 'off') return { outcome: 'off' }

    const mainId = deps.mainAgentId
    const plans = deps.readPlans()
    const state = deps.readState()
    const activeId = state.activePlanByAgent[mainId]
    const activePlan = activeId ? plans.find((p) => p.id === activeId) : undefined
    if (!activeId || !activePlan || plans.length < 2) {
      mutate((s) => patchMonitorState(s, { lastTickAt: nowMs }))
      softStreak = 0
      return { outcome: 'inactive' }
    }

    // --- measure -----------------------------------------------------------------------------------------
    const activeRead = deps.readSnapshot(activePlan, nowSec)
    const health: PlanHealth = classifyPlanHealth(activeRead.snapshot, nowMs)
    lastMeasure = { planId: activeId, at: nowMs, health }
    const unknownTicks = health.status === 'unknown' ? (state.monitor?.consecutiveUnknown ?? 0) + 1 : 0
    mutate((s) =>
      patchMonitorState(s, {
        lastTickAt: nowMs,
        consecutiveUnknown: unknownTicks,
        health: {
          ...s.monitor?.health,
          [activeId]: {
            observedAt: nowMs,
            status: health.status,
            ...(health.window ? { window: health.window } : {}),
            ...(health.usedPercent !== undefined ? { usedPercent: health.usedPercent } : {}),
          },
        },
      }),
    )
    await tellOnce('unknown', unknownTicks >= UNKNOWN_ALERT_TICKS, () => text.unknown(health.reason))

    // S4, observe only: log a quota error on the pane next to what the snapshot says. It never changes the
    // decision below; the raw hits are for calibrating the rule before it is allowed to act.
    if (mode === 'observe' && deps.capturePane) observeS4(deps.capturePane, activeId, health, nowMs)

    const noFreshBlock = await checkFreshAfterSwitch(plans, activeId, nowMs)

    // --- decide ------------------------------------------------------------------------------------------
    const candidates = candidatesFor(plans, activeId, state, nowMs)
    lastCandidates = candidates
    const decision = decidePlanRotation({ activePlanId: activeId, active: health, candidates, nowMs })
    softStreak = nextSoftStreak(softStreak, decision.action === 'rotate' && decision.urgency === 'soft')

    await tellOnce('no-alternative', decision.action === 'no-alternative', () => text.noAlternative(decision.reason))
    if (decision.action !== 'rotate') {
      lastLogKey = null
      return { outcome: decision.action, detail: decision.reason }
    }

    // --- guard -------------------------------------------------------------------------------------------
    const monitorState = deps.readState().monitor
    const verdict = evaluateRotationGuard({
      agentId: mainId,
      urgency: decision.urgency,
      nowMs,
      softStreak,
      log: monitorState?.rotationLog ?? [],
      breakerTripped: monitorState?.breaker?.tripped === true,
      ...(monitorState?.resetAt !== undefined ? { resetAtMs: monitorState.resetAt } : {}),
    })
    await tellOnce('gave-up', verdict.verdict === 'gave-up', text.gaveUp)
    if (verdict.verdict === 'breaker-trip') {
      mutate((s) => patchMonitorState(s, { breaker: { tripped: true, since: nowMs } }))
      await tellOnce('breaker', true, text.breaker)
      return { outcome: 'breaker-trip', detail: verdict.reason }
    }
    if (verdict.verdict === 'breaker-open') {
      await tellOnce('breaker', true, text.breaker)
      return { outcome: 'breaker-open', detail: verdict.reason }
    }
    if (verdict.verdict !== 'go') return { outcome: verdict.verdict, detail: verdict.reason }
    await tellOnce('breaker', false, text.breaker)

    const entryBase = {
      agentId: mainId,
      from: activeId,
      to: decision.targetPlanId,
      trigger: verdict.trigger as RotationTrigger,
      ...(health.window ? { window: health.window } : {}),
      ...(health.usedPercent !== undefined ? { usedPercent: health.usedPercent } : {}),
      source: 'monitor' as const,
    }
    const record = (mode2: 'observe' | 'act', result: RotationOutcome, dedupe: boolean): void =>
      logEntry({ ts: deps.now(), mode: mode2, result, ...entryBase }, dedupe)

    // --- observe: say what would happen, touch nothing ----------------------------------------------------
    if (mode !== 'act') {
      record('observe', 'would-rotate', true)
      return { outcome: 'would-rotate', detail: decision.reason }
    }

    // --- act ---------------------------------------------------------------------------------------------
    if (noFreshBlock) {
      return { outcome: 'blocked-no-fresh', detail: 'no snapshot written after the last switch' }
    }
    if (!deps.isEnabled()) {
      record('act', 'refused', true)
      return { outcome: 'refused', detail: 'CLAUDE_ROTATION_ENABLED is off' }
    }

    await notify(text.before(activeId, decision.targetPlanId, decision.reason))

    // The notice can take seconds: re-check that the decision still holds right before the restart.
    const recheckState = deps.readState()
    const stillActive = recheckState.activePlanByAgent[mainId] === activeId
    const recheckCandidates = candidatesFor(deps.readPlans(), activeId, recheckState, deps.now())
    const stillEligible = pickEligibleTarget(recheckCandidates, activeId) === decision.targetPlanId
    if (!stillActive || !stillEligible) {
      record('act', 'stale-decision', false)
      await notify(text.cancelled(decision.targetPlanId))
      return { outcome: 'stale-decision', detail: stillActive ? 'target no longer eligible' : 'active plan changed' }
    }

    const result = await deps.apply({ agentId: mainId, targetPlanId: decision.targetPlanId })
    if (result.ok) {
      record('act', 'rotated', false)
      pendingFresh = { planId: decision.targetPlanId, since: deps.now() }
      lastLogKey = null
      await notify(text.after(decision.targetPlanId))
      return { outcome: 'rotated', detail: decision.reason }
    }

    // A refusal before anything was written (disabled, unknown plan) leaves the pointer alone. A failed
    // restart (500) has already written the new pointer: put the old one back, so the state matches the
    // session that is (maybe) still running on the old plan, and let the guard's backoff decide the retry.
    if (result.status === 500) {
      mutate((s) => applyRotation(s, mainId, activeId))
      record('act', 'failed', false)
      await notify(text.failed(activeId, result.hint))
      return { outcome: 'failed', detail: result.hint }
    }
    record('act', 'refused', true)
    return { outcome: 'refused', detail: result.hint }
  }

  /**
   * The dashboard view of the monitor (GET /api/claude-plans/state, `monitor.live`). A WHITELIST, built field by
   * field: plan ids and labels, percentages, reset times, the classification, counters and the S4 class and
   * position. Nothing else is ever added here: not a config dir or its hash, not a token, not a key path, not
   * pane text. A new field needs a reason and a cell in plan-rotation-live.test.ts.
   */
  function live(): MonitorLiveCore {
    const plans = deps.readPlans()
    const label = (id: string): string => plans.find((p) => p.id === id)?.label ?? id
    const m = lastMeasure
    const windows: MonitorLiveWindows = {}
    for (const key of ['five_hour', 'seven_day'] as const) {
      const w = m?.health.windows[key]
      if (w) windows[key] = { usedPercent: w.usedPercent, resetsAt: w.resetsAt }
    }
    return {
      lastTick,
      activePlan: m ? { id: m.planId, label: label(m.planId), measuredAt: m.at } : null,
      health: m ? { status: m.health.status, reason: m.health.reason, sticky: m.health.sticky, windows } : null,
      candidates: lastCandidates.map((c) => ({
        id: c.planId,
        label: label(c.planId),
        freeFivePct: c.freeFivePct,
        freeSevenDayPct: c.freeSevenDayPct,
        exhausted: c.exhausted,
      })),
      unknownTicks: deps.readState().monitor?.consecutiveUnknown ?? 0,
      pendingFresh: pendingFresh ? { planId: pendingFresh.planId, since: pendingFresh.since, blocked: blockedUntilFresh } : null,
      s4: lastS4 ? { at: lastS4.at, pattern: lastS4.pattern, line: lastS4.line, corroborated: lastS4.corroborated } : null,
    }
  }

  return { tick, lastS4: () => lastS4, live }
}

export type PlanRotationMonitor = ReturnType<typeof createPlanRotationMonitor>

let timer: NodeJS.Timeout | undefined
/** The running monitor, for the dashboard view. Null when none is started (WEB_ONLY, isolated, or stopped). */
let activeMonitor: PlanRotationMonitor | null = null

export interface PlanRotationLive extends MonitorLiveCore {
  /** Whether a monitor is ticking in this process. */
  running: boolean
  /** The applied mode, the stored one (only when it is one of the three values) and why they differ. */
  mode: { applied: RotationMode; stored: RotationMode | 'invalid' | null; reason: RotationModeReading['reason'] }
}

const EMPTY_LIVE: MonitorLiveCore = {
  lastTick: null,
  activePlan: null,
  health: null,
  candidates: [],
  unknownTicks: 0,
  pendingFresh: null,
  s4: null,
}

/**
 * What the dashboard shows of the monitor: the applied mode with the stored value and the reason, and, when a
 * monitor runs in this process, its last measurement. Never throws: a view must not take the state endpoint down.
 */
export async function getPlanRotationLive(): Promise<PlanRotationLive> {
  const reading = await readRotationMode()
  let core = EMPTY_LIVE
  try {
    if (activeMonitor) core = activeMonitor.live()
  } catch (err) {
    logger.warn({ err }, 'Plan-rotation live view failed')
  }
  const storedMode = reading.stored === null ? null : (parseRotationModeStrict(reading.stored) ?? 'invalid')
  return {
    running: activeMonitor !== null,
    mode: { applied: reading.mode, stored: storedMode, reason: reading.reason },
    ...core,
  }
}

/** The real dependencies: the dashboard process's own readers, the shared apply and the owner channel. */
export function planRotationMonitorDeps(): MonitorDeps {
  return {
    now: () => Date.now(),
    mainAgentId: MAIN_AGENT_ID,
    readMode: readRotationMode,
    isEnabled: isRotationEnabled,
    readPlans: readClaudePlans,
    readSnapshot: (plan, nowSec) => readPlanSnapshot(plan, nowSec),
    readState: readClaudePlansState,
    writeState: writeClaudePlansState,
    apply: performRotation,
    notify: deliverToChannel,
    // The visible screen of the main channels session, read by the dashboard process itself (tmux, no agent turn).
    capturePane: () => capturePane(MAIN_CHANNELS_SESSION),
  }
}

/** Start the periodic tick. Unref'd (never keeps the process alive); a failing tick is logged and the interval goes on. */
export function startPlanRotationMonitor(deps: MonitorDeps = planRotationMonitorDeps()): void {
  stopPlanRotationMonitor()
  const monitor = createPlanRotationMonitor(deps)
  activeMonitor = monitor
  timer = setInterval(
    systemJob('plan-rotation-monitor', () => {
      void monitor.tick().catch((err: unknown) => {
        logger.warn({ err }, 'Plan-rotation monitor tick failed')
      })
    }),
    MONITOR_TICK_MS,
  )
  timer.unref()
}

export function stopPlanRotationMonitor(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  activeMonitor = null
}

/**
 * The dashboard boot hook (the shape of the channel plugin monitor's start in web.ts). A WEB_ONLY process
 * (staging previews and every isolated QA instance, which sets it) must not run it: in act mode it would restart
 * the live main session. A start that throws is logged and never stops the boot. Returns whether it started.
 */
export function bootPlanRotationMonitor(webOnly: boolean, start: () => void = startPlanRotationMonitor): boolean {
  if (webOnly) return false
  try {
    start()
    logger.info('Plan-rotation monitor started (60s tick, mode read on every tick)')
    return true
  } catch (err) {
    logger.warn({ err }, 'Plan-rotation monitor failed to start')
    return false
  }
}

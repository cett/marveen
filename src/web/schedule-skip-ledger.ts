// Scheduler skip ledger: a due occurrence of a task that was enabled must never
// be consumed without leaving a task_runs row.
//
// Background: the fire loop used to `continue` silently past any task that was
// disabled or not live. One bad release made every scheduled task read as
// skipped for ~10 hours; the tick stamp kept advancing over the due
// occurrences, so the restart catch-up had nothing to replay, no task_runs row
// showed the gap, and the only trace was a per-process-deduped audit row.
//
// Every task is in one of three states each tick:
//   runnable  enabled + live      -> the normal fire/catch-up path
//   disabled  enabled=0           -> normally the operator's switch: no run, no
//                                    row, never replayed by a catch-up
//   not_live  enabled=1, but the review gate holds it (draft/pending_review)
//                                 -> not run; every due occurrence is recorded
//                                    as `skipped_not_live`
//   tenant_mismatch  enabled + live, but its (tenant, agent) pair no longer holds
//                                 (agent switched off for the tenant, tenant
//                                 disabled) -> not run; every due occurrence is
//                                 recorded as `skipped_tenant_mismatch`. It counts
//                                 as held for the mass-skip alert like not_live.
// A `disabled` task is ALSO recorded (`skipped_disabled`) when it is part of a
// mass event: a majority of the tasks that were runnable a tick ago are all held
// back at once. That is not an operator's hand (one toggle at a time); it is the
// scheduler reading its own tasks wrongly, and each held occurrence is exactly
// what must not vanish. One deduped alert goes out per mass event. Tasks that
// were already disabled before the event are never part of it. The "runnable a
// tick ago" baseline survives a restart: the first scan seeds it from the DB, so
// a process that comes up already inside a mass event still detects it.
import type { ScheduledTask } from './scheduled-tasks-io.js'
import { isTaskLive } from './scheduled-tasks-io.js'

export const SKIP_STATUS_NOT_LIVE = 'skipped_not_live'
export const SKIP_STATUS_DISABLED = 'skipped_disabled'
export const SKIP_STATUS_TENANT_MISMATCH = 'skipped_tenant_mismatch'

/** A mass event needs at least this many tasks in play, so a fleet with one or
 *  two legitimate drafts or a single toggle never alarms. */
export const MASS_SKIP_MIN_TASKS = 4

/** A task stays in a mass event at most this long without recovering, so a task
 *  the operator deliberately left disabled after the incident stops being recorded. */
export const MASS_EPISODE_MAX_MS = 24 * 60 * 60_000

export type TaskKind = 'runnable' | 'disabled' | 'not_live' | 'tenant_mismatch'

export function classifyTask(task: Pick<ScheduledTask, 'enabled' | 'status'>, tenantMismatch = false): TaskKind {
  if (!task.enabled) return 'disabled'
  if (!isTaskLive(task)) return 'not_live'
  return tenantMismatch ? 'tenant_mismatch' : 'runnable'
}

export interface SkipLedgerDeps {
  cronPrevOccurrence: (schedule: string, fromMs: number, toMs: number) => number | null
  /** Agents the occurrence would have fired at (the same set a 'missed' run uses). */
  targets: (task: ScheduledTask) => string[]
  appendTaskRun: (name: string, agent: string, status: string) => void
  /**
   * Names of the tasks the DB says are runnable (enabled + live), read ONCE,
   * independently of the tick's own task list, before the tracker's first scan.
   * A fresh tracker has no history, so without it a process that (re)starts
   * already inside a mass event -- every task reading as disabled from the very
   * first tick -- would take that state as the baseline and never detect it.
   * Tasks the DB itself has disabled are not in it, so an operator's own
   * switches stay invisible. A throw is treated as "no baseline".
   */
  dbRunnable?: () => Iterable<string>
  /** True when the task's (tenant, agent) pair no longer holds (see `tenant_mismatch`). */
  tenantMismatch?: (task: ScheduledTask) => boolean
}

export interface SkipScanResult {
  /** Tasks that got skipped rows this tick (one row per target agent each). */
  recorded: string[]
  /** Tasks held back by the current mass event (empty when there is none). */
  massHeld: string[]
  /** True exactly on the tick a new mass event starts. */
  alert: boolean
}

export interface SkipTracker {
  scan: (tasks: ReadonlyArray<ScheduledTask>, fromMs: number, now: number, deps: SkipLedgerDeps) => SkipScanResult
}

/**
 * Stateful per-process tracker; the scheduler keeps one for its lifetime and
 * calls scan() once per tick with the tick's own scan window.
 */
export function createSkipTracker(): SkipTracker {
  let prevRunnable = new Set<string>()
  // Tasks frozen into the current mass event (name -> when they joined); each
  // leaves when it is runnable again or MASS_EPISODE_MAX_MS has passed.
  const episode = new Map<string, number>()
  let alerted = false
  let seeded = false

  return {
    scan(tasks, fromMs, now, deps) {
      if (!seeded) {
        seeded = true
        try { for (const name of deps.dbRunnable?.() ?? []) prevRunnable.add(name) }
        catch { /* no baseline: behaves like a tracker that has only the tick's own evidence */ }
      }
      const kinds = new Map(tasks.map(t => [t.name, classifyTask(t, deps.tenantMismatch?.(t) ?? false)] as const))

      // Held = would have run on the previous tick's evidence: not_live and
      // tenant_mismatch are always a DB-enabled task, disabled only counts when it was runnable a tick ago.
      const held = tasks.filter(t => {
        const kind = kinds.get(t.name)
        return kind === 'not_live' || kind === 'tenant_mismatch' || (kind === 'disabled' && prevRunnable.has(t.name))
      })
      const inPlay = new Set<string>(prevRunnable)
      for (const t of tasks) if (t.enabled) inPlay.add(t.name)
      const mass = inPlay.size >= MASS_SKIP_MIN_TASKS && held.length * 2 > inPlay.size

      let alert = false
      if (mass) {
        for (const t of held) if (!episode.has(t.name)) episode.set(t.name, now)
        if (!alerted) { alerted = true; alert = true }
      } else {
        alerted = false
      }
      for (const [name, joinedMs] of [...episode]) {
        const kind = kinds.get(name)
        if (kind === undefined || kind === 'runnable' || now - joinedMs > MASS_EPISODE_MAX_MS) episode.delete(name)
      }

      const recorded: string[] = []
      for (const task of tasks) {
        const kind = kinds.get(task.name)
        let status: string | null = null
        if (kind === 'not_live') status = SKIP_STATUS_NOT_LIVE
        else if (kind === 'tenant_mismatch') status = SKIP_STATUS_TENANT_MISMATCH
        else if (kind === 'disabled' && episode.has(task.name)) status = SKIP_STATUS_DISABLED
        if (status === null) continue
        if (deps.cronPrevOccurrence(task.schedule, fromMs, now) == null) continue
        for (const agent of deps.targets(task)) deps.appendTaskRun(task.name, agent, status)
        recorded.push(task.name)
      }

      prevRunnable = new Set(tasks.filter(t => kinds.get(t.name) === 'runnable').map(t => t.name))
      return { recorded, massHeld: mass ? [...episode.keys()] : [], alert }
    },
  }
}

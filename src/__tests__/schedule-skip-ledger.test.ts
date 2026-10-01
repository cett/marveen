import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MASS_EPISODE_MAX_MS,
  MASS_SKIP_MIN_TASKS,
  SKIP_STATUS_DISABLED,
  SKIP_STATUS_NOT_LIVE,
  classifyTask,
  createSkipTracker,
  type SkipLedgerDeps,
} from '../web/schedule-skip-ledger.js'
import { computeCatchUpStart, SCHEDULE_TICK_MS } from '../web/schedule-runner.js'
import { cronPrevOccurrence } from '../web/cron.js'
import { isTaskLive, type ScheduledTask } from '../web/scheduled-tasks-io.js'

// Regression: one bad release made every enabled task read as held back for ~10
// hours. The tick stamp advanced over the due occurrences, no task_runs row
// existed, the audit row was per-process and no alert went out. These tests run
// the skip ledger against a fake clock (plain numbers, no timers) with the real
// cron evaluator and record what would be written to task_runs.

const MIN = 60_000
const HOUR = 60 * MIN
// An aligned instant, 5 minutes past the hour, so window edges never sit on an occurrence.
const T0 = Date.UTC(2026, 8, 28, 22, 5, 0)

interface Run { name: string; agent: string; status: string }

function harness() {
  const runs: Run[] = []
  const deps: SkipLedgerDeps = {
    cronPrevOccurrence: (schedule, from, to) => cronPrevOccurrence(schedule, from, to),
    targets: t => [t.agent || 'main'],
    appendTaskRun: (name, agent, status) => { runs.push({ name, agent, status }) },
  }
  return { runs, deps }
}

function task(name: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '*/30 * * * *', agent: 'main', enabled: true,
    createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false, status: 'live', ...over,
  } as ScheduledTask
}

// 24 tasks over three cadences (every 15 / 30 / 60 minutes).
const CADENCE_MIN = [15, 30, 60]
function fleet24(over: (i: number) => Partial<ScheduledTask>): ScheduledTask[] {
  return Array.from({ length: 24 }, (_, i) => {
    const every = CADENCE_MIN[i % 3]
    const schedule = every === 60 ? '0 * * * *' : `*/${every} * * * *`
    return task(`t${i}`, { schedule, ...over(i) })
  })
}

/** Independent count of occurrences in (from, to] for an aligned every-N-minutes cron. */
function occurrencesBetween(everyMin: number, from: number, to: number): number {
  const step = everyMin * MIN
  return Math.floor(to / step) - Math.floor(from / step)
}

/** Drive one tracker over (start, end] with the real tick cadence. */
function runTicks(
  tracker: ReturnType<typeof createSkipTracker>,
  tasksAt: (now: number) => ScheduledTask[],
  start: number, end: number, deps: SkipLedgerDeps,
) {
  let from = start
  let alerts = 0
  for (let now = start + SCHEDULE_TICK_MS; now <= end; now += SCHEDULE_TICK_MS) {
    const res = tracker.scan(tasksAt(now), from, now, deps)
    if (res.alert) alerts++
    from = now
  }
  return { alerts, lastTick: from }
}

describe('skip ledger: a 10 hour window of held-back tasks (24 tasks, restart after)', () => {
  const held = (i: number): Partial<ScheduledTask> =>
    i < 4 ? { enabled: false } : { status: 'draft' } // 4 really disabled, 20 enabled but held by the gate

  it('records one row per due occurrence for every enabled-but-held task, none for the really disabled ones, and alerts once', () => {
    const { runs, deps } = harness()
    const tasks = fleet24(held)
    const { alerts } = runTicks(createSkipTracker(), () => tasks, T0, T0 + 10 * HOUR, deps)

    for (let i = 4; i < 24; i++) {
      const rows = runs.filter(r => r.name === `t${i}`)
      expect(rows.length, `t${i}`).toBe(occurrencesBetween(CADENCE_MIN[i % 3], T0, T0 + 10 * HOUR))
      expect(new Set(rows.map(r => r.status))).toEqual(new Set([SKIP_STATUS_NOT_LIVE]))
      expect(new Set(rows.map(r => r.agent))).toEqual(new Set(['main']))
    }
    for (let i = 0; i < 4; i++) expect(runs.filter(r => r.name === `t${i}`)).toEqual([])
    expect(alerts).toBe(1)
  })

  it('after the restart the really disabled tasks are not replayed, and nothing further is recorded', () => {
    const { runs, deps } = harness()
    const heldTasks = fleet24(held)
    const { lastTick } = runTicks(createSkipTracker(), () => heldTasks, T0, T0 + 10 * HOUR, deps)
    const rowsBeforeRestart = runs.length

    // Restart: a fresh tracker, the release is reverted so the drafts are live again.
    const recovered = fleet24(i => (i < 4 ? { enabled: false } : {}))
    const now = lastTick + 2 * MIN
    const fromMs = computeCatchUpStart(lastTick, now)
    const res = createSkipTracker().scan(recovered, fromMs, now, deps)

    expect(res.recorded).toEqual([])
    expect(res.alert).toBe(false)
    expect(runs.length).toBe(rowsBeforeRestart)
    // The runner only fires what classifies as runnable: the four disabled never do.
    const runnable = recovered.filter(t => classifyTask(t) === 'runnable').map(t => t.name)
    expect(runnable).toHaveLength(20)
    for (let i = 0; i < 4; i++) expect(runnable).not.toContain(`t${i}`)
  })
})

describe('skip ledger: a mass disable (enabled flipped to 0 for most tasks at once)', () => {
  it('records skipped_disabled rows for the flipped tasks only, alerts once, and stops when they recover', () => {
    const { runs, deps } = harness()
    const tracker = createSkipTracker()
    const live = fleet24(i => (i < 4 ? { enabled: false } : {})) // t0..t3 disabled all along
    const off = fleet24(() => ({ enabled: false })) // the other 20 flip

    // A few normal ticks, then the flip lasts 10 hours.
    const warm = runTicks(tracker, () => live, T0, T0 + 10 * SCHEDULE_TICK_MS, deps)
    expect(runs).toEqual([])
    const flipStart = warm.lastTick
    const window = runTicks(tracker, () => off, flipStart, flipStart + 10 * HOUR, deps)

    for (let i = 4; i < 24; i++) {
      const rows = runs.filter(r => r.name === `t${i}`)
      expect(rows.length, `t${i}`).toBe(occurrencesBetween(CADENCE_MIN[i % 3], flipStart, flipStart + 10 * HOUR))
      expect(new Set(rows.map(r => r.status))).toEqual(new Set([SKIP_STATUS_DISABLED]))
    }
    for (let i = 0; i < 4; i++) expect(runs.filter(r => r.name === `t${i}`)).toEqual([])
    expect(window.alerts).toBe(1)

    // Recovery: everything the flip took is runnable again -> no more rows, no alert.
    const before = runs.length
    const after = runTicks(tracker, () => live.map((t, i) => (i < 4 ? t : { ...t, enabled: true })), window.lastTick, window.lastTick + HOUR, deps)
    expect(runs.length).toBe(before)
    expect(after.alerts).toBe(0)
    // ...and a lone operator toggle afterwards is left alone.
    const toggled = fleet24(i => (i < 4 || i === 10 ? { enabled: false } : {}))
    runTicks(tracker, () => toggled, after.lastTick, after.lastTick + 2 * HOUR, deps)
    expect(runs.length).toBe(before)
  })
})

describe('skip ledger: a process that (re)starts already inside a mass event', () => {
  // The tick reads every task as disabled from its very first read (the DB still
  // says enabled). A fresh tracker has no "runnable a tick ago" history, so
  // without a DB baseline the mass disable is taken as the normal state: 0 rows,
  // 0 alerts, for as long as it lasts.
  const dbEnabled = (tasks: ScheduledTask[]) => () => tasks.map(t => t.name)
  const readAsDisabled = (): Partial<ScheduledTask> => ({ enabled: false })

  it('without a baseline the restart-into-the-incident goes unseen (what the seed fixes)', () => {
    const { runs, deps } = harness()
    const { alerts } = runTicks(createSkipTracker(), () => fleet24(readAsDisabled), T0, T0 + 2 * HOUR, deps)
    expect(runs).toEqual([])
    expect(alerts).toBe(0)
  })

  it('seeded from the DB: skipped_disabled rows from the first tick on, and one alert', () => {
    const { runs, deps } = harness()
    const tasks = fleet24(readAsDisabled)
    const { alerts } = runTicks(createSkipTracker(), () => tasks, T0, T0 + 2 * HOUR, { ...deps, dbRunnable: dbEnabled(tasks) })

    expect(alerts).toBe(1)
    for (let i = 0; i < 24; i++) {
      const rows = runs.filter(r => r.name === `t${i}`)
      expect(rows.length, `t${i}`).toBe(occurrencesBetween(CADENCE_MIN[i % 3], T0, T0 + 2 * HOUR))
      expect(new Set(rows.map(r => r.status))).toEqual(new Set([SKIP_STATUS_DISABLED]))
    }
  })

  it('the very first scan already records and alerts (no warm-up tick)', () => {
    const { runs, deps } = harness()
    const tasks = fleet24(readAsDisabled)
    const res = createSkipTracker().scan(tasks, T0, T0 + 30 * MIN, { ...deps, dbRunnable: dbEnabled(tasks) })
    expect(res.alert).toBe(true)
    expect(res.recorded.length).toBeGreaterThan(0)
    expect(runs.length).toBeGreaterThan(0)
  })

  it('tasks the DB itself has disabled stay out of it, even in the middle of a mass event', () => {
    const { runs, deps } = harness()
    const tasks = fleet24(readAsDisabled)
    const dbSaysEnabled = tasks.filter((_, i) => i >= 4).map(t => t.name) // t0..t3 are disabled in the DB too
    runTicks(createSkipTracker(), () => tasks, T0, T0 + 2 * HOUR, { ...deps, dbRunnable: () => dbSaysEnabled })

    for (let i = 0; i < 4; i++) expect(runs.filter(r => r.name === `t${i}`), `t${i}`).toEqual([])
    expect(runs.filter(r => r.name === 't4').length).toBeGreaterThan(0)
  })

  it('a fleet the DB has disabled as a whole (operator switch-off) records nothing and does not alert', () => {
    const { runs, deps } = harness()
    const { alerts } = runTicks(createSkipTracker(), () => fleet24(readAsDisabled), T0, T0 + 2 * HOUR, { ...deps, dbRunnable: () => [] })
    expect(runs).toEqual([])
    expect(alerts).toBe(0)
  })

  it('the baseline is read once, before the first scan only', () => {
    const { deps } = harness()
    let reads = 0
    const tasks = fleet24(readAsDisabled)
    runTicks(createSkipTracker(), () => tasks, T0, T0 + HOUR, { ...deps, dbRunnable: () => { reads++; return tasks.map(t => t.name) } })
    expect(reads).toBe(1)
  })

  it('a failing baseline read does not break the tick (falls back to the tick evidence)', () => {
    const { runs, deps } = harness()
    const tasks = fleet24(i => (i < 4 ? {} : { status: 'draft' }))
    const { alerts } = runTicks(createSkipTracker(), () => tasks, T0, T0 + HOUR, { ...deps, dbRunnable: () => { throw new Error('db gone') } })
    expect(runs.length).toBeGreaterThan(0) // drafts still recorded
    expect(alerts).toBe(1)
  })
})

describe('skip ledger: what is NOT a mass event', () => {
  it('a single operator toggle among many tasks records nothing and does not alert', () => {
    const { runs, deps } = harness()
    const tracker = createSkipTracker()
    const all = fleet24(() => ({}))
    const warm = runTicks(tracker, () => all, T0, T0 + 5 * MIN, deps)
    const toggled = fleet24(i => (i === 7 ? { enabled: false } : {}))
    const { alerts } = runTicks(tracker, () => toggled, warm.lastTick, warm.lastTick + 3 * HOUR, deps)
    expect(runs).toEqual([])
    expect(alerts).toBe(0)
  })

  it('a minority of drafts still gets a row per occurrence but no alert', () => {
    const { runs, deps } = harness()
    const tasks = fleet24(i => (i < 3 ? { status: 'draft' } : {}))
    const { alerts } = runTicks(createSkipTracker(), () => tasks, T0, T0 + 2 * HOUR, deps)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.every(r => r.status === SKIP_STATUS_NOT_LIVE)).toBe(true)
    expect(new Set(runs.map(r => r.name))).toEqual(new Set(['t0', 't1', 't2']))
    expect(alerts).toBe(0)
  })

  it(`a fleet smaller than ${MASS_SKIP_MIN_TASKS} tasks never alarms, even when all of them are held`, () => {
    const { deps } = harness()
    const tasks = Array.from({ length: MASS_SKIP_MIN_TASKS - 1 }, (_, i) => task(`s${i}`, { status: 'draft' }))
    const { alerts } = runTicks(createSkipTracker(), () => tasks, T0, T0 + HOUR, deps)
    expect(alerts).toBe(0)
  })
})

describe('skip ledger: alert dedupe and episode bounds', () => {
  it('alerts once per event and again for a second, separate event', () => {
    const { deps } = harness()
    const tracker = createSkipTracker()
    const ok = fleet24(() => ({}))
    const bad = fleet24(() => ({ status: 'draft' }))
    let t = T0
    let total = 0
    for (const p of [ok, bad, bad, ok, bad]) {
      const r = runTicks(tracker, () => p, t, t + HOUR, deps)
      total += r.alerts
      t = r.lastTick
    }
    expect(total).toBe(2)
  })

  it('a task left disabled after an incident stops being recorded once the episode expires', () => {
    const { runs, deps } = harness()
    const tracker = createSkipTracker()
    const live = fleet24(() => ({}))
    const off = fleet24(() => ({ enabled: false }))
    const mostlyBack = fleet24(i => (i === 23 ? { enabled: false } : {})) // t23 stays disabled
    const w = runTicks(tracker, () => live, T0, T0 + MIN, deps)
    const f = runTicks(tracker, () => off, w.lastTick, w.lastTick + 5 * MIN, deps)

    // Still inside the bound: t23 keeps being recorded.
    runs.length = 0
    const inside = runTicks(tracker, () => mostlyBack, f.lastTick, f.lastTick + 2 * HOUR, deps)
    expect(runs.some(r => r.name === 't23' && r.status === SKIP_STATUS_DISABLED)).toBe(true)

    // Past the bound: nothing more, although t23 is still disabled.
    const coarse = (from: number, to: number) => {
      let last = from
      for (let now = from + 5 * MIN; now <= to; now += 5 * MIN) {
        tracker.scan(mostlyBack, last, now, deps)
        last = now
      }
      return last
    }
    const pastBound = coarse(inside.lastTick, f.lastTick + MASS_EPISODE_MAX_MS + HOUR)
    runs.length = 0
    coarse(pastBound, pastBound + 3 * HOUR)
    expect(runs).toEqual([])
  })

  it('an agent="all" task gets a row for every target', () => {
    const { runs, deps } = harness()
    deps.targets = () => ['main', 'agent-a', 'agent-b']
    const tasks = [task('broadcast', { status: 'draft', schedule: '0 * * * *', agent: 'all' }), ...fleet24(() => ({}))]
    runTicks(createSkipTracker(), () => tasks, T0, T0 + HOUR, deps)
    expect(runs.filter(r => r.name === 'broadcast').map(r => r.agent)).toEqual(['main', 'agent-a', 'agent-b'])
  })

  it('a task with no occurrence in the window records nothing', () => {
    const { runs, deps } = harness()
    const tasks = [task('rare', { status: 'draft', schedule: '0 3 1 1 *' })]
    createSkipTracker().scan(tasks, T0, T0 + HOUR, deps)
    expect(runs).toEqual([])
  })
})

describe('classifyTask matches the predicate the fire loop gates on', () => {
  it('runnable exactly when enabled and live', () => {
    for (const enabled of [true, false]) {
      for (const status of [undefined, 'live', 'draft', 'pending_review'] as const) {
        const t = { enabled, status }
        const loopSkips = !t.enabled || !isTaskLive(t)
        expect(classifyTask(t) === 'runnable', `${enabled}/${status}`).toBe(!loopSkips)
        if (!enabled) expect(classifyTask(t)).toBe('disabled')
      }
    }
  })
})

describe('the runner wires the ledger into every tick', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it("scans the skipped tasks before the fire loop, with the tick's own window", () => {
    const scan = SRC.indexOf('skipTracker.scan(tasks, fromMs, now,')
    const loop = SRC.indexOf('for (const task of tasks) {')
    expect(scan).toBeGreaterThan(0)
    expect(loop).toBeGreaterThan(scan)
  })

  it('raises the mass-skip alert off the scan result', () => {
    expect(SRC).toMatch(/if \(skipScan\.alert\) sendMassSkipAlert\(/)
  })

  it('seeds the skip tracker baseline from the DB rows, not from the tick task list', () => {
    expect(SRC).toMatch(/dbRunnable: listDbRunnableTaskNames/)
  })

  it('reconciles task-config.json enabled from the DB', () => {
    expect(SRC).toMatch(/syncTaskConfigEnabledFromDb\(\)/)
  })
})

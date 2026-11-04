import { spawn } from "node:child_process"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { STORE_DIR, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID } from "../config.js"
import { atomicWriteFileSync } from "./atomic-write.js"
import { logger } from "../logger.js"
import { sendTelegramMessage } from "./telegram.js"
import { appendTaskRun, upsertOtelSpan } from "../db.js"
import { recordScheduleRunDuration } from "../otel-signals.js"
import type { ScheduledTask } from "./scheduled-tasks-io.js"

// command-type scheduled tasks run a raw shell command directly (no LLM
// agent, no tmux session) and alert on Telegram after N consecutive
// failures. This keeps infra heartbeats inside the one system that gets
// backed up (the Marveen store) instead of a separate crontab.

const HEALTH_PATH = join(STORE_DIR, "command-task-health.json")

export interface CommandHealth {
  fails: number
  alerted: boolean
  lastStatus: "ok" | "fail" | "findings" | "unknown"
  lastRun: number
  /** Why the last run ended as it did (exit code and stderr head, or the timeout); absent in maps written before it existed. */
  lastDetail?: string
}
type HealthMap = Record<string, CommandHealth>

let healthMap: HealthMap | null = null
function load(): HealthMap {
  if (healthMap) return healthMap
  try { healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { healthMap = {} }
  return healthMap
}
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}

export type CommandAction = "none" | "alert" | "findings" | "recover"

// A command that checks something and found it wanting (a monitor with a
// report, not a crashed job) exits with this code. It is a finding, not a run
// failure: the run span stays ok and the failure streak is not touched, but the
// owner is still told once (like a failure alert) and hears about the recovery.
// Any other non-zero exit stays a failure.
export const COMMAND_EXIT_FINDINGS = 42
export type CommandOutcome = "ok" | "findings" | "fail"

// Pure decision function so the failure/recovery policy is unit-testable
// without spawning processes. "ok" zeroes the streak; a failure alerts exactly
// once when the streak first reaches failThreshold; "findings" alerts once when
// the findings start (it never counts toward the failure streak); a recover
// fires once when a previously-alerted task runs clean again. A boolean is the
// old success flag.
export function evaluateCommandResult(
  prev: CommandHealth | undefined,
  outcome: CommandOutcome | boolean,
  failThreshold: number,
  now: number,
  detail?: string,
): { next: CommandHealth; action: CommandAction } {
  const kind: CommandOutcome = typeof outcome === "boolean" ? (outcome ? "ok" : "fail") : outcome
  const wasAlerted = prev?.alerted ?? false
  const fails = kind === "fail" ? (prev?.fails ?? 0) + 1 : 0
  let action: CommandAction = "none"
  let alerted = wasAlerted
  if (kind === "ok") {
    if (wasAlerted) { action = "recover"; alerted = false }
  } else if (kind === "findings") {
    if (!wasAlerted) { action = "findings"; alerted = true }
  } else if (fails >= failThreshold && !wasAlerted) {
    action = "alert"; alerted = true
  }
  return {
    next: { fails, alerted, lastStatus: kind, lastRun: now, ...(detail !== undefined && { lastDetail: detail.slice(0, MAX_DETAIL_CHARS) }) },
    action,
  }
}

const MAX_STDERR_BYTES = 4096
const KILL_GRACE_MS = 2000
const MAX_DETAIL_CHARS = 240
// A command's time limit counts the time the host was awake. The monotonic clock of the process keeps
// counting while the machine sleeps (and so do the timers), so a laptop that sleeps in the middle of a
// backup would fire the limit on wake-up although the command ran for seconds. A watchdog that ticks
// every tickMs sees the sleep as one tick that arrives far too late: a gap longer than a tick by more than
// SLEEP_GAP_MS is time the process did not run, and it is not charged to the command. A real event-loop
// stall of that length is counted the same way (the command got that much extra time), which errs on the
// side of not killing.
const SLEEP_GAP_MS = 5000

export interface RunClock {
  /** Monotonic milliseconds that keep counting while the machine sleeps. */
  now(): number
  /** Calls fn every ms until the returned function is called. */
  every(ms: number, fn: () => void): () => void
}
const realClock: RunClock = {
  now: () => performance.now(),
  every: (ms, fn) => {
    const handle = setInterval(fn, ms)
    return () => clearInterval(handle)
  },
}

// Runs `bash -lc <cmd>` WITHOUT blocking the event loop. This matters because
// the scheduler lives inside the dashboard process: a synchronous spawn would
// freeze the HTTP server for the whole run, so a command that talks to the
// dashboard's own API (curl http://localhost:<port>/api/...) could never be
// answered and would simply time out. The child gets its own process group so a
// timeout takes the whole tree down (bash, curl, tar, ...), not just the shell.
export function runCommand(
  cmd: string,
  timeoutMs: number,
  clock: RunClock = realClock,
): Promise<{ outcome: CommandOutcome; detail: string; suspendedMs: number }> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stderr = ""
    let timer: NodeJS.Timeout | undefined
    let stopWatchdog: (() => void) | undefined
    let suspendedMs = 0
    const startedAt = clock.now()
    let lastSeen = startedAt
    const tickMs = Math.max(25, Math.min(1000, Math.floor(timeoutMs / 4)))
    const finish = (r: { outcome: CommandOutcome; detail: string }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      stopWatchdog?.()
      resolve({ ...r, suspendedMs })
    }
    // True when the process was not running for a while since it last looked (the machine slept).
    const noteSuspension = (): boolean => {
      const now = clock.now()
      const gap = now - lastSeen
      lastSeen = now
      if (gap <= tickMs + SLEEP_GAP_MS) return false
      // The process ran for at most one tick of the gap; charging none of it errs on the side of not killing.
      suspendedMs += gap
      return true
    }
    const awakeRemainingMs = () => timeoutMs - (clock.now() - startedAt - suspendedMs)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("bash", ["-lc", cmd], { stdio: ["ignore", "ignore", "pipe"], detached: true })
    } catch (err) {
      finish({ outcome: "fail", detail: (err as Error).message })
      return
    }
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* already gone */ }
    }
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += d.toString()
    })
    child.on("error", (err) => finish({ outcome: "fail", detail: err.message }))
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ outcome: "fail", detail: `timeout ${timeoutMs}ms` })
      if (code === 0) return finish({ outcome: "ok", detail: "exit 0" })
      const err = stderr.trim().slice(0, 200)
      finish({ outcome: code === COMMAND_EXIT_FINDINGS ? "findings" : "fail", detail: `exit ${code ?? signal}${err ? ": " + err : ""}` })
    })
    const onDeadline = () => {
      if (settled) return
      // The timer and the watchdog both wake up late after a sleep, in either order: look here too, so the
      // limit is never judged before the sleep has been taken off the clock.
      noteSuspension()
      if (suspendedMs > 0) {
        const remaining = awakeRemainingMs()
        if (remaining > 1) {
          timer = setTimeout(onDeadline, remaining)
          return
        }
      }
      timedOut = true
      killTree("SIGTERM")
      setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref()
      // do not wait for a stubborn tree to exit: the run is already a failure
      finish({ outcome: "fail", detail: `timeout ${timeoutMs}ms` })
    }
    timer = setTimeout(onDeadline, timeoutMs)
    // The ticks keep lastSeen fresh and book a sleep as soon as the process wakes; the deadline above turns
    // the booked sleep into the awake time the command still has left instead of a failure.
    stopWatchdog = clock.every(tickMs, () => {
      if (!settled) noteSuspension()
    })
  })
}

// A command task that is still running when its next occurrence is due (or when
// someone hits run-now) is skipped rather than started twice: two overlapping
// backups or memory sweeps would fight over the same files/rows.
const inFlight = new Set<string>()

// Never rejects: every failure is logged and recorded as a failed run.
export async function runCommandTask(task: ScheduledTask, now: number): Promise<void> {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  if (inFlight.has(task.name)) {
    logger.warn({ task: task.name }, "command task still running from an earlier occurrence, skipping this one")
    return
  }
  inFlight.add(task.name)
  try {
    await runCommandTaskInner(task, now)
  } catch (err) {
    logger.warn({ err, task: task.name }, "command task crashed outside the command itself")
  } finally {
    inFlight.delete(task.name)
  }
}

async function runCommandTaskInner(task: ScheduledTask, now: number): Promise<void> {
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  const map = load()
  const startedMs = Date.now()
  const { outcome, detail, suspendedMs } = await runCommand(task.command as string, timeoutMs)
  // A finding is a run that did its job: only a real failure is an error span / error metric.
  const ok = outcome !== "fail"
  const endedMs = Date.now()
  // Two separate guards: a failing metric must not cost the span, nor the other way round.
  try { recordScheduleRunDuration(task.name, (endedMs - startedMs) / 1000, ok) } catch { /* telemetry is never fatal to the task */ }
  try {
    await upsertOtelSpan({
      trace_id: `schedule-${task.name}-${startedMs}`, span_id: 'run', parent_span_id: null,
      agent_id: task.agent || 'system', operation: 'schedule.run', start_ms: startedMs, end_ms: endedMs,
      status: ok ? 'ok' : 'error',
      attributes: JSON.stringify({ schedule: task.name, schedule_type: 'command', ...(outcome === 'findings' && { outcome: 'findings' }) }),
    })
  } catch { /* telemetry is never fatal to the task */ }
  const { next, action } = evaluateCommandResult(map[task.name], outcome, failThreshold, now, detail)
  map[task.name] = next
  persist()
  try { await appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
  logger.info({ task: task.name, ok, outcome, detail, fails: next.fails, action }, "command task ran")
  if (suspendedMs > 0) logger.info({ task: task.name, suspendedMs, timeoutMs }, "command task ran across a host sleep: the sleep was not charged to its time limit")

  if (action === "none") return
  if (!TELEGRAM_BOT_TOKEN || !ALLOWED_CHAT_ID) {
    logger.warn({ task: task.name }, "command task alert suppressed: missing token/chat_id")
    return
  }
  const label = task.description || task.name
  const text = action === "alert"
    ? `\u{1F534} Hiba: ${label} nem v\u00e1laszol (${next.fails}. egym\u00e1s ut\u00e1ni hiba). R\u00e9szlet: ${detail}`
    : action === "findings"
      ? `\u{1F7E0} Lelet: ${label}. R\u00e9szlet: ${detail}`
      : `\u{1F7E2} Helyre\u00e1llt: ${label} ism\u00e9t OK.`
  sendTelegramMessage(TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, text)
    .then(() => logger.info({ task: task.name, action }, "command task alert sent"))
    .catch((err) => logger.warn({ err, task: task.name }, "command task alert send failed"))
}

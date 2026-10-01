import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { sanitizeScheduleName, safeJoin } from './sanitize.js'
import {
  countSchedules, listSchedulesFromDb, getScheduleFromDb, upsertSchedule, deleteSchedule,
  setScheduleEnabled, patchSchedule, seedScheduleIfAbsent,
  type ScheduleRow,
} from '../db.js'

export const SCHEDULED_TASKS_DIR = join(homedir(), '.claude', 'scheduled-tasks')

// Hard cap on the prompt length for a scheduled task, to stop a malicious
// or accidentally-huge POST body from exhausting the target agent's
// token budget (and wedging the tmux send-keys paste detector). 50,000
// characters is ~12k tokens of English, which is already far beyond any
// legitimate schedule prompt -- real ones are usually <1k chars. Doubles
// as the scheduled-task size-guard ALERT threshold: past this point
// delivery is fine (reference-based, see below), but the task itself is
// large enough to warrant a direct owner notice.
export const MAX_SCHEDULED_TASK_PROMPT_LEN = 50_000

// Above this length the runner snapshots the full task body to disk
// (scheduled-run-snapshot.ts) and sends only a short reference through tmux,
// instead of pasting the whole body via send-keys -- the send-keys path is a
// known source of size-driven corruption on large fires. Below it, the
// existing inline path is unchanged.
export const SCHEDULED_TASK_INLINE_MAX_CHARS = 1_500

// Below this, no size-guard notice. At/above it: a one-per-task-per-day
// logger.warn (the operator sees the growth trend before it reaches the
// alert tier at MAX_SCHEDULED_TASK_PROMPT_LEN above).
export const SCHEDULED_TASK_BODY_WARN_CHARS = 20_000

export interface ScheduledTask {
  name: string
  description: string
  prompt: string
  schedule: string
  agent: string
  enabled: boolean
  createdAt: number
  // The tenant the task belongs to. Every task has one: a stored NULL (pre-migration row) reads
  // as 'default', and a file-based task that does not name one is seeded as 'default'.
  tenantId?: string
  type?: 'task' | 'heartbeat' | 'command'  // heartbeat = silent unless important; command = raw shell, no LLM
  // When true, a tick whose target session is busy is dropped silently
  // instead of queued. Use ONLY for cron schedules that fire often enough
  // (every 30-60 min) that losing a single tick is harmless because the
  // next one is already on the way. Daily/weekly schedules must keep
  // skipIfBusy false (default) so the queue + alert path catches a
  // long-running busy state and nothing business-critical is lost.
  skipIfBusy?: boolean
  // When true, skip the busy-state check entirely and inject the prompt
  // via tmux send-keys regardless. The Claude session will process it at
  // the next idle slot. Useful for critical tasks that must never be
  // deferred to a retry queue (e.g. daily briefings, heartbeats during
  // active conversations).
  forceSend?: boolean
  // Override the default tmux session name derived from the agent. When
  // set, the scheduler targets this exact tmux session instead of
  // `agent-<name>` or MAIN_CHANNELS_SESSION. Enables dedicated
  // scheduler-only sessions in the future.
  targetSession?: string
  // type='command' only: raw shell command run via `bash -lc`, no LLM/tmux.
  command?: string
  // type='command' only: command timeout in ms (default 10000).
  timeoutMs?: number
  // type='command' only: consecutive failures before a Telegram alert (default 2).
  failThreshold?: number
  // Optional pre-check script (filename relative to the task dir, or absolute path).
  // Runs via `bash` BEFORE invoking the LLM. Protocol:
  //   exit 0 + stdout "SKIP" → skip LLM this tick (nothing actionable)
  //   exit 0 + other stdout  → run LLM with stdout prepended to prompt as context
  //   exit 0 + empty stdout  → run LLM normally
  //   non-zero exit          → log warning, run LLM anyway (fail-open)
  preCheck?: string
  // How stale a MISSED occurrence may be and still be executed as a catch-up
  // after the scheduler was down (host powered off, dashboard restart). Unset
  // uses the per-type default in DEFAULT_CATCHUP_MAX_AGE_MIN; 0 disables
  // catch-up for this task entirely (only on-time ticks run it); a negative
  // value means "always catch up, however late". Occurrences older than the
  // limit are recorded as a 'missed' run and reported, never silently dropped.
  catchUpMaxAgeMinutes?: number
  // How long this task may run before the post-fire watchdog calls it stuck and
  // alerts the operator. Unset uses the global TASK_FIRE_TIMEOUT_MS (5 min),
  // which is right for a short-cadence heartbeat and wrong for a task whose job
  // is to think for a while. Clamped at both ends, see resolveStuckTimeoutMs.
  // DISTINCT from catchUpMaxAgeMinutes: that one judges a MISSED occurrence's
  // staleness before firing; this one judges a RUNNING injection's age.
  stuckAfterMinutes?: number
  // Manifest-style requirements (Roitman 22.5). When mcp_servers is set, the
  // runner pre-checks each named MCP server has a live process under the
  // target session before injecting the prompt; a dead server defers the task
  // with a reasoned alert instead of a silent runtime failure.
  requires?: { mcp_servers?: string[] }
  // Review-gate. Undefined/absent is treated as
  // 'live' everywhere this is read (backward compat for pre-migration file
  // tasks and any caller that doesn't set it) -- see isTaskLive() below.
  status?: 'draft' | 'pending_review' | 'live'
  // Runner-managed bookkeeping (migration 0057, #985 group 2/8) -- set via
  // updateScheduleLastRun(), never by a caller creating/editing a schedule.
  // Undefined for a file-based task (the legacy fallback branch never had
  // this data) or a schedule that has not fired yet.
  lastRunAt?: number
  lastRunResult?: string
}

// True when the runner is allowed to fire this task. A task with no status
// at all (legacy file-based task, or a caller that never set one) is treated
// as live -- the review-gate only restricts tasks that were explicitly
// created in a non-live state.
/**
 * Remove the file mirror (SKILL.md + task-config.json) of the named tasks. The files are only a
 * mirror of the schedules table, but a leftover one would put the task back the next time an
 * empty table is re-seeded from the files. Returns how many directories were removed.
 */
export function removeScheduledTaskFiles(names: ReadonlyArray<string>): number {
  let removed = 0
  for (const raw of names) {
    const name = sanitizeScheduleName(raw)
    if (!name) continue
    let dir: string
    try { dir = safeJoin(SCHEDULED_TASKS_DIR, name) } catch { continue }
    if (!existsSync(dir)) continue
    rmSync(dir, { recursive: true, force: true })
    removed++
  }
  return removed
}

export function isTaskLive(task: Pick<ScheduledTask, 'status'>): boolean {
  return task.status === undefined || task.status === 'live'
}

function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function parseSkillMdFrontmatter(content: string): { name?: string; description?: string; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!fmMatch) return { body: content }
  const yaml = fmMatch[1]
  const body = fmMatch[2].trim()
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  const descMatch = yaml.match(/^description:\s*(.+)$/m)
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
    body,
  }
}

export function readScheduledTask(taskName: string): ScheduledTask | null {
  const dir = join(SCHEDULED_TASKS_DIR, taskName)
  const skillPath = join(dir, 'SKILL.md')
  const configPath = join(dir, 'task-config.json')
  const hasSkill = existsSync(skillPath)
  // command-type tasks have no SKILL.md; they are defined entirely by
  // task-config.json. Only bail if neither file exists.
  if (!hasSkill && !existsSync(configPath)) return null

  const skillContent = hasSkill ? readFileOr(skillPath, '') : ''
  const { name, description, body } = parseSkillMdFrontmatter(skillContent)

  let config: { schedule?: string; agent?: string; enabled?: boolean; createdAt?: number; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; description?: string; command?: string; timeoutMs?: number; failThreshold?: number; tenantId?: string; preCheck?: string; catchUpMaxAgeMinutes?: unknown; stuckAfterMinutes?: unknown; requires?: { mcp_servers?: unknown }; status?: string } = {}
  try {
    config = JSON.parse(readFileOr(configPath, '{}'))
  } catch { /* use defaults */ }

  return {
    name: name || taskName,
    description: description || config.description || '',
    prompt: body,
    schedule: config.schedule || '0 9 * * *',
    agent: config.agent || MAIN_AGENT_ID,
    enabled: config.enabled !== false,
    createdAt: config.createdAt || 0,
    type: (config.type as 'task' | 'heartbeat' | 'command') || 'task',
    skipIfBusy: config.skipIfBusy === true,
    forceSend: config.forceSend === true,
    targetSession: config.targetSession || undefined,
    command: config.command,
    timeoutMs: config.timeoutMs,
    failThreshold: config.failThreshold,
    tenantId: typeof config.tenantId === 'string' && config.tenantId.trim() ? config.tenantId.trim() : undefined,
    preCheck: config.preCheck,
    catchUpMaxAgeMinutes: parseCatchUpMaxAge(config.catchUpMaxAgeMinutes),
    stuckAfterMinutes: parseFiniteMinutes(config.stuckAfterMinutes),
    requires: parseRequires(config.requires),
    status: parseTaskStatus(config.status),
  }
}

// Accept only the three known status values; anything else (missing,
// malformed, hand-edited garbage) is treated as absent, which isTaskLive()
// then reads as 'live' -- backward compat, never fail-closed on a config typo.
function parseTaskStatus(raw: unknown): 'draft' | 'pending_review' | 'live' | undefined {
  return raw === 'draft' || raw === 'pending_review' || raw === 'live' ? raw : undefined
}

// Only a finite number is a policy; anything else (string, null, NaN) is
// treated as absent so a malformed config falls back to the built-in default
// instead of disabling a guard by accident.
export function parseFiniteMinutes(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

// Same acceptance rule, kept as a named export because the catch-up call sites
// and tests predate the generic helper (range semantics live downstream in
// catchUpMaxAgeMs / resolveStuckTimeoutMs, not here).
export function parseCatchUpMaxAge(raw: unknown): number | undefined {
  return parseFiniteMinutes(raw)
}

// Accept only a string array for requires.mcp_servers; anything else is
// treated as absent so a malformed config cannot wedge the runner.
export function parseRequires(raw: { mcp_servers?: unknown } | undefined): ScheduledTask['requires'] {
  if (!raw || !Array.isArray(raw.mcp_servers)) return undefined
  const servers = raw.mcp_servers.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  return servers.length ? { mcp_servers: servers } : undefined
}

// Seed the DB from the file system if the schedules table is empty.
// Uses INSERT OR IGNORE so re-running at startup never overwrites a row that
// was hand-edited in the DB since the last boot.
// Returns the number of newly inserted rows (0 on a warm boot with seeded DB).
export function seedSchedulesFromFilesIfEmpty(): number {
  if (countSchedules() > 0) return 0
  const fileTasks = listScheduledTasksFromFiles()
  let inserted = 0
  for (const task of fileTasks) {
    const seeded = seedScheduleIfAbsent(task.name, {
      prompt:                   task.prompt,
      description:              task.description,
      schedule:                 task.schedule,
      agent:                    task.agent,
      type:                     task.type ?? 'task',
      enabled:                  task.enabled,
      tenant_id:                task.tenantId ?? 'default',
      skip_if_busy:             task.skipIfBusy ?? false,
      force_send:               task.forceSend ?? false,
      target_session:           task.targetSession ?? null,
      status:                   task.status ?? 'live',
      command:                  task.command ?? null,
      timeout_ms:               task.timeoutMs ?? null,
      fail_threshold:           task.failThreshold ?? null,
      pre_check:                task.preCheck ?? null,
      catch_up_max_age_minutes: task.catchUpMaxAgeMinutes ?? null,
      stuck_after_minutes:      task.stuckAfterMinutes ?? null,
      requires:                 task.requires ? JSON.stringify(task.requires) : null,
      created_at:               task.createdAt || undefined,
    })
    if (seeded) inserted++
  }
  return inserted
}

// Returns all tasks for the scheduler (no tenant filter -- runner sees all).
// DB is the primary source once it has been seeded by the migration script;
// falls back to the file system so the runner keeps firing during the
// transition window and after a rollback (just clear the schedules table).
export function listScheduledTasks(): ScheduledTask[] {
  if (countSchedules() > 0) {
    return listSchedulesFromDb().map(rowToTask)
  }
  return listScheduledTasksFromFiles()
}

/** Names of the DB schedules that are enabled AND live. Reads the DB row
 *  itself (never the task-config.json mirror), so it is the scheduler's baseline
 *  of what SHOULD be running no matter how the tick's own task list was read. */
export function listDbRunnableTaskNames(): string[] {
  return listSchedulesFromDb()
    .map(rowToTask)
    .filter(t => t.enabled && isTaskLive(t))
    .map(t => t.name)
}

// File-system fallback (unchanged original logic, kept for transition/rollback).
export function listScheduledTasksFromFiles(): ScheduledTask[] {
  if (!existsSync(SCHEDULED_TASKS_DIR)) return []
  const dirs = readdirSync(SCHEDULED_TASKS_DIR).filter(f => {
    try { return statSync(join(SCHEDULED_TASKS_DIR, f)).isDirectory() } catch { return false }
  })
  const tasks: ScheduledTask[] = []
  for (const d of dirs) {
    const task = readScheduledTask(d)
    if (task) tasks.push(task)
  }
  return tasks.sort((a, b) => b.createdAt - a.createdAt)
}

// Exported so route handlers returning DB rows over the API can map them to
// the same { name, ... } shape the file-based branch has always returned
// (DB rows key on `id`, not `name` -- see the writeScheduledTask note below
// for the sibling bug this shape mismatch is a cousin of).
export function rowToTask(row: ScheduleRow): ScheduledTask {
  return {
    name: row.id,
    description: row.description,
    prompt: row.prompt,
    schedule: row.schedule,
    agent: row.agent,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    type: row.type,
    skipIfBusy: row.skip_if_busy === 1,
    forceSend: row.force_send === 1,
    targetSession: row.target_session ?? undefined,
    command: row.command ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    failThreshold: row.fail_threshold ?? undefined,
    tenantId: row.tenant_id ?? 'default',
    preCheck: row.pre_check ?? undefined,
    catchUpMaxAgeMinutes: row.catch_up_max_age_minutes ?? undefined,
    stuckAfterMinutes: row.stuck_after_minutes ?? undefined,
    requires: parseRequires(row.requires ? (() => { try { return JSON.parse(row.requires!) } catch { return undefined } })() : undefined),
    status: row.status,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunResult: row.last_run_result ?? undefined,
  }
}

/**
 * Pull task-config.json's `enabled` back to the DB value. The file is only a
 * mirror of the `schedules` row (the DB is the source of truth, the runner reads
 * it), so a drifted copy misleads anyone reading the file and would re-enable or
 * disable a task on a DB-less rollback. Only `enabled` is touched: the key is
 * rewritten in place, every other key and the SKILL.md stay byte-for-byte; a
 * missing or unparseable file is left alone (the mirror is never created here).
 * Returns the names of the tasks whose file was rewritten.
 */
export function syncTaskConfigEnabledFromDb(
  rows: ReadonlyArray<Pick<ScheduleRow, 'id' | 'enabled'>> = listSchedulesFromDb(),
  dir: string = SCHEDULED_TASKS_DIR,
): string[] {
  const fixed: string[] = []
  for (const row of rows) {
    const configPath = join(dir, row.id, 'task-config.json')
    let config: Record<string, unknown>
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      config = parsed as Record<string, unknown>
    } catch { continue }
    const want = row.enabled === 1
    if (config.enabled === want) continue
    config.enabled = want
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
    fixed.push(row.id)
  }
  return fixed
}

export function writeScheduledTask(
  taskName: string,
  data: {
    description?: string; prompt?: string; schedule?: string; agent?: string;
    enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean;
    targetSession?: string; command?: string; timeoutMs?: number; failThreshold?: number;
    preCheck?: string; catchUpMaxAgeMinutes?: number; stuckAfterMinutes?: number;
    tenantId?: string | null; requires?: { mcp_servers?: string[] };
    status?: 'draft' | 'pending_review' | 'live';
  },
): void {
  const dbRow = countSchedules() > 0 ? getScheduleFromDb(taskName) : null
  const existing = dbRow ? rowToTask(dbRow) : (countSchedules() > 0 ? null : readScheduledTask(taskName))

  const merged = {
    prompt:                   data.prompt                   ?? existing?.prompt                   ?? '',
    description:              data.description              ?? existing?.description              ?? '',
    schedule:                 data.schedule                 ?? existing?.schedule                 ?? '0 9 * * *',
    agent:                    data.agent                    ?? existing?.agent                    ?? MAIN_AGENT_ID,
    type:                     (data.type as 'task' | 'heartbeat' | 'command') ?? existing?.type ?? 'task',
    enabled:                  data.enabled                  ?? existing?.enabled                  ?? true,
    skip_if_busy:             data.skipIfBusy               ?? existing?.skipIfBusy               ?? false,
    force_send:               data.forceSend                ?? existing?.forceSend                ?? false,
    target_session:           data.targetSession            ?? existing?.targetSession            ?? null,
    command:                  data.command                  ?? existing?.command                  ?? null,
    timeout_ms:               data.timeoutMs                ?? existing?.timeoutMs                ?? null,
    fail_threshold:           data.failThreshold            ?? existing?.failThreshold            ?? null,
    pre_check:                data.preCheck                 ?? existing?.preCheck                 ?? null,
    catch_up_max_age_minutes: data.catchUpMaxAgeMinutes     ?? existing?.catchUpMaxAgeMinutes     ?? null,
    stuck_after_minutes:      data.stuckAfterMinutes        ?? existing?.stuckAfterMinutes        ?? null,
    requires:                 data.requires !== undefined
                                ? (data.requires ? JSON.stringify(data.requires) : null)
                                : (existing?.requires ? JSON.stringify(existing.requires) : null),
    // A task always has a tenant. An edit that names none (toggle's file-mirror call, the PUT
    // edit handler) keeps the stored one, and a stored NULL (a row older than migration 0066)
    // reads as 'default', so a write can never put a task back into "no tenant".
    tenant_id:                data.tenantId ?? existing?.tenantId ?? 'default',
    status:                   data.status ?? existing?.status ?? 'live',
  }

  upsertSchedule(taskName, merged)

  // Keep files in sync as safety-net (allows rollback: just clear the DB table).
  _writeScheduledTaskFiles(taskName, merged)
}

function _writeScheduledTaskFiles(
  taskName: string,
  merged: {
    prompt: string; description: string; schedule: string; agent: string;
    type: string; enabled: boolean; skip_if_busy: boolean; force_send: boolean;
    target_session: string | null | undefined; command: string | null | undefined;
    timeout_ms: number | null | undefined; fail_threshold: number | null | undefined;
    pre_check: string | null | undefined; catch_up_max_age_minutes: number | null | undefined;
    stuck_after_minutes: number | null | undefined;
    tenant_id?: string | null;
    status?: 'draft' | 'pending_review' | 'live';
  },
): void {
  const dir = join(SCHEDULED_TASKS_DIR, taskName)
  mkdirSync(dir, { recursive: true })
  const skillContent = `---\nname: ${taskName}\ndescription: ${merged.description}\n---\n\n${merged.prompt}\n`
  atomicWriteFileSync(join(dir, 'SKILL.md'), skillContent)
  const config: Record<string, unknown> = {
    schedule:              merged.schedule,
    agent:                 merged.agent,
    enabled:               merged.enabled,
    type:                  merged.type,
    skipIfBusy:            merged.skip_if_busy,
    forceSend:             merged.force_send,
    description:           merged.description,
    status:                merged.status ?? 'live',
    tenantId:              merged.tenant_id ?? 'default',
    createdAt:             Math.floor(Date.now() / 1000),
  }
  if (merged.target_session)           config.targetSession           = merged.target_session
  if (merged.command)                  config.command                 = merged.command
  if (merged.timeout_ms != null)       config.timeoutMs               = merged.timeout_ms
  if (merged.fail_threshold != null)   config.failThreshold           = merged.fail_threshold
  if (merged.pre_check)                config.preCheck                = merged.pre_check
  if (merged.catch_up_max_age_minutes != null) config.catchUpMaxAgeMinutes = merged.catch_up_max_age_minutes
  if (merged.stuck_after_minutes != null) config.stuckAfterMinutes    = merged.stuck_after_minutes
  atomicWriteFileSync(join(dir, 'task-config.json'), JSON.stringify(config, null, 2))
}

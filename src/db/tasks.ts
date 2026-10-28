// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { AgentMessage } from './agents.js'
import { db } from './connection.js'
import { dbx } from './facade.js'
import { resolveWriteTenant } from './write-tenant.js'
import { countScheduleRun } from '../otel-signals.js'
import { stripGeneratedHeader } from '../skill-header.js'
import { sanitizeSkillFileMode } from '../skill-files.js'

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export async function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): Promise<void> {
  await dbx.run('INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = Math.floor(Date.now() / 1000)
  return dbx.all<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?", now)
}

export async function updateTaskAfterRun(id: string, nextRun: number, result: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run('UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?', now, nextRun, result, id)
}

export async function listTasks(): Promise<ScheduledTask[]> {
  return dbx.all<ScheduledTask>('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
}

export async function deleteTask(id: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM scheduled_tasks WHERE id = ?', id)).changes > 0
}

export async function pauseTask(id: string): Promise<boolean> {
  return (
    (await dbx.run("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?", id)).changes > 0
  )
}

export async function resumeTask(id: string): Promise<boolean> {
  return (
    (await dbx.run("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?", id)).changes > 0
  )
}

export async function getTask(id: string): Promise<ScheduledTask | undefined> {
  return dbx.get<| ScheduledTask>('SELECT * FROM scheduled_tasks WHERE id = ?', id)
}

export async function updateTask(id: string, prompt: string, schedule: string, nextRun: number): Promise<boolean> {
  return (await dbx.run('UPDATE scheduled_tasks SET prompt = ?, schedule = ?, next_run = ? WHERE id = ?', prompt, schedule, nextRun, id)).changes > 0
}

export interface TaskRunEntry { name: string; agent: string; ts: number; status: string }

export interface TaskRunHistoryEntry { ts: number; status: string; tokens_est: number | null }

const TASK_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export async function appendTaskRun(name: string, agent: string, status = 'fired'): Promise<void> {
  const now = Date.now()
  // A scheduled run belongs to the tenant of its schedule; a name with no schedule row (an ad-hoc
  // or legacy task) falls back to the tenant the agent is working for.
  const schedule = await dbx.get<{ tenant_id: string | null }>('SELECT tenant_id FROM schedules WHERE id = ?', name)
  const tenantId = schedule?.tenant_id ?? await resolveWriteTenant(agent)
  await dbx.run('INSERT INTO task_runs (name, agent, ts, status, tenant_id) VALUES (?, ?, ?, ?, ?)', name, agent, now, status, tenantId)
  countScheduleRun(name, status)
  // Opportunistic TTL prune: cheap indexed DELETE, keeps the table bounded.
  await dbx.run('DELETE FROM task_runs WHERE ts < ?', now - TASK_RUN_TTL_MS)
}

export function listTaskRunHistory(name: string, limit: number): TaskRunHistoryEntry[] {
  const rows = db.prepare(
    'SELECT ts, status, agent FROM task_runs WHERE name = ? ORDER BY ts DESC LIMIT ?'
  ).all(name, limit) as { ts: number; status: string; agent: string }[]

  // token_usage.timestamp is in seconds; task_runs.ts is in ms -- divide by 1000
  const tokenStmt = db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens), 0) as total
     FROM token_usage WHERE agent = ? AND timestamp >= ? AND timestamp < ?`
  )

  // Rows are DESC (newest first). For each run, approximate token usage as
  // the sum for that agent in the window [ts, next_newer_ts) capped at 1 hour.
  return rows.map((row, i) => {
    const newerTs = i > 0 ? rows[i - 1].ts : undefined
    const windowEnd = newerTs !== undefined ? Math.min(row.ts + 3600000, newerTs) : row.ts + 3600000
    const tokenRow = tokenStmt.get(row.agent, Math.floor(row.ts / 1000), Math.floor(windowEnd / 1000)) as { total: number }
    return { ts: row.ts, status: row.status, tokens_est: tokenRow.total > 0 ? tokenRow.total : null }
  })
}

// tenantId, when provided, narrows the count to runs of schedules that belong to that
// tenant (schedules.tenant_id, matched by task name). The run's agent says nothing about
// the tenant: a shared agent serves several. A run whose schedule has since been deleted
// belongs to no tenant, so it only shows in the unfiltered, fleet-wide count.
export async function countTaskRunsBetween(fromTs: number, toTs?: number, tenantId?: string): Promise<number> {
  const conditions = ['ts >= ?']
  const params: (number | string)[] = [fromTs]
  if (toTs !== undefined) { conditions.push('ts < ?'); params.push(toTs) }
  if (tenantId !== undefined) {
    conditions.push('name IN (SELECT id FROM schedules WHERE tenant_id = ?)')
    params.push(tenantId)
  }
  const row = (await dbx.get(`SELECT COUNT(*) as c FROM task_runs WHERE ${conditions.join(' AND ')}`, ...params)) as { c: number }
  return row.c
}

export async function getAgentMessage(id: number): Promise<AgentMessage | undefined> {
  return dbx.get<AgentMessage>('SELECT * FROM agent_messages WHERE id = ?', id)
}

export async function getActiveScheduledTaskCount(): Promise<{ count: number; nextRun: number | null }> {
  const row = (await dbx.get("SELECT COUNT(*) as count, MIN(next_run) as next_run FROM scheduled_tasks WHERE status = 'active'")) as { count: number; next_run: number | null }
  return { count: row.count, nextRun: row.next_run }
}

export interface PendingTaskRetryRow {
  id: number
  task_name: string
  agent_name: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  last_reason: string | null
  alert_sent_at: number | null
}

/**
 * Insert a busy-skipped scheduled task into the retry queue if and only if
 * no row exists for the (task_name, agent_name) pair. Returns true on
 * insert, false if a row already existed. Used for the first "busy" hit
 * from the cron loop.
 */
export async function insertPendingTaskRetryIfNew(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): Promise<boolean> {
  return (await dbx.run(`
    INSERT INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT DO NOTHING
  `, taskName, agentName, now, now, reason)).changes > 0
}

/**
 * Update an existing retry row's last_attempt / attempt_count / last_reason.
 * Returns true if a row was updated, false if none existed (e.g. the
 * operator cancelled the row between a tick loading it and this call).
 * Used from the retry loop so a cancelled row isn't silently re-created.
 */
export async function updatePendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): Promise<boolean> {
  return (await dbx.run(`
    UPDATE pending_task_retries
       SET last_attempt = ?,
           attempt_count = attempt_count + 1,
           last_reason = ?
     WHERE task_name = ? AND agent_name = ?
  `, now, reason, taskName, agentName)).changes > 0
}

/** Back-compat shim used by tests written against the original upsert
 * semantics. Internal code should use the explicit insert-if-new /
 * update-if-exists pair above. */
export async function upsertPendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): Promise<void> {
  if (!await updatePendingTaskRetry(taskName, agentName, now, reason)) {
    await insertPendingTaskRetryIfNew(taskName, agentName, now, reason)
  }
}

/** Clear the alert timestamp so the next tick is free to re-alert. Used
 * when a Telegram send failed after we stamped the row optimistically. */
export async function clearPendingTaskRetryAlert(taskName: string, agentName: string): Promise<boolean> {
  return (await dbx.run('UPDATE pending_task_retries SET alert_sent_at = NULL WHERE task_name = ? AND agent_name = ?', taskName, agentName)).changes > 0
}

export async function listPendingTaskRetries(): Promise<PendingTaskRetryRow[]> {
  return dbx.all<PendingTaskRetryRow>('SELECT * FROM pending_task_retries ORDER BY first_attempt ASC')
}

export async function getPendingTaskRetry(taskName: string, agentName: string): Promise<PendingTaskRetryRow | undefined> {
  return dbx.get<PendingTaskRetryRow>('SELECT * FROM pending_task_retries WHERE task_name = ? AND agent_name = ?', taskName, agentName)
}

export async function deletePendingTaskRetry(taskName: string, agentName: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM pending_task_retries WHERE task_name = ? AND agent_name = ?', taskName, agentName)).changes > 0
}

export async function deletePendingTaskRetryById(id: number): Promise<boolean> {
  return (await dbx.run('DELETE FROM pending_task_retries WHERE id = ?', id)).changes > 0
}

export async function markPendingTaskRetryAlert(taskName: string, agentName: string, ts: number): Promise<boolean> {
  return (await dbx.run('UPDATE pending_task_retries SET alert_sent_at = ? WHERE task_name = ? AND agent_name = ? AND alert_sent_at IS NULL', ts, taskName, agentName)).changes > 0
}

export interface ScheduleRow {
  id: string
  prompt: string
  description: string
  schedule: string
  agent: string
  type: 'task' | 'heartbeat' | 'command'
  enabled: number
  tenant_id: string
  skip_if_busy: number
  force_send: number
  target_session: string | null
  command: string | null
  timeout_ms: number | null
  fail_threshold: number | null
  pre_check: string | null
  catch_up_max_age_minutes: number | null
  stuck_after_minutes: number | null
  requires: string | null   // JSON blob
  status: 'draft' | 'pending_review' | 'live'
  last_run_at: number | null      // migration 0057
  last_run_result: string | null  // migration 0057
  created_at: number
  updated_at: number
}

export async function countSchedules(): Promise<number> {
  const row = (await dbx.get('SELECT COUNT(*) as n FROM schedules')) as { n: number }
  return row.n
}

/** Schedules of one tenant, or every schedule when no tenant is given (an unfiltered admin view, the runner). */
export async function listSchedulesFromDb(opts: { tenantId?: string | null } = {}): Promise<ScheduleRow[]> {
  if (opts.tenantId !== undefined && opts.tenantId !== null) {
    // Only this tenant's tasks (tenant_id is NOT NULL since migration 0076).
    return dbx.all<ScheduleRow>('SELECT * FROM schedules WHERE tenant_id = ? ORDER BY created_at DESC', opts.tenantId)
  }
  return dbx.all<ScheduleRow>('SELECT * FROM schedules ORDER BY created_at DESC')
}

export async function getScheduleFromDb(id: string): Promise<ScheduleRow | undefined> {
  return dbx.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id)
}

export interface UpsertScheduleOpts {
  prompt: string
  description: string
  schedule: string
  agent: string
  type: 'task' | 'heartbeat' | 'command'
  enabled: boolean
  tenant_id: string | null
  skip_if_busy: boolean
  force_send: boolean
  target_session?: string | null
  command?: string | null
  timeout_ms?: number | null
  fail_threshold?: number | null
  pre_check?: string | null
  catch_up_max_age_minutes?: number | null
  stuck_after_minutes?: number | null
  requires?: string | null
  status?: 'draft' | 'pending_review' | 'live'
  created_at?: number
}

export async function upsertSchedule(id: string, opts: UpsertScheduleOpts): Promise<ScheduleRow> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO schedules (
      id, prompt, description, schedule, agent, type, enabled, tenant_id,
      skip_if_busy, force_send, target_session, command, timeout_ms, fail_threshold,
      pre_check, catch_up_max_age_minutes, stuck_after_minutes, requires, status,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      prompt                   = excluded.prompt,
      description              = excluded.description,
      schedule                 = excluded.schedule,
      agent                    = excluded.agent,
      type                     = excluded.type,
      enabled                  = excluded.enabled,
      tenant_id                = excluded.tenant_id,
      skip_if_busy             = excluded.skip_if_busy,
      force_send               = excluded.force_send,
      target_session           = excluded.target_session,
      command                  = excluded.command,
      timeout_ms               = excluded.timeout_ms,
      fail_threshold           = excluded.fail_threshold,
      pre_check                = excluded.pre_check,
      catch_up_max_age_minutes = excluded.catch_up_max_age_minutes,
      stuck_after_minutes      = excluded.stuck_after_minutes,
      requires                 = excluded.requires,
      status                   = excluded.status,
      updated_at               = excluded.updated_at
  `, id, opts.prompt, opts.description, opts.schedule, opts.agent,
    opts.type, opts.enabled ? 1 : 0, opts.tenant_id ?? 'default',
    opts.skip_if_busy ? 1 : 0, opts.force_send ? 1 : 0,
    opts.target_session ?? null, opts.command ?? null,
    opts.timeout_ms ?? null, opts.fail_threshold ?? null,
    opts.pre_check ?? null, opts.catch_up_max_age_minutes ?? null,
    opts.stuck_after_minutes ?? null, opts.requires ?? null, opts.status ?? 'live',
    opts.created_at ?? now, now,
  )
  return (await dbx.get('SELECT * FROM schedules WHERE id = ?', id)) as ScheduleRow
}

const PATCH_SCHEDULE_ALLOWED_COLS = new Set([
  'prompt', 'description', 'schedule', 'agent', 'type', 'enabled', 'tenant_id',
  'skip_if_busy', 'force_send', 'target_session', 'command', 'timeout_ms',
  'fail_threshold', 'pre_check', 'catch_up_max_age_minutes', 'stuck_after_minutes', 'requires',
  'status',
])

// Move a schedule from draft/pending_review to live. The only mutation the
// human-admin-only PUT /api/schedules/:name/activate route performs --
// separate from patchSchedule so the activation path can never accidentally
// touch any other column.
export async function activateSchedule(id: string): Promise<ScheduleRow | null> {
  const existing = await getScheduleFromDb(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  await dbx.run("UPDATE schedules SET status = 'live', updated_at = ? WHERE id = ?", now, id)
  return (await dbx.get('SELECT * FROM schedules WHERE id = ?', id)) as ScheduleRow
}

export async function patchSchedule(id: string, patch: Partial<Omit<UpsertScheduleOpts, 'created_at'>>): Promise<ScheduleRow | null> {
  const existing = await getScheduleFromDb(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  const boolCols = new Set(['enabled', 'skip_if_busy', 'force_send'])
  for (const [k, v] of Object.entries(patch)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase()
    if (!PATCH_SCHEDULE_ALLOWED_COLS.has(col)) continue
    sets.push(`${col} = ?`)
    vals.push(boolCols.has(col) && typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null))
  }
  vals.push(id)
  await dbx.run(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`, ...vals)
  return (await dbx.get('SELECT * FROM schedules WHERE id = ?', id)) as ScheduleRow
}

export async function deleteSchedule(id: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM schedules WHERE id = ?', id)).changes > 0
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now, id)).changes > 0
}

// Migration 0057: replaces the schedule-runner's in-memory scheduleLastRun
// Map + store/schedule-last-run.json persistence. Deliberately does NOT
// touch updated_at (that column tracks operator edits to the schedule's own
// config, not runner-driven fire bookkeeping). A no-op (changes === 0) is
// expected and harmless when the runner fires a schedule id that has since
// been deleted from the table -- same as the old file-backed map, which
// happily kept stamps for ids with no corresponding schedule.
export async function updateScheduleLastRun(id: string, lastRunAt: number, result: string | null = null): Promise<boolean> {
  return (await dbx.run('UPDATE schedules SET last_run_at = ?, last_run_result = ? WHERE id = ?', lastRunAt, result, id)).changes > 0
}

// Conditional clear used by the 'lost injection' rollback path: only clears
// if last_run_at still equals the stamp this caller itself wrote (nothing
// newer has fired in the meantime). Atomic in SQL, replacing the old
// Map.get-then-delete + file-persist pair.
export async function clearScheduleLastRunIfMatches(id: string, expectedLastRunAt: number): Promise<boolean> {
  return (await dbx.run('UPDATE schedules SET last_run_at = NULL, last_run_result = NULL WHERE id = ? AND last_run_at = ?', id, expectedLastRunAt)).changes > 0
}

// One-time import of store/schedule-last-run.json into the last_run_at
// column this migration added, mirroring migrateConfigOverridesToSystemConfig()'s
// shape (called from db/index.ts's initDatabase(), same every-boot-but-
// effectively-once semantics). Only ever writes a schedule's last_run_at
// when it is still NULL, so an operator action or a later runner tick that
// already set it is never clobbered by a stale JSON value re-imported after
// a restart. Entries for a schedule id no longer present in the table are
// silently skipped (the UPDATE simply matches zero rows) rather than
// resurrected as new schedule rows -- inventing prompt/schedule/agent values
// for a soft-deleted schedule would pollute the live admin UI with rows that
// have no other content.
export function migrateScheduleLastRunFromFile(entries: Record<string, unknown>): number {
  let migrated = 0
  const stmt = db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ? AND last_run_at IS NULL')
  for (const [id, ts] of Object.entries(entries)) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
    if (stmt.run(ts, id).changes > 0) migrated++
  }
  return migrated
}

// INSERT OR IGNORE: seed a schedule from file only if it does not already exist
// in the DB. Safe to run on every boot -- never overwrites hand-edited rows.
const SCHEDULE_TYPES = ['task', 'heartbeat', 'command']

export async function seedScheduleIfAbsent(id: string, opts: UpsertScheduleOpts): Promise<boolean> {
  // The options come from task files on disk. A row the table would reject
  // (NOT NULL schedule/agent, CHECK on type) is skipped like an existing one;
  // ON CONFLICT DO NOTHING only absorbs key conflicts, not constraint errors.
  if (opts.schedule == null || opts.agent == null || !SCHEDULE_TYPES.includes(opts.type)) return false
  const now = opts.created_at ?? Math.floor(Date.now() / 1000)
  const result = await dbx.run(`
    INSERT INTO schedules (
      id, prompt, description, schedule, agent, type, enabled, tenant_id,
      skip_if_busy, force_send, target_session, command, timeout_ms, fail_threshold,
      pre_check, catch_up_max_age_minutes, stuck_after_minutes, requires, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, id, opts.prompt, opts.description, opts.schedule, opts.agent,
    opts.type, opts.enabled ? 1 : 0, opts.tenant_id ?? 'default',
    opts.skip_if_busy ? 1 : 0, opts.force_send ? 1 : 0,
    opts.target_session ?? null, opts.command ?? null,
    opts.timeout_ms ?? null, opts.fail_threshold ?? null,
    opts.pre_check ?? null, opts.catch_up_max_age_minutes ?? null,
    opts.stuck_after_minutes ?? null, opts.requires ?? null, opts.status ?? 'live',
    now, now,
  )
  return result.changes > 0  // true = newly inserted, false = already existed (skipped)
}


export interface SkillRow {
  id: string
  name: string
  description: string
  content: string
  tenant_id: string
  is_global: number
  created_by: string | null
  created_at: number
  updated_at: number
}

export interface CreateSkillOpts {
  id: string
  name: string
  description?: string
  content: string
  tenant_id: string
  is_global?: boolean
  created_by?: string | null
}

export async function createSkill(opts: CreateSkillOpts): Promise<SkillRow> {
  opts = { ...opts, content: stripGeneratedHeader(opts.content) }
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, opts.id, opts.name, opts.description ?? '', opts.content,
    opts.tenant_id, opts.is_global ? 1 : 0, opts.created_by ?? null, now, now,
  )
  return await getSkill(opts.id) as SkillRow
}

export async function getSkill(id: string): Promise<SkillRow | undefined> {
  return dbx.get<SkillRow>('SELECT * FROM skills WHERE id = ?', id)
}

/** True when the agent has an enabled availability row for one of the tenants (skill-sync's qualification check). */
export async function agentHasEnabledAvailability(agentId: string, tenantIds: readonly string[]): Promise<boolean> {
  if (tenantIds.length === 0) return false
  const placeholders = tenantIds.map(() => '?').join(',')
  return await dbx.get(`SELECT 1 FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1 AND tenant_id IN (${placeholders})`, agentId, ...tenantIds) !== undefined
}

/** Write-back of an edited SKILL.md: sets the content of an existing skill row (the caller strips the generated header). */
export async function setSkillContent(skillId: string, content: string, now: number): Promise<void> {
  await dbx.run('UPDATE skills SET content = ?, updated_at = ? WHERE id = ?', content, now, skillId)
}

/** Write-back of a SKILL.md that has no row yet: creates it as a fleet skill (global/... ids are global). */
export async function insertFleetSkillFromFile(skillId: string, name: string, content: string, isGlobal: boolean, now: number): Promise<void> {
  await dbx.run(`
    INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, '', ?, 'fleet', ?, NULL, ?, ?)
  `, skillId, name, content, isGlobal ? 1 : 0, now, now)
}

export async function updateSkill(id: string, patch: { name?: string; description?: string; content?: string; is_global?: boolean }): Promise<SkillRow | undefined> {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        vals.push(patch.name) }
  if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description) }
  if (patch.content !== undefined)     { sets.push('content = ?');     vals.push(stripGeneratedHeader(patch.content)) }
  if (patch.is_global !== undefined)   { sets.push('is_global = ?');   vals.push(patch.is_global ? 1 : 0) }
  vals.push(id)
  const changes = (await dbx.run(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`, ...vals)).changes
  return changes > 0 ? await getSkill(id) : undefined
}

export async function deleteSkill(id: string): Promise<boolean> {
  await dbx.run('DELETE FROM skill_files WHERE skill_id = ?', id)
  return (await dbx.run('DELETE FROM skills WHERE id = ?', id)).changes > 0
}

// --- skill companion files (migration 0063, rules in src/skill-files.ts) ---

export interface SkillFileRow {
  skill_id: string
  rel_path: string
  content: Buffer
  mode: number
  created_at: number
  updated_at: number
}

export async function listSkillFiles(skillId: string): Promise<SkillFileRow[]> {
  return dbx.all<SkillFileRow>('SELECT * FROM skill_files WHERE skill_id = ? ORDER BY rel_path', skillId)
}

export async function getSkillFile(skillId: string, relPath: string): Promise<SkillFileRow | undefined> {
  return dbx.get<SkillFileRow>('SELECT * FROM skill_files WHERE skill_id = ? AND rel_path = ?', skillId, relPath)
}

/** Upsert one companion file. The caller has normalized rel_path and checked the size. */
export async function putSkillFile(skillId: string, relPath: string, content: Buffer, mode?: number): Promise<SkillFileRow> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(skill_id, rel_path) DO UPDATE SET content = excluded.content, mode = excluded.mode, updated_at = excluded.updated_at
  `, skillId, relPath, content, sanitizeSkillFileMode(mode), now, now)
  return await getSkillFile(skillId, relPath) as SkillFileRow
}

/** Insert only when the (skill, path) pair is absent: never overwrites the DB. Returns true when inserted. */
export async function seedSkillFileIfAbsent(skillId: string, relPath: string, content: Buffer, mode?: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run(`
    INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, skillId, relPath, content, sanitizeSkillFileMode(mode), now, now)).changes > 0
}

export async function deleteSkillFile(skillId: string, relPath: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM skill_files WHERE skill_id = ? AND rel_path = ?', skillId, relPath)).changes > 0
}

export async function countSkillFiles(skillId: string): Promise<number> {
  return ((await dbx.get('SELECT COUNT(*) AS n FROM skill_files WHERE skill_id = ?', skillId)) as { n: number }).n
}

/**
 * List skills visible to a caller:
 * - own skills (tenant_id = callerTenantId)
 * - skills explicitly granted via skill_tenant_access
 *
 * Fleet skills (tenant_id = 'fleet') are NOT included unless explicitly
 * granted. Pass callerTenantId = 'fleet' (admin) to see fleet skills.
 */
export async function listSkillsForTenant(callerTenantId: string): Promise<SkillRow[]> {
  return dbx.all<SkillRow>(`
    SELECT s.* FROM skills s
    WHERE s.tenant_id = ?
    UNION
    SELECT s.* FROM skills s
    JOIN skill_tenant_access sta ON sta.skill_id = s.id
    WHERE sta.tenant_id = ?
    ORDER BY name
  `, callerTenantId, callerTenantId)
}

/** Admin: list all skills regardless of tenant. */
export async function listAllSkills(): Promise<SkillRow[]> {
  return dbx.all<SkillRow>('SELECT * FROM skills ORDER BY tenant_id, name')
}

export interface SkillTenantAccessRow {
  skill_id: string
  tenant_id: string
  granted_by: string | null
  granted_at: number
}

export async function grantSkillAccess(skillId: string, tenantId: string, grantedBy?: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by, granted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_id, tenant_id) DO NOTHING
  `, skillId, tenantId, grantedBy ?? null, now)
}

export async function revokeSkillAccess(skillId: string, tenantId: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM skill_tenant_access WHERE skill_id = ? AND tenant_id = ?', skillId, tenantId)).changes > 0
}

export async function listSkillAccess(skillId: string): Promise<SkillTenantAccessRow[]> {
  return dbx.all<SkillTenantAccessRow>('SELECT * FROM skill_tenant_access WHERE skill_id = ?', skillId)
}

// ON CONFLICT DO NOTHING: materialize a file-based skill only if no row with this id
// exists yet. Safe to run repeatedly -- never overwrites hand-edited DB rows.
export async function seedSkillIfAbsent(opts: {
  id: string
  name: string
  description: string
  content: string
  tenant_id: string
  is_global: boolean
  created_at?: number
}): Promise<boolean> {
  // File-derived input: a row the table would reject (NOT NULL name/content/tenant_id)
  // is skipped, since ON CONFLICT DO NOTHING only absorbs key conflicts.
  if (opts.name == null || opts.content == null || opts.tenant_id == null) return false
  const now = opts.created_at ?? Math.floor(Date.now() / 1000)
  const result = await dbx.run(`
    INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT DO NOTHING
  `, opts.id, opts.name, opts.description, stripGeneratedHeader(opts.content), opts.tenant_id, opts.is_global ? 1 : 0, now, now)
  return result.changes > 0
}

export async function countSkills(): Promise<number> {
  return ((await dbx.get('SELECT COUNT(*) AS n FROM skills')) as { n: number }).n
}

/** Skills owned locally by one agent (id prefix 'agent/<agentId>/', per materialize-skills.ts's ID scheme). */
export async function listAgentOwnedSkills(agentId: string): Promise<SkillRow[]> {
  return dbx.all<SkillRow>(`
    SELECT * FROM skills WHERE id LIKE ? ORDER BY name
  `, `agent/${agentId}/%`)
}

/** Global fleet skills (~/.claude/skills), inherited by every agent. */
export async function listGlobalFleetSkills(): Promise<SkillRow[]> {
  return dbx.all<SkillRow>(`
    SELECT * FROM skills WHERE is_global = 1 AND tenant_id = 'fleet' ORDER BY name
  `)
}

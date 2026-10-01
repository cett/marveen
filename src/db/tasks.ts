// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { AgentMessage } from './agents.js'
import { db } from './connection.js'
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

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  db.prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?")
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?'
  ).run(now, nextRun, result, id)
}

export function listTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id).changes > 0
  )
}

export function resumeTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id).changes > 0
  )
}

export function getTask(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined
}

export function updateTask(id: string, prompt: string, schedule: string, nextRun: number): boolean {
  return db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule = ?, next_run = ? WHERE id = ?').run(prompt, schedule, nextRun, id).changes > 0
}

export interface TaskRunEntry { name: string; agent: string; ts: number; status: string }

export interface TaskRunHistoryEntry { ts: number; status: string; tokens_est: number | null }

const TASK_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function appendTaskRun(name: string, agent: string, status = 'fired'): void {
  const now = Date.now()
  db.prepare('INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, ?)').run(name, agent, now, status)
  // Opportunistic TTL prune: cheap indexed DELETE, keeps the table bounded.
  db.prepare('DELETE FROM task_runs WHERE ts < ?').run(now - TASK_RUN_TTL_MS)
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
export function countTaskRunsBetween(fromTs: number, toTs?: number, tenantId?: string): number {
  const conditions = ['ts >= ?']
  const params: (number | string)[] = [fromTs]
  if (toTs !== undefined) { conditions.push('ts < ?'); params.push(toTs) }
  if (tenantId !== undefined) {
    conditions.push('name IN (SELECT id FROM schedules WHERE tenant_id = ?)')
    params.push(tenantId)
  }
  const row = db.prepare(`SELECT COUNT(*) as c FROM task_runs WHERE ${conditions.join(' AND ')}`).get(...params) as { c: number }
  return row.c
}

export function getAgentMessage(id: number): AgentMessage | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage | undefined
}

export function getActiveScheduledTaskCount(): { count: number; nextRun: number | null } {
  const row = db
    .prepare("SELECT COUNT(*) as count, MIN(next_run) as next_run FROM scheduled_tasks WHERE status = 'active'")
    .get() as { count: number; next_run: number | null }
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
export function insertPendingTaskRetryIfNew(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(taskName, agentName, now, now, reason).changes > 0
}

/**
 * Update an existing retry row's last_attempt / attempt_count / last_reason.
 * Returns true if a row was updated, false if none existed (e.g. the
 * operator cancelled the row between a tick loading it and this call).
 * Used from the retry loop so a cancelled row isn't silently re-created.
 */
export function updatePendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    UPDATE pending_task_retries
       SET last_attempt = ?,
           attempt_count = attempt_count + 1,
           last_reason = ?
     WHERE task_name = ? AND agent_name = ?
  `).run(now, reason, taskName, agentName).changes > 0
}

/** Back-compat shim used by tests written against the original upsert
 * semantics. Internal code should use the explicit insert-if-new /
 * update-if-exists pair above. */
export function upsertPendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): void {
  if (!updatePendingTaskRetry(taskName, agentName, now, reason)) {
    insertPendingTaskRetryIfNew(taskName, agentName, now, reason)
  }
}

/** Clear the alert timestamp so the next tick is free to re-alert. Used
 * when a Telegram send failed after we stamped the row optimistically. */
export function clearPendingTaskRetryAlert(taskName: string, agentName: string): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = NULL WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function listPendingTaskRetries(): PendingTaskRetryRow[] {
  return db
    .prepare('SELECT * FROM pending_task_retries ORDER BY first_attempt ASC')
    .all() as PendingTaskRetryRow[]
}

export function getPendingTaskRetry(taskName: string, agentName: string): PendingTaskRetryRow | undefined {
  return db
    .prepare('SELECT * FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .get(taskName, agentName) as PendingTaskRetryRow | undefined
}

export function deletePendingTaskRetry(taskName: string, agentName: string): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function deletePendingTaskRetryById(id: number): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE id = ?')
    .run(id).changes > 0
}

export function markPendingTaskRetryAlert(taskName: string, agentName: string, ts: number): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = ? WHERE task_name = ? AND agent_name = ? AND alert_sent_at IS NULL')
    .run(ts, taskName, agentName).changes > 0
}

export interface ScheduleRow {
  id: string
  prompt: string
  description: string
  schedule: string
  agent: string
  type: 'task' | 'heartbeat' | 'command'
  enabled: number
  tenant_id: string | null
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

export function countSchedules(): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM schedules').get() as { n: number }
  return row.n
}

/** Schedules of one tenant, or every schedule when no tenant is given (an unfiltered admin view, the runner). */
export function listSchedulesFromDb(opts: { tenantId?: string | null } = {}): ScheduleRow[] {
  if (opts.tenantId !== undefined && opts.tenantId !== null) {
    // Only this tenant's tasks. A row with no tenant (older than migration 0066) is the default tenant's.
    return db.prepare("SELECT * FROM schedules WHERE tenant_id = ? OR (tenant_id IS NULL AND ? = 'default') ORDER BY created_at DESC")
      .all(opts.tenantId, opts.tenantId) as ScheduleRow[]
  }
  return db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as ScheduleRow[]
}

export function getScheduleFromDb(id: string): ScheduleRow | undefined {
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined
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

export function upsertSchedule(id: string, opts: UpsertScheduleOpts): ScheduleRow {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
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
  `).run(
    id, opts.prompt, opts.description, opts.schedule, opts.agent,
    opts.type, opts.enabled ? 1 : 0, opts.tenant_id ?? null,
    opts.skip_if_busy ? 1 : 0, opts.force_send ? 1 : 0,
    opts.target_session ?? null, opts.command ?? null,
    opts.timeout_ms ?? null, opts.fail_threshold ?? null,
    opts.pre_check ?? null, opts.catch_up_max_age_minutes ?? null,
    opts.stuck_after_minutes ?? null, opts.requires ?? null, opts.status ?? 'live',
    opts.created_at ?? now, now,
  )
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
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
export function activateSchedule(id: string): ScheduleRow | null {
  const existing = getScheduleFromDb(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE schedules SET status = 'live', updated_at = ? WHERE id = ?").run(now, id)
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
}

export function patchSchedule(id: string, patch: Partial<Omit<UpsertScheduleOpts, 'created_at'>>): ScheduleRow | null {
  const existing = getScheduleFromDb(id)
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
  db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
}

export function deleteSchedule(id: string): boolean {
  return db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
}

export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now, id).changes > 0
}

// Migration 0057: replaces the schedule-runner's in-memory scheduleLastRun
// Map + store/schedule-last-run.json persistence. Deliberately does NOT
// touch updated_at (that column tracks operator edits to the schedule's own
// config, not runner-driven fire bookkeeping). A no-op (changes === 0) is
// expected and harmless when the runner fires a schedule id that has since
// been deleted from the table -- same as the old file-backed map, which
// happily kept stamps for ids with no corresponding schedule.
export function updateScheduleLastRun(id: string, lastRunAt: number, result: string | null = null): boolean {
  return db.prepare('UPDATE schedules SET last_run_at = ?, last_run_result = ? WHERE id = ?')
    .run(lastRunAt, result, id).changes > 0
}

// Conditional clear used by the 'lost injection' rollback path: only clears
// if last_run_at still equals the stamp this caller itself wrote (nothing
// newer has fired in the meantime). Atomic in SQL, replacing the old
// Map.get-then-delete + file-persist pair.
export function clearScheduleLastRunIfMatches(id: string, expectedLastRunAt: number): boolean {
  return db.prepare('UPDATE schedules SET last_run_at = NULL, last_run_result = NULL WHERE id = ? AND last_run_at = ?')
    .run(id, expectedLastRunAt).changes > 0
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
export function seedScheduleIfAbsent(id: string, opts: UpsertScheduleOpts): boolean {
  const now = opts.created_at ?? Math.floor(Date.now() / 1000)
  const result = db.prepare(`
    INSERT OR IGNORE INTO schedules (
      id, prompt, description, schedule, agent, type, enabled, tenant_id,
      skip_if_busy, force_send, target_session, command, timeout_ms, fail_threshold,
      pre_check, catch_up_max_age_minutes, stuck_after_minutes, requires, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.prompt, opts.description, opts.schedule, opts.agent,
    opts.type, opts.enabled ? 1 : 0, opts.tenant_id ?? null,
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

export function createSkill(opts: CreateSkillOpts): SkillRow {
  opts = { ...opts, content: stripGeneratedHeader(opts.content) }
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id, opts.name, opts.description ?? '', opts.content,
    opts.tenant_id, opts.is_global ? 1 : 0, opts.created_by ?? null, now, now,
  )
  return getSkill(opts.id) as SkillRow
}

export function getSkill(id: string): SkillRow | undefined {
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined
}

export function updateSkill(id: string, patch: { name?: string; description?: string; content?: string; is_global?: boolean }): SkillRow | undefined {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        vals.push(patch.name) }
  if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description) }
  if (patch.content !== undefined)     { sets.push('content = ?');     vals.push(stripGeneratedHeader(patch.content)) }
  if (patch.is_global !== undefined)   { sets.push('is_global = ?');   vals.push(patch.is_global ? 1 : 0) }
  vals.push(id)
  const changes = db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes
  return changes > 0 ? getSkill(id) : undefined
}

export function deleteSkill(id: string): boolean {
  db.prepare('DELETE FROM skill_files WHERE skill_id = ?').run(id)
  return db.prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0
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

export function listSkillFiles(skillId: string): SkillFileRow[] {
  return db.prepare('SELECT * FROM skill_files WHERE skill_id = ? ORDER BY rel_path').all(skillId) as SkillFileRow[]
}

export function getSkillFile(skillId: string, relPath: string): SkillFileRow | undefined {
  return db.prepare('SELECT * FROM skill_files WHERE skill_id = ? AND rel_path = ?').get(skillId, relPath) as SkillFileRow | undefined
}

/** Upsert one companion file. The caller has normalized rel_path and checked the size. */
export function putSkillFile(skillId: string, relPath: string, content: Buffer, mode?: number): SkillFileRow {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(skill_id, rel_path) DO UPDATE SET content = excluded.content, mode = excluded.mode, updated_at = excluded.updated_at
  `).run(skillId, relPath, content, sanitizeSkillFileMode(mode), now, now)
  return getSkillFile(skillId, relPath) as SkillFileRow
}

/** Insert only when the (skill, path) pair is absent: never overwrites the DB. Returns true when inserted. */
export function seedSkillFileIfAbsent(skillId: string, relPath: string, content: Buffer, mode?: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    INSERT OR IGNORE INTO skill_files (skill_id, rel_path, content, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(skillId, relPath, content, sanitizeSkillFileMode(mode), now, now).changes > 0
}

export function deleteSkillFile(skillId: string, relPath: string): boolean {
  return db.prepare('DELETE FROM skill_files WHERE skill_id = ? AND rel_path = ?').run(skillId, relPath).changes > 0
}

export function countSkillFiles(skillId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM skill_files WHERE skill_id = ?').get(skillId) as { n: number }).n
}

/**
 * List skills visible to a caller:
 * - own skills (tenant_id = callerTenantId)
 * - skills explicitly granted via skill_tenant_access
 *
 * Fleet skills (tenant_id = 'fleet') are NOT included unless explicitly
 * granted. Pass callerTenantId = 'fleet' (admin) to see fleet skills.
 */
export function listSkillsForTenant(callerTenantId: string): SkillRow[] {
  return db.prepare(`
    SELECT s.* FROM skills s
    WHERE s.tenant_id = ?
    UNION
    SELECT s.* FROM skills s
    JOIN skill_tenant_access sta ON sta.skill_id = s.id
    WHERE sta.tenant_id = ?
    ORDER BY name
  `).all(callerTenantId, callerTenantId) as SkillRow[]
}

/** Admin: list all skills regardless of tenant. */
export function listAllSkills(): SkillRow[] {
  return db.prepare('SELECT * FROM skills ORDER BY tenant_id, name').all() as SkillRow[]
}

export interface SkillTenantAccessRow {
  skill_id: string
  tenant_id: string
  granted_by: string | null
  granted_at: number
}

export function grantSkillAccess(skillId: string, tenantId: string, grantedBy?: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by, granted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_id, tenant_id) DO NOTHING
  `).run(skillId, tenantId, grantedBy ?? null, now)
}

export function revokeSkillAccess(skillId: string, tenantId: string): boolean {
  return db.prepare('DELETE FROM skill_tenant_access WHERE skill_id = ? AND tenant_id = ?').run(skillId, tenantId).changes > 0
}

export function listSkillAccess(skillId: string): SkillTenantAccessRow[] {
  return db.prepare('SELECT * FROM skill_tenant_access WHERE skill_id = ?').all(skillId) as SkillTenantAccessRow[]
}

// INSERT OR IGNORE: materialize a file-based skill only if no row with this id
// exists yet. Safe to run repeatedly -- never overwrites hand-edited DB rows.
export function seedSkillIfAbsent(opts: {
  id: string
  name: string
  description: string
  content: string
  tenant_id: string
  is_global: boolean
  created_at?: number
}): boolean {
  const now = opts.created_at ?? Math.floor(Date.now() / 1000)
  const result = db.prepare(`
    INSERT OR IGNORE INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(opts.id, opts.name, opts.description, stripGeneratedHeader(opts.content), opts.tenant_id, opts.is_global ? 1 : 0, now, now)
  return result.changes > 0
}

export function countSkills(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n
}

/** Skills owned locally by one agent (id prefix 'agent/<agentId>/', per materialize-skills.ts's ID scheme). */
export function listAgentOwnedSkills(agentId: string): SkillRow[] {
  return db.prepare(`
    SELECT * FROM skills WHERE id LIKE ? ORDER BY name
  `).all(`agent/${agentId}/%`) as SkillRow[]
}

/** Global fleet skills (~/.claude/skills), inherited by every agent. */
export function listGlobalFleetSkills(): SkillRow[] {
  return db.prepare(`
    SELECT * FROM skills WHERE is_global = 1 AND tenant_id = 'fleet' ORDER BY name
  `).all() as SkillRow[]
}

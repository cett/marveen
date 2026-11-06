// Dead-letter admin view: scheduled occurrences that did not run, in one list (GET /api/schedules/dead-letter).
//
// Two halves, one list, newest first:
//   kind 'run'     task_runs rows in the window whose status is a non-start (see DEAD_LETTER_RUN_STATUSES)
//   kind 'pending' the pending_task_retries rows that exist NOW (giveup, lane-busy, lost-injection, busy-skip, ...)
//
// Read-only. It writes nothing and adds no task_runs status: a `giveup` / `lane-busy` outcome keeps living only in
// pending_task_retries (a new status would change the run-history UI, the OTel `marveen.schedule.runs` label
// cardinality and the history view). One consequence, by design: a giveup that was RESOLVED (the retry later
// succeeded, the row was deleted) is not shown. The view is the open set plus the 30-day run history.
//
// Only fields that come out of those two tables are returned: no prompt, no session name, no command.

import type { PendingTaskRetryRow, DeadLetterRunRow } from '../db/tasks.js'

export const DEAD_LETTER_DEFAULT_DAYS = 7
export const DEAD_LETTER_MAX_DAYS = 30
export const DEAD_LETTER_DEFAULT_LIMIT = 100
export const DEAD_LETTER_MAX_LIMIT = 500

export interface DeadLetterRunItem {
  kind: 'run'
  task: string
  agent: string
  ts: number
  status: string
}

export interface DeadLetterPendingItem {
  kind: 'pending'
  task: string
  agent: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  reason: string | null
  alert_sent_at: number | null
}

export type DeadLetterItem = DeadLetterRunItem | DeadLetterPendingItem

export interface DeadLetterResponse {
  days: number
  limit: number
  truncated: boolean
  items: DeadLetterItem[]
}

export type DeadLetterParams = { ok: true; days: number; limit: number } | { ok: false; field: 'days' | 'limit'; hint: string }

function parseBoundedInt(raw: string | null, def: number, min: number, max: number): number | null {
  if (raw === null) return def
  if (!/^\d{1,6}$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

/** Query-string parsing: absent -> default, present but not an integer in range -> a 400 (never a silent clamp). */
export function parseDeadLetterParams(searchParams: URLSearchParams): DeadLetterParams {
  const days = parseBoundedInt(searchParams.get('days'), DEAD_LETTER_DEFAULT_DAYS, 1, DEAD_LETTER_MAX_DAYS)
  if (days === null) return { ok: false, field: 'days', hint: `days must be an integer from 1 to ${DEAD_LETTER_MAX_DAYS}` }
  const limit = parseBoundedInt(searchParams.get('limit'), DEAD_LETTER_DEFAULT_LIMIT, 1, DEAD_LETTER_MAX_LIMIT)
  if (limit === null) return { ok: false, field: 'limit', hint: `limit must be an integer from 1 to ${DEAD_LETTER_MAX_LIMIT}` }
  return { ok: true, days, limit }
}

function sortKey(item: DeadLetterItem): number {
  return item.kind === 'run' ? item.ts : item.last_attempt
}

/**
 * Pure: merge the two halves, newest first, cut to `limit`. `runs` is expected to be fetched with at most
 * `limit + 1` rows so `truncated` can be told without a second query; any surplus here also sets it.
 */
export function buildDeadLetterResponse(
  params: { days: number; limit: number },
  runs: ReadonlyArray<DeadLetterRunRow>,
  pending: ReadonlyArray<PendingTaskRetryRow>,
): DeadLetterResponse {
  const items: DeadLetterItem[] = [
    ...runs.map((r): DeadLetterRunItem => ({ kind: 'run', task: r.name, agent: r.agent, ts: r.ts, status: r.status })),
    ...pending.map((p): DeadLetterPendingItem => ({
      kind: 'pending',
      task: p.task_name,
      agent: p.agent_name,
      first_attempt: p.first_attempt,
      last_attempt: p.last_attempt,
      attempt_count: p.attempt_count,
      reason: p.last_reason,
      alert_sent_at: p.alert_sent_at,
    })),
  ]
  items.sort((a, b) => sortKey(b) - sortKey(a))
  const truncated = items.length > params.limit
  return { days: params.days, limit: params.limit, truncated, items: items.slice(0, params.limit) }
}

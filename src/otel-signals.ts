// The metrics the dashboard process exports over OTLP, declared in one place (registry: src/otel-metrics.ts).
//
// Privacy rule for everything here: event types, statuses, agent and schedule names, tenant ids and numbers
// only. Never message text, task prompts, Telegram content or user names. Each metric lists the attribute keys
// it may carry; anything else is dropped by the registry.

import { getDb } from './db/connection.js'
import { defineCounter, defineGauge, defineHistogram, defineObservableCounter, otelCount, otelRecord } from './otel-metrics.js'
import { getGateDecisionCounts } from './db/otel-logs.js'

// ── Exporter health (src/web/otel-push-exporter.ts) ──────────────────────────
// The attribute key is in our own namespace on purpose: a bare "signal" would collide with anything a backend
// or another exporter labels the same way, and the key is what dashboards filter on (documented, pinned by a test).
const SIGNAL_ATTR = 'marveen.otel.signal'
defineCounter('marveen.otel.export.failures', '{request}', [SIGNAL_ATTR])
defineCounter('marveen.otel.export.rejected', '{item}', [SIGNAL_ATTR])

export function countExportFailure(signal: 'traces' | 'metrics' | 'logs'): void {
  otelCount('marveen.otel.export.failures', { [SIGNAL_ATTR]: signal })
}
export function countExportRejected(signal: 'traces' | 'metrics' | 'logs', items: number): void {
  otelCount('marveen.otel.export.rejected', { [SIGNAL_ATTR]: signal }, items)
}

// ── Scheduled tasks (src/db/tasks.ts appendTaskRun, src/web/command-task.ts) ─
defineCounter('marveen.schedule.runs', '{run}', ['schedule', 'status'])
defineHistogram('marveen.schedule.run.duration', 's', ['schedule', 'status'])

// One task_runs row = one occurrence with its outcome (fired, fired_late, error, skipped_*, missed, lost ...).
export function countScheduleRun(schedule: string, status: string): void {
  otelCount('marveen.schedule.runs', { schedule, status })
}
// Only a command task is run (and timed) by the scheduler itself; an LLM task is a prompt typed into an
// agent's session, and nothing in the runner sees it finish.
export function recordScheduleRunDuration(schedule: string, seconds: number, ok: boolean): void {
  otelRecord('marveen.schedule.run.duration', seconds, { schedule, status: ok ? 'ok' : 'error' })
}

// ── Inter-agent messages (src/web/message-router.ts) ─────────────────────────
defineCounter('marveen.agent_messages.delivered', '{message}')
defineHistogram('marveen.agent_messages.delivery.duration', 's')
defineCounter('marveen.agent_messages.failed', '{message}', ['reason'])

export function recordMessageDelivered(createdAtSec: number | null | undefined): void {
  otelCount('marveen.agent_messages.delivered')
  if (typeof createdAtSec === 'number') otelRecord('marveen.agent_messages.delivery.duration', Math.max(0, Date.now() / 1000 - createdAtSec))
}
export function countMessageFailed(reason: 'abandoned' | 'inject_failed' | 'error' | 'invalid_sender'): void {
  otelCount('marveen.agent_messages.failed', { reason })
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// Queue depth and the age of its oldest entry, read when an export happens.
defineGauge('marveen.agent_messages.pending', '{message}', () => {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'").get() as { n: number }
  return [{ value: row.n }]
})
defineGauge('marveen.agent_messages.oldest_pending_age', 's', () => {
  const row = getDb().prepare("SELECT MIN(created_at) AS oldest FROM agent_messages WHERE status = 'pending'").get() as { oldest: number | null }
  return row.oldest == null ? [] : [{ value: Math.max(0, nowSec() - row.oldest) }]
})

// ── Telegram channel (incoming_events): counts per status and the age of the oldest unhandled event ──
defineGauge('marveen.channel.events', '{event}', () => {
  const rows = getDb().prepare('SELECT source, status, COUNT(*) AS n FROM incoming_events GROUP BY source, status')
    .all() as { source: string; status: string; n: number }[]
  return rows.map((r) => ({ attrs: { channel: r.source, status: r.status }, value: r.n }))
}, ['channel', 'status'])
defineGauge('marveen.channel.handoff.oldest_pending_age', 's', () => {
  const rows = getDb().prepare("SELECT source, MIN(created_at) AS oldest FROM incoming_events WHERE status = 'pending' GROUP BY source")
    .all() as { source: string; oldest: number | null }[]
  return rows.filter((r) => r.oldest != null).map((r) => ({ attrs: { channel: r.source }, value: Math.max(0, nowSec() - (r.oldest as number)) }))
}, ['channel'])

// ── PreToolUse gate verdicts (scripts/hooks/gate_audit_lib.py writes gate_decision_counts) ──
// A gate (destructive-gate, secret-read-gate ...) and its verdict: allow, deny, or error (a gate process that
// ended with neither 0 nor 2). `reason` is the fixed code of a deny or error and is left out for an allow.
// Counts only: nothing of the call the gate looked at is ever stored.
defineObservableCounter('marveen.gate.decisions', '{decision}', () => {
  return getGateDecisionCounts().map((r) => ({
    attrs: {
      'marveen.gate': r.gate,
      'marveen.gate.decision': r.decision,
      ...(r.reason ? { 'marveen.gate.reason': r.reason } : {}),
    },
    value: r.count,
    startMs: r.first_at * 1000,
  }))
}, ['marveen.gate', 'marveen.gate.decision', 'marveen.gate.reason'])

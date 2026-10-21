// Database side of the OTLP gauges declared in src/otel-signals.ts: the queue depth of the inter-agent
// messages and the state of the Telegram handoff (incoming_events). Counts and ages only, read when an export
// happens. Nothing of a message or an event body is ever selected (privacy rule of src/otel-signals.ts).

import { getDb } from './connection.js'

/** Number of inter-agent messages waiting for delivery. */
export function countPendingAgentMessages(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'").get() as { n: number }
  return row.n
}

/** created_at (unix seconds) of the oldest pending inter-agent message, null when none is pending. */
export function oldestPendingAgentMessageAt(): number | null {
  const row = getDb().prepare("SELECT MIN(created_at) AS oldest FROM agent_messages WHERE status = 'pending'").get() as { oldest: number | null }
  return row.oldest
}

/** incoming_events counted per source and status. */
export function countIncomingEventsBySourceStatus(): { source: string; status: string; n: number }[] {
  return getDb().prepare('SELECT source, status, COUNT(*) AS n FROM incoming_events GROUP BY source, status')
    .all() as { source: string; status: string; n: number }[]
}

/** created_at (unix seconds) of the oldest pending incoming event per source. */
export function oldestPendingIncomingEventBySource(): { source: string; oldest: number | null }[] {
  return getDb().prepare("SELECT source, MIN(created_at) AS oldest FROM incoming_events WHERE status = 'pending' GROUP BY source")
    .all() as { source: string; oldest: number | null }[]
}

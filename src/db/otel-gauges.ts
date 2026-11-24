// Database side of the OTLP gauges declared in src/otel-signals.ts: the queue depth of the inter-agent
// messages and the state of the Telegram handoff (incoming_events). Counts and ages only, read when an export
// happens. Nothing of a message or an event body is ever selected (privacy rule of src/otel-signals.ts).
// Async on both backends: the export awaits each gauge collector (src/otel-metrics.ts), and the PostgreSQL path
// has no synchronous read.

import { dbx } from './facade.js'

/** Number of inter-agent messages waiting for delivery. */
export async function countPendingAgentMessages(): Promise<number> {
  const row = await dbx.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'")
  return row?.n ?? 0
}

/** created_at (unix seconds) of the oldest pending inter-agent message, null when none is pending. */
export async function oldestPendingAgentMessageAt(): Promise<number | null> {
  const row = await dbx.get<{ oldest: number | null }>("SELECT MIN(created_at) AS oldest FROM agent_messages WHERE status = 'pending'")
  return row?.oldest ?? null
}

/** incoming_events counted per source and status. */
export async function countIncomingEventsBySourceStatus(): Promise<{ source: string; status: string; n: number }[]> {
  return dbx.all<{ source: string; status: string; n: number }>(
    'SELECT source, status, COUNT(*) AS n FROM incoming_events GROUP BY source, status',
  )
}

/** created_at (unix seconds) of the oldest pending incoming event per source. */
export async function oldestPendingIncomingEventBySource(): Promise<{ source: string; oldest: number | null }[]> {
  return dbx.all<{ source: string; oldest: number | null }>(
    "SELECT source, MIN(created_at) AS oldest FROM incoming_events WHERE status = 'pending' GROUP BY source",
  )
}

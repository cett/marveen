// DB layer for the channel-coordinator.
//
// The coordinator is a SEPARATE process from the dashboard. Its database access goes through the async db facade (`dbx`), the
// same seven functions on both backends: on SQLite the facade talks to this process's own connection to store/claudeclaw.db
// (opened by the coordinator boot, see boot.ts: WAL mode, so two processes can write the file as long as each sets
// busy_timeout), on PostgreSQL it talks to the pool the boot made with the application role.
//
// There is no tenant context in this process: the coordinator is the system. Every function therefore runs as ONE named system
// job ('channel-coordinator-ingest', in BACKGROUND_JOBS): the two tables it owns are D2 (privileged only: no tenant, no agent and no
// viewer context sees a row), and the replay read joins agent_messages across tenants. Without the job the same call is refused
// by row-level security on PostgreSQL.
//
// Two tables are owned here (created by migration 0073):
//   incoming_events -- every inbound Telegram update, deduped on (source,update_id)
//   poll_offset     -- the persisted getUpdates offset (one row), so a restart
//                      resumes instead of replaying or skipping.
// The handoff to Marveen reuses the existing agent_messages table + the proven
// message-router (5s tick, tmux injection, wrapUntrusted) -- we just INSERT a
// pending row from 'telegram-coordinator' to the main agent.

import { dbx } from '../db/facade.js'
import { systemJob } from '../db/background-jobs.js'
import { UNBOUND_SOURCE_TENANT } from '../db/tenant-channel-bindings.js'
import { MAIN_AGENT_ID } from '../config.js'

export const COORDINATOR_AGENT_ID = 'telegram-coordinator'

/**
 * Runs an ingest function as the ONE system job of this module. The name is spelled here, once, because the jobs table is
 * checked against the source text (db-background-jobs.test.ts: every entry is bound in its own file under its own name).
 */
const inIngestJob = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) =>
  systemJob('channel-coordinator-ingest', fn)

/**
 * The tenant of the handoff row. Every update that arrives on this bot belongs to the owner, and the owner is the default
 * tenant (the owner's decision); incoming_events has no tenant column. Another tenant's user on the same bot is NOT handled by this
 * process: no sender rule and no per-chat attribution exists here, and this port adds none. Named, not a literal, so the rule
 * has one definition (the one the tenant-channel bindings call "a source without a binding").
 */
export const HANDOFF_TENANT = UNBOUND_SOURCE_TENANT

export interface InsertResult {
  inserted: boolean
  eventId: number | null
}

// Full incoming_events row, used by the reconcile/replay path to rebuild the
// handoff content from the stored fields.
export interface IncomingEventRow {
  id: number
  source: string
  update_id: number
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  kind: string
  content: string | null
  meta: string | null
  tg_date: number | null
  status: string
  agent_message_id: number | null
  error: string | null
  created_at: number
  delivered_at: number | null
}

// Insert on the unique (source,update_id), ON CONFLICT DO NOTHING. Returns inserted=false when
// the update was already stored (dedup), so the caller skips re-handoff.
export const insertIncomingEvent = inIngestJob(async (
  source: string,
  ev: {
    update_id: number
    kind: string
    chat_id: number | null
    user_id: number | null
    username: string | null
    message_id: number | null
    content: string
    meta: Record<string, unknown>
    tg_date: number | null
  },
): Promise<InsertResult> => {
  const now = Math.floor(Date.now() / 1000)
  const row = await dbx.get<{ id: number }>(`
    INSERT INTO incoming_events
      (source, update_id, chat_id, user_id, username, message_id, kind, content, meta, tg_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT DO NOTHING
    RETURNING id
  `,
    source, ev.update_id, ev.chat_id, ev.user_id, ev.username, ev.message_id,
    ev.kind, ev.content, JSON.stringify(ev.meta), ev.tg_date, now,
  )
  // No row back means the (source, update_id) pair was already stored.
  return { inserted: row !== undefined, eventId: row?.id ?? null }
})

// Create the pending agent_messages row that the dashboard's message-router
// will pick up and inject into the main agent's tmux session. The router
// identity-matches COORDINATOR_AGENT_ID and delivers it as CHANNEL-INBOUND:
// the verbatim <channel ...> block (built by buildHandoffContent) plus a
// reply-expected preamble, so the main agent REPLIES to it like a native
// inbound message -- while still treating the message body as untrusted user
// data. (External callers cannot forge this id via /api/messages: a 403 guard
// rejects it; only this in-process direct DB insert is trusted.)
// The tenant is written explicitly (HANDOFF_TENANT), not left to the column default: the row is row-level-security
// scoped on PostgreSQL, and the stamp is a rule of this module, not an accident of the schema.
export const createHandoffMessage = inIngestJob(async (content: string): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const row = await dbx.get<{ id: number }>(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    COORDINATOR_AGENT_ID, MAIN_AGENT_ID, content, 'pending', now, HANDOFF_TENANT,
  )
  if (!row) throw new Error('createHandoffMessage: the insert returned no id')
  return row.id
})

export const markEventDelivered = inIngestJob(async (eventId: number, agentMessageId: number): Promise<void> => {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(
    "UPDATE incoming_events SET status = 'delivered', agent_message_id = ?, delivered_at = ? WHERE id = ?",
    agentMessageId, now, eventId,
  )
})

export const markEventFailed = inIngestJob(async (eventId: number, error: string): Promise<void> => {
  await dbx.run("UPDATE incoming_events SET status = 'failed', error = ? WHERE id = ?", error, eventId)
})

// No-message-loss replay. Returns events that still need to reach the main
// agent, either because:
//   (a) they were inserted but never handed off (coordinator crashed between
//       insert and createHandoffMessage -> agent_message_id IS NULL), or
//   (b) they were handed off but the message-router abandoned the agent_message
//       after its retry window (am.status = 'failed') -- the user's message
//       never actually reached Marveen.
// Events whose handoff is still in-flight (am.status pending/delivered/done) are
// NOT returned, so we never double-deliver a message that is merely waiting.
// Idempotency against re-handoff is further guaranteed by UNIQUE(source,update_id)
// on the source row (we re-queue a NEW agent_message, never a duplicate event).
export const getEventsNeedingHandoff = inIngestJob(async (source: string, limit = 50): Promise<IncomingEventRow[]> => {
  return dbx.all<IncomingEventRow>(`
    SELECT ie.* FROM incoming_events ie
    LEFT JOIN agent_messages am ON am.id = ie.agent_message_id
    WHERE ie.source = ?
      AND ie.status != 'failed'
      AND (
        ie.agent_message_id IS NULL
        OR am.id IS NULL
        OR am.status = 'failed'
      )
    ORDER BY ie.id ASC
    LIMIT ?
  `, source, limit)
})

export const getOffset = inIngestJob(async (source: string): Promise<number> => {
  const row = await dbx.get<{ last_update_id: number }>('SELECT last_update_id FROM poll_offset WHERE source = ?', source)
  return row?.last_update_id ?? 0
})

// UPSERT the offset. Called ONLY after a batch is fully processed (handoff +
// markEventDelivered for every update), so a crash before this leaves the
// offset behind and Telegram re-delivers the batch -- at-least-once, deduped.
export const setOffset = inIngestJob(async (source: string, lastUpdateId: number): Promise<void> => {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO poll_offset (source, last_update_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET last_update_id = excluded.last_update_id, updated_at = excluded.updated_at
  `, source, lastUpdateId, now)
})

-- Migration 0073: the channel-coordinator's own tables, moved under the migration runner.
--
-- incoming_events and poll_offset used to be created only by the coordinator process
-- (src/channel-coordinator/ingest.ts) with CREATE TABLE IF NOT EXISTS. No migration knew them, so a
-- schema built from the migrations alone (a fresh install whose coordinator never ran, and the
-- baseline a PostgreSQL port would start from) lacked them. The coordinator now runs this same
-- migration runner at start-up (applyMigrations is safe against a concurrent dashboard start), so the
-- DDL has exactly one source.
--
--   incoming_events -- every inbound Telegram update, deduped on (source, update_id)
--   poll_offset     -- the persisted getUpdates offset (one row per source), so a restart resumes
--                      instead of replaying or skipping
--
-- IF NOT EXISTS keeps a database where the coordinator already created them untouched: the column
-- list below is byte-for-byte what ingest.ts created.
CREATE TABLE IF NOT EXISTS incoming_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'telegram',
  update_id INTEGER NOT NULL,
  chat_id INTEGER,
  user_id INTEGER,
  username TEXT,
  message_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'message',
  content TEXT,
  meta TEXT,
  tg_date INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','delivered','done','failed')),
  agent_message_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

-- Idempotency: an at-least-once handler (crash between handoff and offset persist) must never create
-- a duplicate event for the same update.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_events_source_update ON incoming_events(source, update_id);
CREATE INDEX IF NOT EXISTS idx_incoming_events_status ON incoming_events(status, created_at);

CREATE TABLE IF NOT EXISTS poll_offset (
  source TEXT PRIMARY KEY,
  last_update_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

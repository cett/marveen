-- Migration 0048: agent_messages schema-drift repair.
--
-- The channel-coordinator (src/channel-coordinator/ingest.ts) opens its own
-- handle to the same store/claudeclaw.db and, on a boot race where it wins
-- and creates `agent_messages` before the dashboard's migrations have ever
-- run against that DB file, historically created the table with a schema
-- that predated several columns baked into 0001's CREATE TABLE (origin_note,
-- trace_id, span_id, parent_span_id) -- fixed alongside this migration, see
-- ingest.ts. Because 0001's CREATE TABLE is `IF NOT EXISTS`, a
-- coordinator-created table is never revisited by it, so any install that
-- hit that race before the ingest.ts fix is permanently missing those four
-- columns, even though 0017/0045/0047's ALTER TABLEs (not gated by table
-- existence) still landed tenant_id/refused_reason/no_session_at/envelope
-- correctly on the same drifted table.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS` -- re-adding an already-present
-- column raises "duplicate column name". On every currently-healthy install
-- all eight columns below already exist, so db-migrations.ts's
-- applyMigration() detects this file as a pure add-column migration and
-- applies each statement individually, skipping any duplicate-column error
-- (see isPureAddColumnMigration / applyAddColumnsTolerantly there). Listing
-- every column added since baseline -- not just the four known-missing ones
-- -- makes this a complete repair net regardless of exactly how a given
-- install's table drifted.
ALTER TABLE agent_messages ADD COLUMN origin_note TEXT;
ALTER TABLE agent_messages ADD COLUMN trace_id TEXT;
ALTER TABLE agent_messages ADD COLUMN span_id TEXT;
ALTER TABLE agent_messages ADD COLUMN parent_span_id TEXT;
ALTER TABLE agent_messages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE agent_messages ADD COLUMN refused_reason TEXT;
ALTER TABLE agent_messages ADD COLUMN no_session_at INTEGER;
ALTER TABLE agent_messages ADD COLUMN envelope TEXT;

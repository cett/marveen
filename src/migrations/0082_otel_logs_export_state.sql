-- Migration 0082: state for the OTLP log export (OTel H5a).
--
-- otel_logs_export_state  one cursor per audit source (approval_events, rbac_shadow_log, config_change_log,
--                         agent_audit_log): the highest row id already pushed. A source has no row until the
--                         log export first runs; the exporter then starts the cursor at the source's current
--                         highest id, so switching the export on does not replay the history of an audit table.
-- otel_logs_hash_salt     a single random salt for the actor pseudonym (HMAC) the exporter puts on log records
--                         instead of a user, token or agent name. It never leaves the database: the same actor
--                         keeps the same pseudonym across restarts, and a name cannot be recovered by hashing
--                         guesses without the salt.
--
-- Both are plain additions (CREATE TABLE IF NOT EXISTS), nothing is altered or rebuilt.

CREATE TABLE IF NOT EXISTS otel_logs_export_state (
  source  TEXT    PRIMARY KEY,
  last_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otel_logs_hash_salt (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT    NOT NULL
);

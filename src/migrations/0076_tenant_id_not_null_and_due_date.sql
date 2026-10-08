-- Migration 0076: tenant_id NOT NULL on approvals, device_keys and schedules, and an integer-only
-- kanban_cards.due_date (Phase 0 of the PostgreSQL move).
--
-- A NULL tenant_id was an undecided scope: PostgreSQL row-level security and the tenant purge need
-- every one of these rows to belong to a tenant. NULL always meant "the default (fleet) tenant" in
-- the code (schedules: "NULL = fleet scope", the readers fold it into 'default'), so the backfill is
-- 'default'. dashboard_users.tenant_id stays nullable on purpose: the one NULL row is the global
-- admin, and the policy for that table is built on the role, not on a tenant.
--
-- SQLite cannot add NOT NULL to an existing column, so each table is rebuilt: copy the rows to a
-- scratch table, drop the table, create it again with the new definition, copy the rows back, drop the
-- scratch table, recreate the indexes. NO `ALTER TABLE ... RENAME`: a rename re-parses every trigger in
-- the database, and the vec_* triggers of a live install reference the sqlite-vec `vec0` module, which
-- is not loaded yet while migrations run ("no such module: vec0" at boot, a crash loop). Found by
-- running this migration on a copy of the live database.
--
-- Nothing references these three tables with a foreign key (the DROP TABLE therefore cascades
-- nowhere; the lesson of 0041, where a DROP deleted child rows because foreign keys are ON by
-- default), and none has a trigger or view. The migration runs in one transaction, so a failure leaves
-- the old tables untouched.
--
-- device_keys.tenant_id had REFERENCES tenants(id) ON DELETE SET NULL. SET NULL cannot work on a NOT
-- NULL column (deleting a tenant would fail), so the action becomes CASCADE: a deleted tenant's device
-- keys go with it, which is what deleteTenant already does explicitly. device_keys is AUTOINCREMENT,
-- so its sqlite_sequence value is carried over (ids of deleted keys must not be handed out again).

-- ── approvals ───────────────────────────────────────────────────────────────
CREATE TABLE approvals_old AS SELECT * FROM approvals;
DROP TABLE approvals;
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL,
  action_description TEXT NOT NULL,
  action_payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','timeout')),
  timeout_at INTEGER,
  telegram_message_id INTEGER,
  requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  resolved_by TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default'
);
INSERT INTO approvals (id, agent_id, category, action_description, action_payload, status, timeout_at,
                       telegram_message_id, requested_at, resolved_at, resolved_by, tenant_id)
SELECT id, agent_id, category, action_description, action_payload, status, timeout_at,
       telegram_message_id, requested_at, resolved_at, resolved_by, COALESCE(tenant_id, 'default')
  FROM approvals_old;
DROP TABLE approvals_old;
CREATE INDEX idx_approvals_status ON approvals(status, requested_at);
CREATE INDEX idx_approvals_agent ON approvals(agent_id, requested_at);
CREATE INDEX idx_approvals_tenant ON approvals(tenant_id, requested_at);

-- ── device_keys ─────────────────────────────────────────────────────────────
CREATE TABLE device_keys_old AS SELECT * FROM device_keys;
CREATE TABLE device_keys_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'device_keys';
DROP TABLE device_keys;
CREATE TABLE device_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  install_id TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id) ON DELETE CASCADE
);
INSERT INTO device_keys (id, key_hash, name, created_at, last_used_at, expires_at, install_id, tenant_id)
SELECT id, key_hash, name, created_at, last_used_at, expires_at, install_id, COALESCE(tenant_id, 'default')
  FROM device_keys_old;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'device_keys', seq FROM device_keys_seq
 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'device_keys');
UPDATE sqlite_sequence
   SET seq = MAX(seq, (SELECT seq FROM device_keys_seq))
 WHERE name = 'device_keys' AND EXISTS (SELECT 1 FROM device_keys_seq);
DROP TABLE device_keys_old;
DROP TABLE device_keys_seq;

-- ── schedules ───────────────────────────────────────────────────────────────
CREATE TABLE schedules_old AS SELECT * FROM schedules;
DROP TABLE schedules;
CREATE TABLE schedules (
  id                       TEXT PRIMARY KEY,   -- sanitized slug, e.g. "morning-chain"
  prompt                   TEXT NOT NULL DEFAULT '',
  description              TEXT NOT NULL DEFAULT '',
  schedule                 TEXT NOT NULL,       -- cron expression
  agent                    TEXT NOT NULL,
  type                     TEXT NOT NULL DEFAULT 'task'
                             CHECK(type IN ('task','heartbeat','command')),
  enabled                  INTEGER NOT NULL DEFAULT 1,
  tenant_id                TEXT NOT NULL DEFAULT 'default',  -- 'default' = fleet scope
  skip_if_busy             INTEGER NOT NULL DEFAULT 0,
  force_send               INTEGER NOT NULL DEFAULT 0,
  target_session           TEXT,
  command                  TEXT,               -- type='command' only
  timeout_ms               INTEGER,
  fail_threshold           INTEGER,
  pre_check                TEXT,
  catch_up_max_age_minutes INTEGER,
  stuck_after_minutes      INTEGER,
  requires                 TEXT,               -- JSON blob: {mcp_servers:[...]}
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  status                   TEXT NOT NULL DEFAULT 'live',
  last_run_at              INTEGER,
  last_run_result          TEXT
);
INSERT INTO schedules (id, prompt, description, schedule, agent, type, enabled, tenant_id, skip_if_busy,
                       force_send, target_session, command, timeout_ms, fail_threshold, pre_check,
                       catch_up_max_age_minutes, stuck_after_minutes, requires, created_at, updated_at,
                       status, last_run_at, last_run_result)
SELECT id, prompt, description, schedule, agent, type, enabled, COALESCE(tenant_id, 'default'), skip_if_busy,
       force_send, target_session, command, timeout_ms, fail_threshold, pre_check,
       catch_up_max_age_minutes, stuck_after_minutes, requires, created_at, updated_at,
       status, last_run_at, last_run_result
  FROM schedules_old;
DROP TABLE schedules_old;
CREATE INDEX schedules_enabled   ON schedules(enabled);
CREATE INDEX schedules_tenant_id ON schedules(tenant_id);
CREATE INDEX schedules_agent     ON schedules(agent);
CREATE INDEX idx_schedules_status ON schedules(status);

-- ── kanban_cards.due_date: integer epoch (UTC midnight for a date) or NULL ──────────────────────
-- One live row held the text '2026-07-15' where every other card holds an epoch, which PostgreSQL
-- would reject in an integer column. Dates are stored as the UTC midnight epoch (the convention of
-- the other rows). The triggers keep a raw SQL writer (a skill recipe that INSERTs straight into the
-- table) from putting text there again: a date string is converted, a numeric string or a REAL is
-- cast, and anything else becomes NULL. Self-healing rather than ABORT, like the delivered_at trigger
-- of migration 0074: a bookkeeping slip should not fail the card write.
UPDATE kanban_cards
   SET due_date = CASE
     WHEN typeof(due_date) = 'text' AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND strftime('%s', due_date) IS NOT NULL THEN CAST(strftime('%s', due_date) AS INTEGER)
     WHEN CAST(due_date AS INTEGER) > 0 AND ((typeof(due_date) = 'text' AND due_date NOT GLOB '*[^0-9]*')
          OR (typeof(due_date) = 'real' AND due_date = CAST(due_date AS INTEGER))) THEN CAST(due_date AS INTEGER)
     ELSE NULL
   END
 WHERE due_date IS NOT NULL AND typeof(due_date) != 'integer';

CREATE TRIGGER kanban_cards_due_date_integer_ins AFTER INSERT ON kanban_cards
WHEN NEW.due_date IS NOT NULL AND typeof(NEW.due_date) != 'integer'
BEGIN
  UPDATE kanban_cards
     SET due_date = CASE
       WHEN typeof(NEW.due_date) = 'text' AND NEW.due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND strftime('%s', NEW.due_date) IS NOT NULL THEN CAST(strftime('%s', NEW.due_date) AS INTEGER)
       WHEN CAST(NEW.due_date AS INTEGER) > 0 AND ((typeof(NEW.due_date) = 'text' AND NEW.due_date NOT GLOB '*[^0-9]*')
            OR (typeof(NEW.due_date) = 'real' AND NEW.due_date = CAST(NEW.due_date AS INTEGER))) THEN CAST(NEW.due_date AS INTEGER)
       ELSE NULL
     END
   WHERE id = NEW.id;
END;

CREATE TRIGGER kanban_cards_due_date_integer_upd AFTER UPDATE OF due_date ON kanban_cards
WHEN NEW.due_date IS NOT NULL AND typeof(NEW.due_date) != 'integer'
BEGIN
  UPDATE kanban_cards
     SET due_date = CASE
       WHEN typeof(NEW.due_date) = 'text' AND NEW.due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND strftime('%s', NEW.due_date) IS NOT NULL THEN CAST(strftime('%s', NEW.due_date) AS INTEGER)
       WHEN CAST(NEW.due_date AS INTEGER) > 0 AND ((typeof(NEW.due_date) = 'text' AND NEW.due_date NOT GLOB '*[^0-9]*')
            OR (typeof(NEW.due_date) = 'real' AND NEW.due_date = CAST(NEW.due_date AS INTEGER))) THEN CAST(NEW.due_date AS INTEGER)
       ELSE NULL
     END
   WHERE id = NEW.id;
END;

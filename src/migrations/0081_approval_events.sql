-- Migration 0081: approval_events, the journal of what was done to (or refused for) an approval
-- beyond its status: a consume, a refused consume, a decision attempted without a human session.
-- Plus the index the email-send gate searches by (category + content hash + status).
--
-- A journal, one row per event, so it is written by the code that did the thing and read for
-- diagnosis; nothing branches on it. tenant_id is carried like on every other journal table so a
-- tenant delete can remove its rows. created_at has no SQL default: the writer supplies epoch seconds.
--
--   event    'consumed' | 'consume_refused' | 'bearer_denied' | ... Deliberately NOT a CHECK list: the set
--            grows with the approval work, and widening a CHECK needs a table rebuild, which this database
--            must not do on a live file (see 0080). The writer in src/db/vault.ts holds the type.
--   reason   the machine reason of a refusal (hash_mismatch, expired, already_consumed, human_only_category, ...)
--   actor    who acted: the agent or user name the request resolved to
--   ref      an opaque reference given by the caller (message id, request id)

CREATE TABLE IF NOT EXISTS approval_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT    NOT NULL,
  tenant_id   TEXT    NOT NULL DEFAULT 'default',
  event       TEXT    NOT NULL,
  reason      TEXT,
  actor       TEXT,
  ref         TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_events_approval ON approval_events(approval_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_category_hash ON approvals(category, content_hash, status);

-- Migration 0079: token_usage_shadow, the Phase T2 measurement of how the shared dashboard token and
-- the per-agent tokens are used. Shadow only: the table is written by the web server for every
-- observed request and nothing reads it to allow or refuse anything.
--
-- It is an AGGREGATE, not a log: one row per (day, category, method, route template, caller, caller
-- source, client, target) with a counter, so it does not grow with traffic, only with the number of
-- distinct shapes. The route is a template (ids and agent names replaced by :id / :agent / :name),
-- and the writer caps the distinct rows per day (an over-cap shape is folded into one overflow row),
-- because the caller of a shared-token request is the self-reported X-Agent-Id header and must not
-- be able to inflate the table. Rows older than the retention window are pruned by the writer.
--
--   category       shared_token_use | agent_id_mismatch | foreign_row_access | unscoped_read |
--                  missing_tenant_context | shared_agent_memories_no_tenant | fleet_skill_write_denied
--   caller         the agent the request acted as: the token's agent (caller_source 'token') or the
--                  X-Agent-Id header of a shared-token request (caller_source 'self_declared');
--                  '' with caller_source 'none' when nothing names one
--   client         coarse bucket of the User-Agent (curl, node, python, browser, other, none); the
--                  server cannot see the calling process, this is the cheap stand-in
--   target         the other agent a mismatch / foreign access names, '' for the other categories
--   day            UTC calendar day, YYYY-MM-DD (computed by the writer, no SQL date function)

CREATE TABLE IF NOT EXISTS token_usage_shadow (
  day           TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  route         TEXT    NOT NULL,
  caller        TEXT    NOT NULL DEFAULT '',
  caller_source TEXT    NOT NULL CHECK (caller_source IN ('self_declared', 'token', 'none')),
  client        TEXT    NOT NULL DEFAULT 'none',
  target        TEXT    NOT NULL DEFAULT '',
  count         INTEGER NOT NULL DEFAULT 0,
  last_ts       INTEGER NOT NULL,
  PRIMARY KEY (day, category, method, route, caller, caller_source, client, target)
);

CREATE INDEX IF NOT EXISTS idx_token_usage_shadow_day ON token_usage_shadow(day);

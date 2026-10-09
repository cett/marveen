-- Migration 0078: per-agent API tokens (Phase T1). api_tokens gets an agent_id column and the role
-- CHECK learns 'fleet_agent'.
--
-- Until now every agent, hook and script called the dashboard with the one shared token, so the
-- server could not tell WHICH agent a request came from (X-Agent-Id is a self-report, warn-only).
-- A token that names its agent is the missing identity:
--
--   role      'fleet_agent' is a new role for a fleet agent's own token. It is NOT the existing
--             'agent' role, which is the B2B tenant user's. A fleet_agent row must carry an
--             agent_id (CHECK below); the tenant is not stored on the token, the server derives it
--             per request from the agent's serving context.
--   agent_id  the agent the token belongs to. NULL for tokens that name no agent (the dashboard
--             token, an operator token). The main agent's admin token carries its agent id too, as
--             an identity label, not as a limit: the admin role stays unrestricted.
--
-- SQLite cannot widen a CHECK, so the table is rebuilt: copy the rows to a scratch table, drop the
-- table, create it again, copy the rows back (ids kept, in id order), drop the scratch table,
-- recreate the indexes. NO `ALTER TABLE ... RENAME`: a rename re-parses every trigger in the
-- database, and the vec_* triggers of a live install reference the sqlite-vec `vec0` module, which
-- is not loaded yet while migrations run (migration 0076 found this on a copy of the live
-- database). The only foreign key that touches this table is its own rotated_from: the DROP's
-- implicit DELETE removes parent and child rows together, so it cascades nowhere (the lesson of
-- 0041, where a DROP deleted rows of a child table because foreign keys are ON by default).
-- The migration runs in one transaction, so a failure leaves the old table untouched.
-- api_tokens is AUTOINCREMENT, so its sqlite_sequence value is carried over: the id of a revoked
-- token is never handed out again.

CREATE TABLE api_tokens_old AS SELECT * FROM api_tokens;
CREATE TABLE api_tokens_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'api_tokens';
DROP TABLE api_tokens;
CREATE TABLE api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT    NOT NULL UNIQUE,   -- SHA-256 hex of the raw token
  name          TEXT    NOT NULL,          -- human label, e.g. "default-admin", "fleet-agent:alpha"
  role          TEXT    NOT NULL
                  CHECK(role IN ('admin', 'agent', 'read_only', 'viewer', 'fleet_agent')),
  tenant_id     TEXT    NOT NULL DEFAULT 'default',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                   -- NULL = does not expire
  revoked_at    INTEGER,                   -- NULL = active
  last_used_at  INTEGER,
  rotated_from  INTEGER REFERENCES api_tokens(id),
  agent_id      TEXT,                      -- the agent this token belongs to; NULL = names no agent
  CHECK(role <> 'fleet_agent' OR (agent_id IS NOT NULL AND agent_id <> ''))
);
INSERT INTO api_tokens (id, token_hash, name, role, tenant_id, created_at, expires_at, revoked_at,
                        last_used_at, rotated_from)
SELECT id, token_hash, name, role, tenant_id, created_at, expires_at, revoked_at,
       last_used_at, rotated_from
  FROM api_tokens_old
 ORDER BY id;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'api_tokens', seq FROM api_tokens_seq
 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'api_tokens');
UPDATE sqlite_sequence
   SET seq = MAX(seq, (SELECT seq FROM api_tokens_seq))
 WHERE name = 'api_tokens' AND EXISTS (SELECT 1 FROM api_tokens_seq);
DROP TABLE api_tokens_old;
DROP TABLE api_tokens_seq;

CREATE INDEX idx_api_tokens_hash
  ON api_tokens(token_hash);

CREATE INDEX idx_api_tokens_tenant
  ON api_tokens(tenant_id, role, revoked_at);

CREATE INDEX idx_api_tokens_agent
  ON api_tokens(agent_id, revoked_at);

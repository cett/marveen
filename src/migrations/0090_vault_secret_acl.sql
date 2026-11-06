-- Migration 0090: vault_secret_acl table (per-secret "who may receive this secret").
--
-- One row = one grantee that MAY receive the secret in its MCP file. A secret
-- with NO rows is open: the pre-0090 behaviour (any file a binding targets).
-- A secret with at least one row is restricted to exactly those grantees.
--
-- grantee is either `agent:<id>` (id charset [A-Za-z0-9_-]{1,64}) or one of the
-- reserved scopes `scope:project`, `scope:user`, `scope:external`. The prefix
-- keeps an agent name and a scope from ever colliding. The value is validated by
-- the route and the DB layer's callers, not by a CHECK: a CHECK could not be
-- relaxed later without a table rebuild.
--
-- This is NOT the reader allowlist in store/vault-acl.json (who may READ a
-- secret value through the API); this table gates where a `vault:<id>`
-- reference may be WRITTEN.
--
-- The table is NOT seeded: an empty list keeps today's behaviour, so the deploy
-- changes nothing until somebody lists a grantee. tenant_id is part of the
-- primary key (vault_bindings / vault_ssh_keys precedent) although the binding
-- layer only writes 'default' today.
--
-- Metadata only, never a secret value (same rule as vault_bindings).
CREATE TABLE IF NOT EXISTS vault_secret_acl (
  vault_secret_id TEXT    NOT NULL,
  tenant_id       TEXT    NOT NULL DEFAULT 'default',
  grantee         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_secret_id, tenant_id, grantee)
);

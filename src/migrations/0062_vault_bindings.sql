-- Migration 0062: vault_bindings table.
--
-- Backs the vault-secret-to-MCP-env-var binding list, previously
-- store/vault-bindings.json. Part of the config/state -> SQLite migration
-- (#985, plan #984, group 7/8). Full retirement (unlike group 6's
-- costops-config.json): the whole file's content moves here, nothing else
-- lives in vault-bindings.json.
--
-- SECURITY NOTE (see plan #984, group 7): this table holds NO secret values.
-- A binding is metadata only -- which vault_secret_id is bound to which
-- env_var, and which MCP config file(s)/server(s) it gets synced into. The
-- actual secret material lives in vault.json (encrypted), keyed by
-- vault_secret_id. The old file's 0600 mode protected this metadata's
-- readability, not a secret itself; the equivalent protection here is
-- claudeclaw.db's own file-level permission (0600, set at file creation --
-- see src/db/connection.ts), which is unconditional and already covers this
-- table like every other one.
--
-- One row per (vault_secret_id, env_var, tenant_id) -- addBinding()'s
-- pre-migration semantics already replaced-on-match by that same pair, so
-- this is the natural composite key. `targets` (the array of
-- {mcpFilePath, serverName} objects a binding syncs into) is stored as a
-- JSON text column rather than a child table: it is always read/written as
-- one atomic unit with its parent binding (never queried by target
-- independently), the same shape-preserving-blob choice agent_settings.ts
-- makes for its per-row config object. Composite PRIMARY KEY includes
-- tenant_id (vault_ssh_keys/cost_budgets precedent) even though this MVP
-- only ever writes tenant_id='default' -- free to get right now, expensive
-- once a second tenant binds its own secrets.
CREATE TABLE IF NOT EXISTS vault_bindings (
  vault_secret_id TEXT    NOT NULL,
  env_var         TEXT    NOT NULL,
  targets         TEXT    NOT NULL DEFAULT '[]',
  tenant_id       TEXT    NOT NULL DEFAULT 'default',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_secret_id, env_var, tenant_id)
);

-- No baked seed: a fresh install's store/vault-bindings.json does not exist,
-- and getBindings() already returns an empty list in that case today --
-- baking a placeholder row here would be a behavior change, not a
-- migration. An existing install's bindings are backfilled at runtime by
-- migrateVaultBindingsFromFile() (src/db/vault-bindings.ts), wired into
-- initDatabase() next to the other #985 file-backfill migrators.

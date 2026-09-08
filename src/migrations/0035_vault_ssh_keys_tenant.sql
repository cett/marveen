-- Migration 0035: tenant isolation for the vault SSH key pool.
--
-- vault_ssh_keys had no tenant concept, so a tenant-scoped caller could see,
-- assign, or delete any tenant's SSH key. The underlying private key blob
-- (vault.ts, keyed by vault_key_id) got its own compound (tenant_id, id) key
-- in the same fix; this migration adds the matching column to the key-pool
-- metadata table.
--
-- vault_ssh_keys holds 0 rows in production today (no keys created yet via
-- the pool UI) -- no backfill needed, the DEFAULT covers any row written
-- before this migration runs.

ALTER TABLE vault_ssh_keys ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_vault_ssh_keys_tenant ON vault_ssh_keys(tenant_id);

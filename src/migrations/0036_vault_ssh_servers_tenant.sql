-- Migration 0036: tenant isolation for vault_ssh_servers.
--
-- vault_ssh_servers (server metadata, distinct from the vault_ssh_keys pool
-- already scoped in migration 0035) had no tenant concept, so a tenant-scoped
-- caller could see, edit, or delete any tenant's SSH server entries. The
-- DEFAULT 'default' below backfills any pre-migration row automatically --
-- no separate UPDATE needed.

ALTER TABLE vault_ssh_servers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_vault_ssh_servers_tenant ON vault_ssh_servers(tenant_id);

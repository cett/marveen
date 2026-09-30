-- Migration 0064: tenant_channel_bindings, which tenant an incoming source belongs to.
--
-- Until now nothing mapped a Telegram chat, a dashboard chat or an inter-agent sender to a
-- tenant: tenant_agent_availability is agent-level only. An agent that serves several
-- tenants therefore cannot tell, at use time, whose request it is answering. This table is
-- that mapping; the use-time skill isolation reads it to decide which tenant's skills the
-- current request may use.
--
-- One row per (agent, channel, external id); a source belongs to exactly ONE tenant.
--   channel      lowercase token: 'telegram', 'slack', 'discord', 'dashboard', 'inter-agent', ...
--   external_id  the id the channel reports for the source (chat id, user id, sender id)
-- A source with no row is treated as the 'default' tenant by the resolver (fleet-internal
-- use); it is never guessed from another source.
--
-- The FK cascades on tenant delete (better-sqlite3 enables foreign_keys by default); the
-- tenant purge (deleteTenant) also removes the rows explicitly, which is harmless.
CREATE TABLE IF NOT EXISTS tenant_channel_bindings (
  agent_id    TEXT    NOT NULL,
  channel     TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by  TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (agent_id, channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_tcb_tenant ON tenant_channel_bindings(tenant_id);

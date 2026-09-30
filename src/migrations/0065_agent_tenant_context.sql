-- Migration 0065: agent_tenant_context, the tenant of the request an agent is serving right now.
--
-- Written by the UserPromptSubmit hook (scripts/hooks/tenant-context.py) on every prompt an
-- agent receives: it resolves the incoming source (channel chat, inter-agent message, scheduled
-- task) to a tenant through tenant_channel_bindings / agent_messages.tenant_id / schedules and
-- keeps ONE row per agent. The use-time skill gate reads it; a missing, unknown or conflicting
-- context means "no tenant skills" (fail closed).
--
--   status  bound    tenant_id is the tenant of the source (explicit binding or a tenant-stamped message)
--           default  the source carries no tenant (local operator, unbound chat): tenant_id = 'default'
--           unknown  the source could not be identified or verified: tenant_id = ''
--           conflict a batch mixes sources of different tenants: tenant_id = ''
--   source  short human-readable description of what was resolved (channel:telegram:<id>, ...)
--
-- The hook also creates this table itself (same DDL, checked by a contract test) so a prompt that
-- arrives before the dashboard migration ran does not fail.
CREATE TABLE IF NOT EXISTS agent_tenant_context (
  agent_id   TEXT    PRIMARY KEY,
  tenant_id  TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK(status IN ('bound','default','unknown','conflict')),
  source     TEXT    NOT NULL DEFAULT '',
  session_id TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

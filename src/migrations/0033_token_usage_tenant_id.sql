-- Migration 0033: tenant isolation for token_usage (Overview "Token ma" card).
--
-- token_usage had no tenant concept, so the Overview tokensToday/costTodayUsd
-- figures were always fleet-global regardless of the tenant selector -- a
-- B2B tenant admin saw the whole fleet's token spend, not just their own
-- agents'. Same architecture as 0031/0032 (fleet_blackboard tenant isolation,
-- kanban #735): tenant_id is derived from tenant_agent_availability (the
-- deny-by-default opt-in matrix), counting only enabled=1 rows.
--
--   0 enabled rows for the agent -> fleet agent, tenant_id = 'default'
--   1 enabled row                -> tenant_id = that tenant
--   2+ enabled rows              -> tenant_id = '_multi_' (shared agent, admin-only
--                                    visibility; never equals a real ctx.tenantId)
--
-- Going forward, collectTokenUsage() (src/web/token-usage.ts) resolves and
-- writes tenant_id on every insert, so this one-time backfill only needs to
-- catch up existing rows.

ALTER TABLE token_usage ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

UPDATE token_usage
  SET tenant_id = (
    SELECT taa.tenant_id FROM tenant_agent_availability taa
     WHERE taa.agent_id = token_usage.agent AND taa.enabled = 1
     GROUP BY taa.agent_id
    HAVING COUNT(*) = 1
    LIMIT 1
  )
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = token_usage.agent AND taa.enabled = 1
  ) = 1;

UPDATE token_usage
  SET tenant_id = '_multi_'
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = token_usage.agent AND taa.enabled = 1
  ) > 1;

-- Explicit reset for the 0-enabled-rows case too (not just relying on the
-- column DEFAULT above): unlike a fresh ALTER TABLE ADD COLUMN, this
-- statement is also safe to *re-run* later (e.g. from a test, or if this
-- migration is ever re-applied for a re-derive), so a fleet agent whose
-- tenant grants were revoked after an earlier backfill correctly reverts to
-- 'default' instead of keeping a stale tenant value. Same gap that bit
-- 0031/0032 (blackboard) -- closed here in a single migration instead of
-- needing a follow-up.
UPDATE token_usage
  SET tenant_id = 'default'
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = token_usage.agent AND taa.enabled = 1
  ) = 0;

CREATE INDEX IF NOT EXISTS idx_token_usage_tenant ON token_usage(tenant_id, timestamp);

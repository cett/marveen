-- Migration 0031: tenant isolation for fleet_blackboard / fleet_blackboard_history.
--
-- fleet_blackboard has no tenant concept today, and every RBAC role (including
-- tenant-scoped 'agent'/'read_only'/'viewer' users) gets blackboard:read, so
-- GET /api/blackboard leaks every agent's current task summary across tenants.
--
-- tenant_id is derived from tenant_agent_availability (the deny-by-default
-- opt-in matrix -- see 0026_tenant_agent_availability.sql), counting only
-- enabled=1 rows: a disabled row means the agent is NOT available to that
-- tenant, so it must not count as a tenant assignment.
--
--   0 enabled rows for the agent -> fleet agent, tenant_id = 'default'
--   1 enabled row                -> tenant_id = that tenant
--   2+ enabled rows              -> tenant_id = '_multi_' (shared agent, admin-only
--                                    visibility; never equals a real ctx.tenantId)

ALTER TABLE fleet_blackboard         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE fleet_blackboard_history ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

UPDATE fleet_blackboard
  SET tenant_id = (
    SELECT taa.tenant_id FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard.agent_id AND taa.enabled = 1
     GROUP BY taa.agent_id
    HAVING COUNT(*) = 1
    LIMIT 1
  )
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard.agent_id AND taa.enabled = 1
  ) = 1;

UPDATE fleet_blackboard
  SET tenant_id = '_multi_'
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard.agent_id AND taa.enabled = 1
  ) > 1;

UPDATE fleet_blackboard_history
  SET tenant_id = (
    SELECT taa.tenant_id FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard_history.agent_id AND taa.enabled = 1
     GROUP BY taa.agent_id
    HAVING COUNT(*) = 1
    LIMIT 1
  )
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard_history.agent_id AND taa.enabled = 1
  ) = 1;

UPDATE fleet_blackboard_history
  SET tenant_id = '_multi_'
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard_history.agent_id AND taa.enabled = 1
  ) > 1;

CREATE INDEX IF NOT EXISTS idx_fb_tenant  ON fleet_blackboard(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fbh_tenant ON fleet_blackboard_history(tenant_id);

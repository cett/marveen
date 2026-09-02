-- Migration 0032: re-resolve fleet_blackboard / fleet_blackboard_history
-- tenant_id against the CURRENT tenant_agent_availability state.
--
-- 0031_blackboard_tenant_id.sql derived tenant_id once, at the time it ran.
-- Any row written since then by upsertBlackboard() also self-corrects (it
-- calls resolveAgentTenant() on every write -- see src/db.ts). But a row that
-- has NOT been written to since 0031 stays stamped with whatever
-- tenant_agent_availability looked like back then, even if the agent's
-- assignments have changed since (e.g. a pre-existing fleet agent later also
-- granted to a tenant -- correctly '_multi_' now, but its last blackboard
-- write still carries the single-tenant value from before the grant).
--
-- This migration is the exact same derivation as 0031, safe to (and intended
-- to) run again: it always reflects the live tenant_agent_availability state
-- at migration time, so it is the one-time catch-up for rows that predate a
-- later availability change and were never re-written since.

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

UPDATE fleet_blackboard
  SET tenant_id = 'default'
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard.agent_id AND taa.enabled = 1
  ) = 0;

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

UPDATE fleet_blackboard_history
  SET tenant_id = 'default'
  WHERE (
    SELECT COUNT(*) FROM tenant_agent_availability taa
     WHERE taa.agent_id = fleet_blackboard_history.agent_id AND taa.enabled = 1
  ) = 0;

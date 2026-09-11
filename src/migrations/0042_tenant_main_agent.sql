-- Migration 0042: tenant main-agent designation.
--
-- tenants.main_agent_id names which agent is that tenant's coordinator, so
-- the Agents screen can label the right card/node as the tenant's main agent
-- instead of a generic team-hierarchy role. NULL means the tenant has no
-- designated main agent yet -- deliberately not seeded here, since which
-- agent coordinates which tenant is deployment-specific data, not schema;
-- an operator sets it per tenant after this migration runs (e.g. `UPDATE
-- tenants SET main_agent_id = '<agent-id>' WHERE id = '<tenant-id>'`).
ALTER TABLE tenants ADD COLUMN main_agent_id TEXT;

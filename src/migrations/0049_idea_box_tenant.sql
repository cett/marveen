-- Migration 0049: tenant isolation for idea_box.
--
-- idea_box has no tenant concept today; GET/POST/PUT/DELETE and the comment/
-- promote/breakdown sub-routes are all open to every RBAC role, so any
-- tenant-scoped caller can read and mutate every other tenant's ideas.
-- Unlike fleet_blackboard (agent_id-keyed,
-- backfilled via tenant_agent_availability -- see 0031), idea_box has no
-- agent_id column to derive an owner tenant from: every idea in an existing
-- install predates tenant isolation, so existing rows are simply stamped
-- 'default', the same convention ideas.ts already uses for the shared
-- dashboard-token/admin scope.

ALTER TABLE idea_box ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_idea_box_tenant ON idea_box(tenant_id);

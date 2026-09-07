-- Migration 0034: tenant isolation for import_sources / import_audit_log.
--
-- import_memories already carries tenant_id (0017_tenant_id.sql), but the two
-- tables that manage it -- import_sources (the source config) and
-- import_audit_log (per-run crawl history) -- had no tenant concept, so any
-- tenant-scoped caller could see and manage every tenant's import sources.
--
-- Unlike 0031/0033 (fleet_blackboard/token_usage), import_sources has no
-- existing per-agent signal to derive tenant_id from -- it is a small,
-- admin-managed table (5 rows in production today). All existing rows are
-- backfilled to 'default' (approved).
--
-- import_audit_log rows inherit their tenant_id from the parent source via
-- source_id, since a run is always scoped to the source it crawled.

ALTER TABLE import_sources    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE import_audit_log  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

UPDATE import_audit_log
  SET tenant_id = (SELECT tenant_id FROM import_sources WHERE id = import_audit_log.source_id);

CREATE INDEX IF NOT EXISTS idx_import_sources_tenant ON import_sources(tenant_id);
CREATE INDEX IF NOT EXISTS idx_import_audit_tenant ON import_audit_log(tenant_id, run_at DESC);

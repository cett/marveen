-- Migration 0055: pagination-support indexes.
--
-- No schema change -- only new indexes for the offset/limit + COUNT(*) query
-- shape the dashboard list pagination work introduces (kanban per-status
-- "load more", ideas, workspace docs). Existing indexes already cover
-- tenant_id, status and category individually; these add the composite
-- (filter, order-by) shape the new paginated queries actually run.

CREATE INDEX IF NOT EXISTS idx_kanban_status_sort
  ON kanban_cards(status, sort_order ASC, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_idea_box_tenant_created
  ON idea_box(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_docs_tenant_created
  ON workspace_docs(tenant_id, created_at DESC);

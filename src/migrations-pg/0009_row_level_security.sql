-- 0009: row-level security. PG-only (no SQLite twin: SQLite has no row-level security).
--
-- What this file does, in order:
--   1. refuses to run when the serving role does not exist (a missing role is a provisioning step that was skipped; the
--      install would otherwise boot into permission errors far from the cause);
--   2. creates schema `app` with the context helpers the policies read (the settings are set per transaction by the
--      facade, one statement, see src/db/pg/dbx.ts);
--   3. gives the serving role its DML rights (no TRUNCATE, REFERENCES, TRIGGER or CREATE) and takes the writes on
--      schema_version away again: the runner writes it as the owner, the serving role only reads it;
--   4. ENABLEs and FORCEs row-level security on every table, then writes one policy set per class (the classes are in
--      src/db/pg/rls-registry.ts; every table of the registry is here and the catalog cells pin it);
--   5. creates the auth gateway: the four functions the login path uses, the ONLY way a context without a user or a
--      tenant touches dashboard_users and auth_sessions.
--
-- FORCE is what binds the owner role too; the runner applies this file as the `system` context (see
-- src/db-migrations-pg.ts), so its own schema_version row and any later data step still pass.
--
-- A policy that names `app.tenant()` and its siblings reads them as `(SELECT app.tenant())`: the sub-select is an InitPlan,
-- evaluated once per statement, and the comparison stays usable as an index condition. All policies are PERMISSIVE; a
-- table has more than one only where two commands need two shapes.
--
-- Not here: indexes (measured later), federation or RBAC code, a policy for a table that does not exist yet (a new table
-- adds its ENABLE, FORCE, policy and registry entry in its own migration).

-- 1. The serving role must exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marveen_app') THEN
    RAISE EXCEPTION 'migration 0009 needs the serving role marveen_app: run the role provisioning step (owner, app and backup roles) before the migrations';
  END IF;
END
$$;

-- 2. The context helpers. SECURITY INVOKER, STABLE, not LEAKPROOF. An empty setting reads as NULL (after a
-- transaction-local setting ends, the setting reads as the empty string on the next transaction of the same session),
-- and a NULL tenant matches no row: fail closed without a special case.
CREATE SCHEMA app;

CREATE FUNCTION app.tenant() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$;
CREATE FUNCTION app.role() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.role', true), '') $$;
CREATE FUNCTION app.agent() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.agent_id', true), '') $$;
CREATE FUNCTION app.job() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.job', true), '') $$;
-- The dashboard user id as a number. A value that is not a plain number (up to 18 digits) is NULL, never an error: the
-- policies then match no row. Written as one expression so it inlines and stays index-usable.
CREATE FUNCTION app.user_id() RETURNS bigint LANGUAGE sql STABLE
  AS $$ SELECT CASE WHEN NULLIF(current_setting('app.user_id', true), '') ~ '^[0-9]{1,18}$'
                    THEN NULLIF(current_setting('app.user_id', true), '')::bigint END $$;
CREATE FUNCTION app.privileged() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT app.role() IN ('system', 'admin') $$;

GRANT USAGE ON SCHEMA app TO marveen_app;
GRANT EXECUTE ON FUNCTION app.tenant(), app.role(), app.agent(), app.job(), app.user_id(), app.privileged() TO marveen_app;

-- 3. What the serving role may do: DML only. Tables and sequences added by a later migration get the same default.
GRANT USAGE ON SCHEMA public TO marveen_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO marveen_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO marveen_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO marveen_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO marveen_app;
-- The serving role only reads schema_version (a boot without a migration URL checks it and never writes it).
REVOKE INSERT, UPDATE, DELETE ON schema_version FROM marveen_app;

-- 4. Row-level security on every table, and the policies.
-- ENABLE and FORCE on every table, one statement each. FORCE is what binds the owner role too.
ALTER TABLE agent_active_plans ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_blackboard_tier ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_inflight_turns ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_state ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_tenant_context ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_events ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_embeddings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE autonomy_categories ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE background_tasks ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_allowed_chats ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_credential_baseline ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_plans_registry ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE config_change_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_budgets ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_line_items ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_sources ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_logs ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE device_keys ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE egress_allowlist ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE fleet_blackboard ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE fleet_blackboard_history ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE gate_decision_counts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE homoglyph_findings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE hook_audit_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE idea_box ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE idea_comments ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE idea_status_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE import_audit_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE import_memories ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE import_sources ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE incoming_events ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE kanban_card_events ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE kanban_card_labels ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE kanban_cards ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE kanban_comments ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE labels ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_versions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE model_profile_map ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE otel_logs_export_state ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE otel_logs_hash_salt ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE otel_metrics_export_state ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE otel_spans ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_senders ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE pending_channel_requests ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE pending_task_retries ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE poll_offset ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE rbac_shadow_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE restore_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE schema_version ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_files ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_revision_files ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_revisions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_tenant_access ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_usage ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE span_reads ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE store_file_audit ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE task_runs ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_agent_availability ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_channel_bindings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE token_usage_cursors ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE token_usage_daily ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE token_usage_monthly ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE token_usage_shadow ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_bindings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_secret_acl ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_ssh_keys ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_ssh_servers ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_doc_embeddings ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_docs ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- Class A and B: a tenant row. A NULL tenant never equals the context, so an unattributed row is for privileged roles only.
CREATE POLICY tenant_isolation ON agent_audit_log FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON agent_inflight_turns FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON agent_messages FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON agent_settings FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON agent_state FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON agent_tenant_context FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON api_tokens FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON approval_events FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON approvals FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON artifacts FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON background_tasks FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON channel_allowed_chats FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON channel_credential_baseline FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON conversation_log FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON cost_budgets FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON cost_line_items FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON daily_logs FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
-- role = 'admin' is the GLOBAL admin role (the gate reads it from this table at the next login): a tenant context neither sets nor changes it.
CREATE POLICY tenant_isolation ON dashboard_users FOR ALL USING ((tenant_id = (SELECT app.tenant()) AND role <> 'admin') OR (SELECT app.privileged())) WITH CHECK ((tenant_id = (SELECT app.tenant()) AND role <> 'admin') OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON device_keys FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON egress_allowlist FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON fleet_blackboard FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON fleet_blackboard_history FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON hook_audit_log FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON idea_box FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON import_audit_log FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON import_memories FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON import_sources FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON kanban_cards FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON labels FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON memories FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON otel_spans FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON partner_senders FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON rbac_shadow_log FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON schedules FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
-- Revisions of a GLOBAL skill (the history of a skill every tenant sees): a privileged role only. NOT EXISTS, not a join to a live row:
-- the 'delete' revision of a skill whose row is already gone must still be writable by its tenant.
CREATE POLICY tenant_isolation ON skill_revisions FOR ALL USING ((tenant_id = (SELECT app.tenant()) AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_revisions.skill_id AND s.is_global = 1)) OR (SELECT app.privileged())) WITH CHECK ((tenant_id = (SELECT app.tenant()) AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_revisions.skill_id AND s.is_global = 1)) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON skill_usage FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
-- A tenant cannot make its own skill global (is_global = 1 would show it, and its files, to every tenant): only a privileged role can.
-- The same on the existing row: a tenant neither changes nor deletes its own skill once it is global (USING), reading stays open through global_or_granted.
CREATE POLICY tenant_isolation ON skills FOR ALL USING ((tenant_id = (SELECT app.tenant()) AND is_global = 0) OR (SELECT app.privileged())) WITH CHECK ((tenant_id = (SELECT app.tenant()) AND is_global = 0) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON store_file_audit FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON task_runs FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON tenant_agent_availability FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON tenant_channel_bindings FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON token_usage FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON token_usage_daily FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON token_usage_monthly FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON vault_bindings FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON vault_secret_acl FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON vault_ssh_keys FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON vault_ssh_servers FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY tenant_isolation ON workspace_docs FOR ALL USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged())) WITH CHECK (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));

-- Class C: a child, through its parent (the parent policy applies inside the EXISTS).
CREATE POLICY via_parent ON artifact_embeddings FOR ALL USING ((EXISTS (SELECT 1 FROM artifacts p WHERE p.id = artifact_embeddings.artifact_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM artifacts p WHERE p.id = artifact_embeddings.artifact_id));
CREATE POLICY via_parent ON idea_comments FOR ALL USING ((EXISTS (SELECT 1 FROM idea_box p WHERE p.id = idea_comments.idea_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM idea_box p WHERE p.id = idea_comments.idea_id));
CREATE POLICY via_parent ON idea_status_log FOR ALL USING ((EXISTS (SELECT 1 FROM idea_box p WHERE p.id = idea_status_log.idea_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM idea_box p WHERE p.id = idea_status_log.idea_id));
CREATE POLICY via_parent ON kanban_card_events FOR ALL USING ((EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = kanban_card_events.card_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = kanban_card_events.card_id));
CREATE POLICY via_parent ON kanban_card_labels FOR ALL USING ((EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = kanban_card_labels.card_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = kanban_card_labels.card_id));
CREATE POLICY via_parent ON kanban_comments FOR ALL USING ((EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = kanban_comments.card_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = kanban_comments.card_id));
CREATE POLICY via_parent ON memory_embeddings FOR ALL USING ((EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_embeddings.memory_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_embeddings.memory_id));
CREATE POLICY via_parent ON memory_links FOR ALL USING ((EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_links.src_id) AND EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_links.dst_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_links.src_id) AND EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_links.dst_id));
CREATE POLICY via_parent ON memory_versions FOR ALL USING ((EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_versions.memory_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM memories p WHERE p.id = memory_versions.memory_id));
CREATE POLICY via_parent ON skill_revision_files FOR ALL USING ((EXISTS (SELECT 1 FROM skill_revisions p WHERE p.id = skill_revision_files.revision_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM skill_revisions p WHERE p.id = skill_revision_files.revision_id));
CREATE POLICY via_parent ON span_reads FOR ALL USING ((EXISTS (SELECT 1 FROM memories p WHERE p.id = span_reads.memory_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM memories p WHERE p.id = span_reads.memory_id));
CREATE POLICY via_parent ON workspace_doc_embeddings FOR ALL USING ((EXISTS (SELECT 1 FROM workspace_docs p WHERE p.id = workspace_doc_embeddings.doc_id)) OR (SELECT app.privileged())) WITH CHECK (EXISTS (SELECT 1 FROM workspace_docs p WHERE p.id = workspace_doc_embeddings.doc_id));

-- Class D1: readable by every context, written by privileged roles.
CREATE POLICY read_all ON agent_blackboard_tier FOR SELECT USING (true);
CREATE POLICY privileged_write ON agent_blackboard_tier FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY read_all ON autonomy_categories FOR SELECT USING (true);
CREATE POLICY privileged_write ON autonomy_categories FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY read_all ON claude_plans_registry FOR SELECT USING (true);
CREATE POLICY privileged_write ON claude_plans_registry FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY read_all ON cost_sources FOR SELECT USING (true);
CREATE POLICY privileged_write ON cost_sources FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY read_all ON model_profile_map FOR SELECT USING (true);
CREATE POLICY privileged_write ON model_profile_map FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY read_all ON schema_version FOR SELECT USING (true);
CREATE POLICY privileged_write ON schema_version FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));

-- Class D2: privileged only. Class D3: append-only for every context.
CREATE POLICY privileged_only ON agent_active_plans FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON config_change_log FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON gate_decision_counts FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON incoming_events FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON otel_logs_export_state FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON otel_logs_hash_salt FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON otel_metrics_export_state FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON pending_channel_requests FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON pending_task_retries FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON poll_offset FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON restore_log FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON scheduled_tasks FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON sessions FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON system_config FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON token_usage_cursors FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY privileged_only ON token_usage_shadow FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY append_only ON homoglyph_findings FOR INSERT WITH CHECK (true);
CREATE POLICY privileged_all ON homoglyph_findings FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));

-- Class E: the auth tables. The public context reads and writes nothing of them (the login path is the app.auth_* functions below).
CREATE POLICY own_row ON dashboard_users FOR SELECT USING (id = (SELECT app.user_id()));
CREATE POLICY own_session ON auth_sessions FOR ALL USING ((SELECT app.privileged()) OR user_id = (SELECT app.user_id())) WITH CHECK ((SELECT app.privileged()) OR user_id = (SELECT app.user_id()));

-- Class F: tenants, and the skill grants.
CREATE POLICY own_tenant ON tenants FOR SELECT USING (id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY privileged_write ON tenants FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
-- The skill grants (class F, not A): the grantee reads its own rows, only a privileged role grants or revokes. Under class A a
-- tenant could INSERT (a skill of another tenant, itself) and so grant itself that skill; the grant routes are admin-only.
-- There is no owner-write branch: a subquery on skills here would meet the EXISTS over this table in the skills policy below
-- (PostgreSQL refuses that cycle).
CREATE POLICY own_grants ON skill_tenant_access FOR SELECT USING (tenant_id = (SELECT app.tenant()) OR (SELECT app.privileged()));
CREATE POLICY privileged_write ON skill_tenant_access FOR ALL USING ((SELECT app.privileged())) WITH CHECK ((SELECT app.privileged()));
CREATE POLICY global_or_granted ON skills FOR SELECT USING (is_global = 1 OR EXISTS (SELECT 1 FROM skill_tenant_access a WHERE a.skill_id = skills.id AND a.tenant_id = (SELECT app.tenant())));
CREATE POLICY visible_through_skill ON skill_files FOR SELECT USING (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_files.skill_id));
-- The files of a GLOBAL skill (shown to every tenant) are written by a privileged role only, the same rule as skills.is_global.
CREATE POLICY own_tenant_skill ON skill_files FOR ALL USING (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_files.skill_id AND ((s.tenant_id = (SELECT app.tenant()) AND s.is_global = 0) OR (SELECT app.privileged())))) WITH CHECK (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_files.skill_id AND ((s.tenant_id = (SELECT app.tenant()) AND s.is_global = 0) OR (SELECT app.privileged()))));

-- 5. The auth gateway: exactly four functions. A context without a user (the login of an unauthenticated caller) and the
-- status route of every context reach dashboard_users and auth_sessions only through these.
--
-- Mechanics, the same for all four: plpgsql, static SQL only (no EXECUTE), SECURITY INVOKER, and one function-level
-- setting, `SET search_path = pg_catalog, pg_temp`, which with schema-qualified tables stops a temp table or a schema of
-- the caller from standing in for the real table. The elevated role is a save and restore around ONE static statement:
--   v_prev := coalesce(current_setting('app.role', true), '');   -- the caller's value, first thing
--   set_config('app.role', 'system', true);                       -- transaction-local, the only elevation
--   <the one SELECT / INSERT / DELETE>;
--   set_config('app.role', v_prev, true);                         -- directly after it, on the one exit path
-- (A function-level `SET app.role` would be tidier, but PostgreSQL 15 and later refuse it to a role without the SET
-- privilege on the parameter, which would put a cluster-level grant into the provisioning.) The restore needs no
-- handler: an error leaves the function, and the transaction or the savepoint the caller rolls back takes the
-- transaction-local setting with it. RETURN QUERY runs the query to the end before the next statement, so the restore
-- comes after the rows are produced, also when there is no row. Executable by the serving role only, never by PUBLIC.
--
-- The hash check stays in the application; these functions never verify a password. They return, or accept, exactly the
-- columns named here, so a column added to the table later does not leave through the gateway by accident.

-- Counts for the status route: enabled users and all users.
CREATE FUNCTION app.auth_user_counts() RETURNS TABLE (enabled bigint, total bigint)
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_prev text;
BEGIN
  v_prev := coalesce(current_setting('app.role', true), '');
  PERFORM set_config('app.role', 'system', true);
  RETURN QUERY SELECT count(*) FILTER (WHERE u.disabled = 0), count(*) FROM public.dashboard_users u;
  PERFORM set_config('app.role', v_prev, true);
  RETURN;
END
$$;

-- The login lookup: at most one row, four columns. The match folds ASCII letters only and compares for equality (no
-- LIKE, so a name of % or _ matches nothing), the same predicate as the facade's case-insensitive username match.
CREATE FUNCTION app.auth_login_user(p_username text)
  RETURNS TABLE (id bigint, username text, password_hash text, disabled smallint)
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_prev text;
BEGIN
  v_prev := coalesce(current_setting('app.role', true), '');
  PERFORM set_config('app.role', 'system', true);
  RETURN QUERY SELECT u.id, u.username, u.password_hash, u.disabled
                 FROM public.dashboard_users u
                WHERE translate(u.username, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
                    = translate(p_username, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
                ORDER BY u.id
                LIMIT 1;
  PERFORM set_config('app.role', v_prev, true);
  RETURN;
END
$$;

-- The one write a login may do: a new session row, for an enabled user that exists under exactly this id and name (the
-- statement is an INSERT ... SELECT from dashboard_users; no match raises 28000 and writes nothing). It returns nothing.
CREATE FUNCTION app.auth_session_create(
  p_id_hash text, p_user_id bigint, p_username text, p_now bigint, p_user_agent text, p_remote_note text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_prev text;
  v_rows bigint;
BEGIN
  v_prev := coalesce(current_setting('app.role', true), '');
  PERFORM set_config('app.role', 'system', true);
  -- The session is minted only for an enabled user that exists under exactly this id AND this name: the gate reads the role
  -- from the session's username, so a caller must not be able to name an admin it is not. One static statement.
  INSERT INTO public.auth_sessions (id_hash, user_id, username, created_at, last_seen_at, user_agent, remote_note)
  SELECT p_id_hash, u.id, u.username, p_now, p_now, p_user_agent, p_remote_note
    FROM public.dashboard_users u
   WHERE u.id = p_user_id AND u.username = p_username AND u.disabled = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('app.role', v_prev, true);
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'no enabled user matches this id and name' USING ERRCODE = '28000';
  END IF;
END
$$;

-- The revocation of a presented cookie (a login that replaces it, a logout of a stale cookie).
CREATE FUNCTION app.auth_session_revoke(p_id_hash text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_prev text;
BEGIN
  v_prev := coalesce(current_setting('app.role', true), '');
  PERFORM set_config('app.role', 'system', true);
  DELETE FROM public.auth_sessions WHERE id_hash = p_id_hash;
  PERFORM set_config('app.role', v_prev, true);
END
$$;

REVOKE ALL ON FUNCTION app.auth_user_counts(), app.auth_login_user(text),
  app.auth_session_create(text, bigint, text, bigint, text, text), app.auth_session_revoke(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_user_counts(), app.auth_login_user(text),
  app.auth_session_create(text, bigint, text, bigint, text, text), app.auth_session_revoke(text) TO marveen_app;

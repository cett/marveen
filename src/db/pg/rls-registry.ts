// The row-level-security registry: every table of the PostgreSQL schema and the policy class it gets.
//
// Migration 0009 ENABLEs and FORCEs row-level security on each of these tables and writes the policy of its class. This
// file is the list the migration, the catalog cells and the policy cells are checked against, so a table that nobody
// classified is a failing cell, never a silent default: there is no default class here on purpose, `rlsEntryFor`
// returns undefined for a table it does not know. (The static cells of src/__tests__/pg-rls-registry.test.ts hold this
// list against the CREATE TABLE text of the migration files; the catalog cells of src/__tests__/pg/rls-catalog.pg.test.ts
// hold it against migration 0009 on a real server.)
//
// Classes
//   A   tenant row, `tenant_id` NOT NULL in the catalog:        tenant_id = context tenant, or a privileged role
//   B   tenant row, `tenant_id` nullable in the catalog:        the same expression; a row with a NULL tenant is visible and
//                                                                writable for privileged roles only
//   C   child without a tenant column:                          EXISTS on the parent row (the parent's own policy applies
//                                                                inside), on every column of `fk` (a link needs both ends)
//   D1  global, read by every context:                          SELECT for all, writes for privileged roles
//   D2  global, privileged only
//   D3  global, append-only for every context:                  INSERT for all, the rest privileged only
//   E   auth tables (a closed list): the tenant shape plus the own row by user id. The `public` context reads and writes
//                                       NOTHING of them; the login path goes through the gateway functions of schema `app`
//   F   tenants and grants: the tenant sees its own row, or what a grant makes visible; privileged roles write
//
// A and B are told apart by the CATALOG (`pg_attribute.attnotnull`), not by how the CREATE TABLE text reads: a PRIMARY KEY
// that names `tenant_id` makes it NOT NULL without the words. The policy text of the two is the same, only the refusal of
// a NULL tenant differs, and the catalog cell of the migration pins each entry against the server.
//
// Three tables carry a second class by design and are ONE entry each, with an `extension`: `skills` (A, plus the F
// grants), `skill_files` (C, plus the F visibility) and `dashboard_users` (B, plus the E login branch and own row).
//
// A new table is a two-place edit: its migration (ENABLE, FORCE, the policy) and its entry here. The count below is
// pinned by a cell, so the edit shows in review.

export type RlsClass = 'A' | 'B' | 'C' | 'D1' | 'D2' | 'D3' | 'E' | 'F'

export const RLS_CLASSES: readonly RlsClass[] = ['A', 'B', 'C', 'D1', 'D2', 'D3', 'E', 'F']

export interface RlsEntry {
  table: string
  class: RlsClass
  /** Class C: the parent table the child is checked through. It carries a tenant column itself (class A or B). */
  parent?: string
  /** Class C: the column(s) of the child that point at the parent; the policy needs EVERY one of them visible. */
  fk?: readonly string[]
  /** The second class of a table that has two by design (see the header). */
  extension?: 'E' | 'F'
  /** One line: why the table is where it is. Required for D1, D2, D3, E, F and for every extension. */
  reason?: string
}

export const RLS_REGISTRY: readonly RlsEntry[] = [
  // A: a tenant row, tenant_id NOT NULL in the catalog
  { table: 'agent_messages', class: 'A' },
  { table: 'agent_settings', class: 'A' },
  { table: 'agent_state', class: 'A' },
  { table: 'agent_tenant_context', class: 'A' },
  { table: 'api_tokens', class: 'A' },
  { table: 'approval_events', class: 'A' },
  { table: 'approvals', class: 'A' },
  { table: 'artifacts', class: 'A' },
  { table: 'channel_allowed_chats', class: 'A' },
  { table: 'channel_credential_baseline', class: 'A' },
  { table: 'cost_budgets', class: 'A' },
  { table: 'device_keys', class: 'A' },
  { table: 'egress_allowlist', class: 'A' },
  { table: 'fleet_blackboard', class: 'A' },
  { table: 'fleet_blackboard_history', class: 'A' },
  { table: 'idea_box', class: 'A' },
  { table: 'import_audit_log', class: 'A' },
  { table: 'import_memories', class: 'A' },
  { table: 'import_sources', class: 'A' },
  { table: 'kanban_cards', class: 'A' },
  { table: 'labels', class: 'A' },
  { table: 'memories', class: 'A' },
  { table: 'partner_senders', class: 'A' },
  { table: 'schedules', class: 'A' },
  { table: 'skill_revisions', class: 'A' },
  { table: 'skills', class: 'A', extension: 'F', reason: 'also visible when the skill is global or a skill_tenant_access row grants it, writable for the own tenant only' },
  { table: 'tenant_agent_availability', class: 'A' },
  { table: 'tenant_channel_bindings', class: 'A' },
  { table: 'token_usage', class: 'A' },
  { table: 'token_usage_daily', class: 'A' },
  { table: 'token_usage_monthly', class: 'A' },
  { table: 'vault_bindings', class: 'A' },
  { table: 'vault_secret_acl', class: 'A' },
  { table: 'vault_ssh_keys', class: 'A' },
  { table: 'vault_ssh_servers', class: 'A' },
  { table: 'workspace_docs', class: 'A' },
  // B: a tenant row, tenant_id nullable in the catalog (a NULL tenant is visible to privileged roles only)
  { table: 'agent_audit_log', class: 'B' },
  { table: 'agent_inflight_turns', class: 'B' },
  { table: 'background_tasks', class: 'B' },
  { table: 'conversation_log', class: 'B' },
  { table: 'cost_line_items', class: 'B' },
  { table: 'daily_logs', class: 'B' },
  { table: 'dashboard_users', class: 'B', extension: 'E', reason: 'the own row by user id; the login lookup goes through a gateway function, the public context reads nothing' },
  { table: 'hook_audit_log', class: 'B' },
  { table: 'otel_spans', class: 'B' },
  { table: 'rbac_shadow_log', class: 'B' },
  { table: 'skill_usage', class: 'B' },
  { table: 'store_file_audit', class: 'B' },
  { table: 'task_runs', class: 'B' },
  // C: a child without a tenant column, through its parent
  { table: 'artifact_embeddings', class: 'C', parent: 'artifacts', fk: ['artifact_id'] },
  { table: 'idea_comments', class: 'C', parent: 'idea_box', fk: ['idea_id'] },
  { table: 'idea_status_log', class: 'C', parent: 'idea_box', fk: ['idea_id'] },
  { table: 'kanban_card_events', class: 'C', parent: 'kanban_cards', fk: ['card_id'] },
  { table: 'kanban_card_labels', class: 'C', parent: 'kanban_cards', fk: ['card_id'] },
  { table: 'kanban_comments', class: 'C', parent: 'kanban_cards', fk: ['card_id'] },
  { table: 'memory_embeddings', class: 'C', parent: 'memories', fk: ['memory_id'] },
  { table: 'memory_links', class: 'C', parent: 'memories', fk: ['src_id', 'dst_id'] },
  { table: 'memory_versions', class: 'C', parent: 'memories', fk: ['memory_id'] },
  { table: 'skill_files', class: 'C', parent: 'skills', fk: ['skill_id'], extension: 'F', reason: 'follows the visibility of skills (global or granted), not only the own tenant' },
  { table: 'skill_revision_files', class: 'C', parent: 'skill_revisions', fk: ['revision_id'] },
  { table: 'span_reads', class: 'C', parent: 'memories', fk: ['memory_id'] },
  { table: 'workspace_doc_embeddings', class: 'C', parent: 'workspace_docs', fk: ['doc_id'] },
  // D1: global, readable by every context, written by privileged roles
  { table: 'agent_blackboard_tier', class: 'D1', reason: 'tier of an agent on the blackboard (keyed by agent, no tenant column): read everywhere, changed by privileged roles' },
  { table: 'autonomy_categories', class: 'D1', reason: 'installation-wide approval levels: every context reads them, privileged roles change them' },
  { table: 'claude_plans_registry', class: 'D1', reason: 'catalogue of the subscription plans of the installation: read everywhere, changed by privileged roles' },
  { table: 'cost_sources', class: 'D1', reason: 'catalogue of cost source names: read everywhere, no tenant writer exists' },
  { table: 'model_profile_map', class: 'D1', reason: 'model-to-profile mapping shared by all tenants: read everywhere, changed by privileged roles' },
  { table: 'schema_version', class: 'D1', reason: 'migration bookkeeping: every context reads it (the boot check), only the runner writes it' },
  // D2: global, privileged only (the class of a table nobody classified yet is decided by a person, not by default)
  { table: 'agent_active_plans', class: 'D2', reason: 'the plan an agent is bound to (keyed by agent, no tenant column)' },
  { table: 'config_change_log', class: 'D2', reason: 'audit trail of the installation settings: written by system and admin paths' },
  { table: 'gate_decision_counts', class: 'D2', reason: 'counters of the gate decisions, written by the dashboard itself' },
  { table: 'incoming_events', class: 'D2', reason: 'channel ingest queue: written and drained by the channel coordinator' },
  { table: 'otel_logs_export_state', class: 'D2', reason: 'export cursor of the log shipper' },
  { table: 'otel_logs_hash_salt', class: 'D2', reason: 'salt of the log hashing: a secret of the installation' },
  { table: 'otel_metrics_export_state', class: 'D2', reason: 'export cursor of the metrics shipper' },
  { table: 'pending_channel_requests', class: 'D2', reason: 'channel requests that wait for an admin decision' },
  { table: 'pending_task_retries', class: 'D2', reason: 'retry queue of the task runner' },
  { table: 'poll_offset', class: 'D2', reason: 'channel poll offsets of the coordinator' },
  { table: 'restore_log', class: 'D2', reason: 'audit trail of the state restores' },
  { table: 'scheduled_tasks', class: 'D2', reason: 'the scheduler queue, run by the schedule runner job' },
  { table: 'sessions', class: 'D2', reason: 'dashboard session bookkeeping without a tenant column' },
  { table: 'system_config', class: 'D2', reason: 'installation settings (RBAC mode, federation config): only the dashboard itself and an admin read or write them' },
  { table: 'token_usage_cursors', class: 'D2', reason: 'transcript read cursors of the token usage collector' },
  { table: 'token_usage_shadow', class: 'D2', reason: 'shadow counters of shared-token use, written by the dashboard itself' },
  // D3: global, append-only for every context
  { table: 'homoglyph_findings', class: 'D3', reason: 'append-only for every context: the kanban triggers insert as the invoking role, only privileged roles read or change it' },
  // E: auth bootstrap
  { table: 'auth_sessions', class: 'E', reason: 'a session user reaches the own sessions by user id; creating and revoking a session at login goes through a gateway function, the public context touches nothing' },
  // F: tenants and grants
  { table: 'tenants', class: 'F', reason: 'a tenant sees its own row, privileged roles see all, only privileged roles write' },
  { table: 'skill_tenant_access', class: 'F', reason: 'cross-tenant skill grants: the grantee sees its own rows, only privileged roles grant or revoke (a tenant must not grant itself another tenant\'s skill)' },
]

const BY_TABLE: ReadonlyMap<string, RlsEntry> = new Map(RLS_REGISTRY.map((e) => [e.table, e]))

/** The entry of a table, or undefined when nobody classified it (never a default class: the completeness cell fails on it). */
export function rlsEntryFor(table: string): RlsEntry | undefined {
  return BY_TABLE.get(table)
}

/** Every table of the registry, in registry order. */
export const RLS_TABLES: readonly string[] = RLS_REGISTRY.map((e) => e.table)

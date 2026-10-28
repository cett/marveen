// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { db, vecExtensionLoaded } from './connection.js'
import { dbx } from './facade.js'
import { Memory, MemoryVersion } from './memory.js'
import { DashboardUser, DashboardUserPublic } from './sessions.js'
import { syncVecMemoryDelete } from './vector.js'
import { resolveWriteTenant } from './write-tenant.js'
import { reloadAgentSettingsCache } from './agent-settings-cache.js'
import { logger } from '../logger.js'
import { purgeSecretsForTenant } from '../web/vault.js'
import { GENAI_TOKEN_BUCKET_BOUNDS } from '../otel-genai.js'

export async function recordMemoryRead(
  agentId: string,
  memoryId: number,
  context: 'heartbeat' | 'search' | 'direct',
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run('INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)', agentId, memoryId, now, context)
}

// Record reads for a batch of memory ids in a single transaction.
export function recordMemoryReadBatch(
  agentId: string,
  memoryIds: number[],
  context: 'heartbeat' | 'search' | 'direct',
): void {
  if (memoryIds.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const stmt = db.prepare(
    'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const id of memoryIds) stmt.run(agentId, id, now, context)
  })
  tx()
}

// Returns memories that are stale for the given agent:
// updated_at > agent's last span_read.read_at (or never read at all).
export async function getStaleMemories(agentId: string, tenantId?: string): Promise<Memory[]> {
  const tc = tenantId ? '\n      AND m.tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return dbx.all<Memory>(`
    SELECT m.* FROM memories m
    LEFT JOIN (
      SELECT memory_id, MAX(read_at) AS last_read
      FROM span_reads
      WHERE agent_id = ?
      GROUP BY memory_id
    ) sr ON sr.memory_id = m.id
    WHERE (m.agent_id = ? OR m.category = 'shared')
      AND m.updated_at > COALESCE(sr.last_read, 0)${tc}
    ORDER BY m.updated_at DESC
  `, agentId, agentId, ...tp)
}

export async function getMemoryVersions(memoryId: number): Promise<MemoryVersion[]> {
  return dbx.all<MemoryVersion>('SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY changed_at DESC, id DESC', memoryId)
}

// Auto tier-resorting based on span_reads activity. All three steps run in
// a single transaction so a crash leaves the DB in a consistent state.
//
// warm -> cold: memory is at least warmToColdDays old AND has not been read
//   in the last warmToColdDays (hot is manually managed; shared is never
//   auto-archived -- both implicitly excluded by category='warm').
//   The created_at guard prevents freshly saved memories from being archived
//   immediately on their first maintenance run just because they have no reads yet.
// cold -> warm: read by 2+ distinct agents within the last coldToWarmDays.
// version prune: delete memory_versions older than 180 days.
//
// Returns affected row counts for observability.
export async function runMemoryMaintenance(opts: {
  warmToColdDays?: number
  coldToWarmDays?: number
  minAgents?: number
  versionTtlDays?: number
} = {}): Promise<{ warmToCold: number; coldToWarm: number; prunedVersions: number }> {
  const warmToColdSecs = (opts.warmToColdDays ?? 30) * 86400
  const coldToWarmSecs = (opts.coldToWarmDays ?? 30) * 86400
  const minAgents = opts.minAgents ?? 2
  const versionCutoff = Math.floor(Date.now() / 1000) - (opts.versionTtlDays ?? 180) * 86400
  const now = Math.floor(Date.now() / 1000)

  return dbx.tx(async (tx) => {
    // Only warm -> cold: hot is manually managed; shared belongs to all agents.
    // created_at check: memory must be at least warmToColdSecs old before it
    // can be auto-archived (a brand-new unread memory is not the same as a stale one).

    // Log warm->cold transitions before UPDATE so memory_versions has an audit trail.
    // SELECT candidates first (same WHERE as the UPDATE below), then bulk-insert versions.
    type CandRow = { id: number; content: string; keywords: string | null }
    const warmToColdCandidates = db.prepare(`
      SELECT id, content, keywords FROM memories
      WHERE category = 'warm'
        AND created_at < ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM span_reads
          WHERE span_reads.memory_id = memories.id
            AND span_reads.read_at > ? - ?
        )
    `).all(now, warmToColdSecs, now, warmToColdSecs) as CandRow[]

    if (warmToColdCandidates.length > 0) {
      const logV = db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)'
      )
      for (const c of warmToColdCandidates) {
        logV.run(c.id, c.content, 'cold', c.keywords, now, 'system:maintenance', 'category_change')
      }
    }

    const warmToCold = db.prepare(`
      UPDATE memories
      SET category = 'cold', updated_at = ?
      WHERE category = 'warm'
        AND created_at < ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM span_reads
          WHERE span_reads.memory_id = memories.id
            AND span_reads.read_at > ? - ?
        )
    `).run(now, now, warmToColdSecs, now, warmToColdSecs).changes

    // Log cold->warm transitions before UPDATE.
    const coldToWarmCandidates = db.prepare(`
      SELECT id, content, keywords FROM memories
      WHERE category = 'cold'
        AND id IN (
          SELECT memory_id FROM span_reads
          WHERE read_at > ? - ?
          GROUP BY memory_id
          HAVING COUNT(DISTINCT agent_id) >= ?
        )
    `).all(now, coldToWarmSecs, minAgents) as CandRow[]

    if (coldToWarmCandidates.length > 0) {
      const logV = db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)'
      )
      for (const c of coldToWarmCandidates) {
        logV.run(c.id, c.content, 'warm', c.keywords, now, 'system:maintenance', 'category_change')
      }
    }

    const coldToWarm = db.prepare(`
      UPDATE memories
      SET category = 'warm', updated_at = ?
      WHERE category = 'cold'
        AND id IN (
          SELECT memory_id FROM span_reads
          WHERE read_at > ? - ?
          GROUP BY memory_id
          HAVING COUNT(DISTINCT agent_id) >= ?
        )
    `).run(now, now, coldToWarmSecs, minAgents).changes

    const prunedVersions = db.prepare(
      'DELETE FROM memory_versions WHERE changed_at < ?'
    ).run(versionCutoff).changes

    return { warmToCold, coldToWarm, prunedVersions }
  })
}

// Delete memory_versions entries older than ttlDays (default 180).
export async function pruneMemoryVersions(ttlDays = 180): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return (await dbx.run('DELETE FROM memory_versions WHERE changed_at < ?', cutoff)).changes
}

export interface OtelSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  agent_id: string
  operation: string
  start_ms: number
  end_ms: number | null
  status: 'ok' | 'error' | 'timeout' | 'running'
  attributes: string | null
  // NULL = the tenant could not be resolved when the span was written (migration 0077)
  tenant_id?: string | null
}

// The shape message-router's stampTraceOnMessage
// JSON.stringify()s into an otel_spans row's `attributes` column for an
// inter-agent-message span. Flat and string/number-only on purpose --
// src/otel-exporter.ts's parseAttributes() only round-trips a flat
// Record<string, string | number | boolean> into OTLP attributes, so a
// nested value here would silently vanish from the Grafana/Tempo export.
export interface InterAgentSpanAttributes {
  msg_id: number
  from: string
  to: string
}

export async function upsertOtelSpan(span: Omit<OtelSpan, 'end_ms' | 'status'> & { end_ms?: number | null; status?: OtelSpan['status'] }): Promise<void> {
  await dbx.run(`
    INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      exported_at = CASE
        WHEN otel_spans.exported_at IS NOT NULL
         AND (excluded.end_ms IS NOT otel_spans.end_ms OR excluded.status IS NOT otel_spans.status)
        THEN NULL ELSE otel_spans.exported_at END,
      end_ms = excluded.end_ms,
      status = excluded.status,
      attributes = COALESCE(excluded.attributes, otel_spans.attributes)
  `, span.trace_id, span.span_id, span.parent_span_id ?? null,
    span.agent_id, span.operation, span.start_ms,
    span.end_ms ?? null, span.status ?? 'running', span.attributes ?? null,
    await resolveWriteTenant(span.agent_id),
  )
}

export async function closeOtelSpan(traceId: string, spanId: string, endMs: number, status: OtelSpan['status']): Promise<boolean> {
  return (await dbx.run(`
    UPDATE otel_spans SET
      exported_at = CASE WHEN exported_at IS NOT NULL AND (end_ms IS NOT ? OR status IS NOT ?) THEN NULL ELSE exported_at END,
      end_ms = ?, status = ?
    WHERE trace_id = ? AND span_id = ?
  `, endMs, status, endMs, status, traceId, spanId)).changes > 0
}

export async function getOtelTrace(traceId: string): Promise<OtelSpan[]> {
  return dbx.all<OtelSpan>('SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_ms ASC', traceId)
}

export interface OtelTraceSummary {
  trace_id: string
  root_operation: string
  root_agent: string
  start_ms: number
  end_ms: number | null
  span_count: number
  status: string
}

// Query spans for OTEL JSON export. All params are optional.
export async function queryOtelSpans(opts: {
  agent?: string
  fromMs?: number
  toMs?: number
  limit?: number
}): Promise<OtelSpan[]> {
  const { agent, fromMs, toMs, limit = 1000 } = opts
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (agent) { clauses.push('agent_id = ?'); params.push(agent) }
  if (fromMs !== undefined) { clauses.push('start_ms >= ?'); params.push(fromMs) }
  if (toMs !== undefined) { clauses.push('start_ms <= ?'); params.push(toMs) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(Math.min(limit, 5000))
  return dbx.all<OtelSpan>(`SELECT * FROM otel_spans ${where} ORDER BY start_ms ASC LIMIT ?`, ...params)
}

export async function listOtelTraces(limit = 50): Promise<OtelTraceSummary[]> {
  return dbx.all<OtelTraceSummary>(`
    SELECT
      s.trace_id,
      s.operation  AS root_operation,
      s.agent_id   AS root_agent,
      s.start_ms,
      (SELECT MAX(end_ms) FROM otel_spans WHERE trace_id = s.trace_id) AS end_ms,
      (SELECT COUNT(*)    FROM otel_spans WHERE trace_id = s.trace_id) AS span_count,
      CASE
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'error')   THEN 'error'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'timeout') THEN 'timeout'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'running') THEN 'running'
        ELSE 'ok'
      END AS status
    FROM otel_spans s
    WHERE s.parent_span_id IS NULL
    ORDER BY s.start_ms DESC
    LIMIT ?
  `, limit)
}

// ── OTLP push exporter (#800/#802) ────────────────────────────────────────────
// Closed, not-yet-pushed spans -- the push loop's per-tick trace batch.
// "Closed" means a terminal status. A span still 'running' keeps moving its end_ms forward (the
// agent.turn span grows with every tool call of the turn) and is exported once, so shipping it early
// would freeze a truncated duration at the collector. The one exception is a running span that has not
// moved for OTEL_RUNNING_SPAN_IDLE_MS: nothing closes the last turn of a session, so it is exported as
// it stands once the agent has been idle that long. A span that changes after it was exported (the
// turn went on, or was closed for real) has exported_at cleared by upsertOtelSpan / closeOtelSpan and by
// the hook's own writes, so its final state goes out once more under the same span id.
export const OTEL_RUNNING_SPAN_IDLE_MS = 15 * 60 * 1000

export async function getUnexportedOtelSpans(limit = 500, nowMs = Date.now()): Promise<OtelSpan[]> {
  return dbx.all<OtelSpan>(`
    SELECT * FROM otel_spans
    WHERE end_ms IS NOT NULL AND exported_at IS NULL
      AND (status != 'running' OR end_ms <= ?)
    ORDER BY end_ms ASC
    LIMIT ?
  `, nowMs - OTEL_RUNNING_SPAN_IDLE_MS, limit)
}

// Marks a batch of spans as pushed. Runs as one transaction so a crash
// mid-batch can't leave some spans marked and others not for the same POST.
export function markOtelSpansExported(pairs: { trace_id: string; span_id: string }[], exportedAtMs: number): void {
  if (pairs.length === 0) return
  const stmt = db.prepare('UPDATE otel_spans SET exported_at = ? WHERE trace_id = ? AND span_id = ?')
  const tx = db.transaction((rows: typeof pairs) => {
    for (const p of rows) stmt.run(exportedAtMs, p.trace_id, p.span_id)
  })
  tx(pairs)
}

export interface OtelMetricsExportState {
  last_export_ms: number
}

export async function getOtelMetricsExportState(): Promise<OtelMetricsExportState> {
  const row = await dbx.get<OtelMetricsExportState>('SELECT last_export_ms FROM otel_metrics_export_state WHERE id = 1')
  return row ?? { last_export_ms: 0 }
}

export async function setOtelMetricsExportWatermark(lastExportMs: number): Promise<void> {
  await dbx.run('UPDATE otel_metrics_export_state SET last_export_ms = ? WHERE id = 1', lastExportMs)
}

export interface TokenUsageMetricRow {
  agent: string
  model: string | null
  tenant_id: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  thinking_tokens: number
}

// Aggregates token_usage rows in (sinceMs, untilMs] -- both in *seconds* to
// match token_usage.timestamp -- grouped by (agent, model, tenant), for the
// gen_ai.client.token.usage delta metric export. Bounded window (not just
// ">= sinceMs") so a slow tick can't double-count rows a later tick would
// also pick up.
export async function sumTokenUsageWindow(sinceSec: number, untilSec: number): Promise<TokenUsageMetricRow[]> {
  return dbx.all<TokenUsageMetricRow>(`
    SELECT
      agent,
      model,
      tenant_id,
      SUM(input_tokens)          AS input_tokens,
      SUM(output_tokens)         AS output_tokens,
      SUM(cache_read_tokens)     AS cache_read_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens,
      SUM(thinking_tokens)       AS thinking_tokens
    FROM token_usage
    WHERE timestamp > ? AND timestamp <= ?
    GROUP BY agent, model, tenant_id
  `, sinceSec, untilSec)
}

// One token_usage row is one model response, so the per-response token count of the input and output
// side can be binned into the gen_ai.client.token.usage histogram. The bucket index is computed in SQL
// (the first bound >= the value, bounds.length for the open-ended last bucket), so a long backlog after an
// outage is aggregated by SQLite and not pulled into memory row by row. Zero values are not an observation.
export interface TokenHistogramRow {
  agent: string
  model: string | null
  tenant_id: string
  token_type: 'input' | 'output'
  bucket: number
  n: number
  total: number
  min_value: number
  max_value: number
}

function bucketCaseSql(column: string): string {
  const whens = GENAI_TOKEN_BUCKET_BOUNDS.map((bound, i) => `WHEN ${column} <= ${bound} THEN ${i}`).join(' ')
  return `CASE ${whens} ELSE ${GENAI_TOKEN_BUCKET_BOUNDS.length} END`
}

export async function tokenUsageHistogramWindow(sinceSec: number, untilSec: number): Promise<TokenHistogramRow[]> {
  const side = (column: 'input_tokens' | 'output_tokens', type: 'input' | 'output') => `
    SELECT agent, model, tenant_id, '${type}' AS token_type, ${bucketCaseSql(column)} AS bucket,
           COUNT(*) AS n, SUM(${column}) AS total, MIN(${column}) AS min_value, MAX(${column}) AS max_value
    FROM token_usage
    WHERE timestamp > @since AND timestamp <= @until AND ${column} > 0
    GROUP BY agent, model, tenant_id, bucket`
  return dbx.all<TokenHistogramRow>(`${side('input_tokens', 'input')} UNION ALL ${side('output_tokens', 'output')}`, { since: sinceSec, until: untilSec })
}

// ── B2B Tenant registry ───────────────────────────────────────────────────────

export interface Tenant {
  id: string
  display_name: string
  created_at: number
  disabled_at: number | null
  main_agent_id: string | null
}

export async function createTenant(id: string, displayName: string): Promise<Tenant> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run('INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)', id, displayName, now)
  return { id, display_name: displayName, created_at: now, disabled_at: null, main_agent_id: null }
}

export async function getTenant(id: string): Promise<Tenant | undefined> {
  return dbx.get<Tenant>('SELECT * FROM tenants WHERE id = ?', id)
}

export async function listTenants(includeDisabled = false): Promise<Tenant[]> {
  if (includeDisabled) {
    return dbx.all<Tenant>('SELECT * FROM tenants ORDER BY created_at ASC')
  }
  return dbx.all<Tenant>('SELECT * FROM tenants WHERE disabled_at IS NULL ORDER BY created_at ASC')
}

/** The tenant, if any, whose main_agent_id is this agent -- drives the
 *  Agents screen's tenant-main-agent badge. */
export async function getTenantForMainAgent(agentId: string): Promise<Tenant | undefined> {
  return dbx.get<Tenant>('SELECT * FROM tenants WHERE main_agent_id = ? AND disabled_at IS NULL', agentId)
}

export async function updateTenant(id: string, patch: { display_name?: string; disabled?: boolean; main_agent_id?: string }): Promise<Tenant | null> {
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.display_name !== undefined) {
    fields.push('display_name = ?')
    params.push(patch.display_name)
  }
  if (patch.main_agent_id !== undefined) {
    fields.push('main_agent_id = ?')
    params.push(patch.main_agent_id)
  }
  if (patch.disabled === true) {
    fields.push('disabled_at = ?')
    params.push(now)
  } else if (patch.disabled === false) {
    fields.push('disabled_at = NULL')
  }
  params.push(id)
  // The read of the old row, the update and the context drop are ONE transaction: a crash or a failure between the
  // last two would leave a disabled tenant (or one with a new main agent) with the use-time context of its old
  // state, which the skill gate trusts, and the "main agent changed" decision must see the row it overwrites.
  return dbx.tx(async (tx): Promise<Tenant | null> => {
    const existing = await tx.get<Tenant>('SELECT * FROM tenants WHERE id = ?', id)
    if (!existing) return null
    if (fields.length === 0) return existing
    await tx.run(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`, ...params)
    // Disabling the tenant or changing its main agent ends the use-time tenant context of every agent that was
    // serving it (the skill gate fails closed until each agent's next prompt re-resolves the source).
    if (patch.disabled === true || (patch.main_agent_id !== undefined && patch.main_agent_id !== existing.main_agent_id)) {
      await tx.run('DELETE FROM agent_tenant_context WHERE tenant_id = ?', id)
    }
    return (await tx.get('SELECT * FROM tenants WHERE id = ?', id)) as Tenant
  })
}

// Tables whose rows belong to a tenant by a plain `tenant_id` column and are purged with one
// `DELETE ... WHERE tenant_id = ?` (no children, no vector sync, no agent keying). The drift guard
// in the tests walks every `tenant_id` table against the three sets below, so a table added by a
// later migration is a red test until someone decides where it belongs.
export const TENANT_PURGE_SIMPLE_TABLES = [
  'conversation_log',
  // The server-side channel record (migration 0086): the adopted chats and the baseline of a channel's files.
  'channel_allowed_chats', 'channel_credential_baseline',
  // The interrupted-turn journal keeps a preview of a prompt (migration 0085): tenant data.
  'agent_inflight_turns',
  'cost_budgets',
  'egress_allowlist',
  'idea_box',
  'vault_bindings',
  'token_usage',
  'fleet_blackboard_history',
  // Names the tenant's users (principal column): tenant data, not fleet-wide audit evidence.
  'rbac_shadow_log',
  // Telemetry and journals stamped with a tenant by migration 0077. Rows of a shared agent that
  // could not be told apart ('_multi_') or were never resolved (NULL) belong to no single tenant
  // and stay. labels also drops its card links first (see deleteTenant).
  'otel_spans', 'daily_logs', 'task_runs', 'background_tasks', 'skill_usage', 'store_file_audit',
  'token_usage_daily', 'token_usage_monthly', 'cost_line_items', 'labels',
] as const

// Agent-keyed tables: `tenant_id` says who wrote the row, not who owns it, so the purge decides per
// agent (see the exclusive-agent rule in deleteTenant).
export const TENANT_PURGE_AGENT_KEYED_TABLES = ['agent_settings', 'agent_state', 'fleet_blackboard'] as const

// Tables deleteTenant handles with its own statements (children, vec0 sync, FK order, file I/O).
export const TENANT_PURGE_HANDLED_TABLES = [
  'approval_events', 'approvals', 'agent_messages', 'agent_tenant_context', 'artifacts', 'dashboard_users', 'device_keys',
  'import_audit_log', 'import_memories', 'import_sources', 'kanban_cards', 'memories', 'partner_senders',
  'schedules', 'skill_tenant_access', 'skills', 'tenant_agent_availability', 'tenant_channel_bindings',
  'vault_ssh_keys', 'vault_ssh_servers', 'workspace_docs',
] as const

// Tables that deliberately keep their rows. api_tokens is a tombstone: the row stays for the access
// history (hash only, not reversible, the rotated_from chain stays intact) and revoked_at is set.
// agent_audit_log and hook_audit_log are the governance trail (who changed what, which hook said
// what): they carry a tenant_id so a tenant's auditor sees its own entries, but the entries outlive
// the tenant like the api_tokens tombstone does.
export const TENANT_PURGE_EXEMPT_TABLES = ['api_tokens', 'agent_audit_log', 'hook_audit_log'] as const

export interface TenantDeleteResult {
  memoriesDeleted: number
  secretsDeleted: number
  scheduleNames: string[]
  /** Rows removed per table by the tenant-keyed cleanups added on top of the original cascade. */
  purged: Record<string, number>
  /** Agents enabled for this tenant and for no other: their agent-keyed rows went with the tenant. */
  exclusiveAgents: string[]
}

// Permanently delete a tenant and all its associated data.
// Deletion order respects FK constraints and audit requirements:
//   1. Reject pending approvals first (before dashboard_users are gone).
//   2. Revoke api_tokens (tombstone: kept for access-history audit, revoked_at set).
//   3. Drop identity/access rows: dashboard_users, partner_senders, device_keys.
//   4. Drop all approvals (including now-rejected ones per Jonas 2026-08-30).
//   5. Drop agent_messages and import_memories.
//   6. Drop kanban child tables before kanban_cards.
//   7. Drop memories row-by-row with vec0 sync (safe path chosen 2026-08-30).
//   8. Drop artifacts (vec_artifacts cleaned by DELETE trigger).
//   9. Drop schedules, with their pending retries.
//  10. Drop skill_tenant_access before skills (FK; foreign_keys is on by default, so the order matters).
//  11. Drop skills.
//  12. Drop vec_workspace_docs then workspace_docs (app-level vec sync, no trigger).
//  13. Drop tenant_agent_availability, tenant_channel_bindings and agent_tenant_context
//      (the agents exclusive to the tenant are read BEFORE this step, the step erases the evidence).
//  14. Drop vault_ssh_servers (child of vault_ssh_keys by FK direction).
//  15. Drop vault_ssh_keys.
//  16. Drop the tenant row itself.
// The tenant-keyed leftovers (TENANT_PURGE_SIMPLE_TABLES, import_audit_log before import_sources)
// and the agent-keyed rows (agent_settings, agent_state, fleet_blackboard) are cleaned right before
// step 16. An agent-keyed row tagged with this tenant is deleted when its agent is exclusive to the
// tenant, and re-tagged to `default` when the agent also serves another tenant (its configuration
// outlives the tenant). The rollup tables token_usage_daily / _monthly carry tenant_id and are purged with the rest.
//
// Steps 0-16 are ONE dbx.tx and every statement in it runs on the tx handle (the approvals included: they are
// on the facade like every other table), so a failure anywhere rolls the whole SQL part back. The transaction
// body holds the facade lock: it has no file I/O. The one file step, the vault.json purge, runs AFTER the
// commit. Consequence: if the vault write fails (disk full, permission), the SQL part is already committed,
// the tenant row is gone and the promise rejects with the file error; its secrets stay in vault.json until a
// second call of this function (idempotent: every delete matches nothing, the purge runs again) removes them.
// The reverse order would delete the secrets of a tenant that a failed transaction then keeps.
// The 'default' tenant is permanently guarded and throws if passed.
export async function deleteTenant(tenantId: string): Promise<TenantDeleteResult> {
  if (tenantId === 'default') throw new Error('Cannot delete the default tenant')

  const sqlResult = await dbx.tx(async (tx): Promise<Omit<TenantDeleteResult, 'secretsDeleted'>> => {
    // 0. Agents exclusive to this tenant: exactly one enabled availability row, and it is this tenant's
    //    (the same reading as resolveAgentTenant). Must run before step 13 deletes the availability rows.
    const exclusiveAgents = (
      await tx.all<{ agent_id: string }>(
        `SELECT agent_id FROM tenant_agent_availability
          WHERE tenant_id = ? AND enabled = 1
            AND (SELECT COUNT(*) FROM tenant_agent_availability o WHERE o.agent_id = tenant_agent_availability.agent_id AND o.enabled = 1) = 1
          ORDER BY agent_id`,
        tenantId,
      )
    ).map((r) => r.agent_id)
    const purged: Record<string, number> = {}

    // 1. Reject pending approvals
    await tx.run(
      "UPDATE approvals SET status = 'rejected', resolved_at = unixepoch() WHERE tenant_id = ? AND status = 'pending'",
      tenantId,
    )

    // 2. Revoke api_tokens (tombstone -- keep row for audit, mark revoked)
    await tx.run('UPDATE api_tokens SET revoked_at = unixepoch() WHERE tenant_id = ? AND revoked_at IS NULL', tenantId)

    // 3. Drop identity/access rows
    await tx.run('DELETE FROM dashboard_users WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM partner_senders WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM device_keys WHERE tenant_id = ?', tenantId)

    // 4. Drop all approvals, and their journal
    await tx.run('DELETE FROM approval_events WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM approvals WHERE tenant_id = ?', tenantId)

    // 5. Drop messages and import memories
    await tx.run('DELETE FROM agent_messages WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM import_memories WHERE tenant_id = ?', tenantId)

    // 6. Drop kanban (child tables before parent)
    const cardIds = (
      await tx.all<{ id: string }>('SELECT id FROM kanban_cards WHERE tenant_id = ?', tenantId)
    ).map((r) => r.id)
    if (cardIds.length > 0) {
      const ph = cardIds.map(() => '?').join(', ')
      await tx.run(`DELETE FROM kanban_card_labels WHERE card_id IN (${ph})`, ...cardIds)
      await tx.run(`DELETE FROM kanban_card_events  WHERE card_id IN (${ph})`, ...cardIds)
      await tx.run(`DELETE FROM kanban_comments     WHERE card_id IN (${ph})`, ...cardIds)
    }
    await tx.run('DELETE FROM kanban_cards WHERE tenant_id = ?', tenantId)

    // 7. Drop memories -- row-by-row to keep vec0 index in sync. syncVecMemoryDelete is awaited INSIDE the
    //    body: it joins this transaction (same connection), so a rollback takes the vec entry delete with it.
    const memIds = (
      await tx.all<{ id: number }>('SELECT id FROM memories WHERE tenant_id = ?', tenantId)
    ).map((r) => r.id)
    for (const id of memIds) {
      await syncVecMemoryDelete(id)
      await tx.run('DELETE FROM memories WHERE id = ?', id)
    }

    // 8. Drop artifacts (vec_artifacts kept in sync by the vec_artifacts_ad DELETE trigger)
    await tx.run('DELETE FROM artifacts WHERE tenant_id = ?', tenantId)

    // 9. Drop schedules, with the retries still pending for them (a retry of a task that no
    //    longer exists would be re-injected into its agent). The names go back to the caller:
    //    the file mirror under ~/.claude/scheduled-tasks is outside this transaction.
    const scheduleNames = (
      await tx.all<{ id: string }>('SELECT id FROM schedules WHERE tenant_id = ?', tenantId)
    ).map((r) => r.id)
    await tx.run('DELETE FROM pending_task_retries WHERE task_name IN (SELECT id FROM schedules WHERE tenant_id = ?)', tenantId)
    await tx.run('DELETE FROM schedules WHERE tenant_id = ?', tenantId)

    // 10 & 11. Drop skill_tenant_access before skills (foreign_keys is on by default, so the order matters;
    //          explicit two-pass: access grants TO this tenant, then grants FROM its skills).
    await tx.run('DELETE FROM skill_tenant_access WHERE tenant_id = ?', tenantId)
    const skillIds = (
      await tx.all<{ id: string }>('SELECT id FROM skills WHERE tenant_id = ?', tenantId)
    ).map((r) => r.id)
    if (skillIds.length > 0) {
      const ph = skillIds.map(() => '?').join(', ')
      await tx.run(`DELETE FROM skill_tenant_access WHERE skill_id IN (${ph})`, ...skillIds)
      await tx.run(`DELETE FROM skill_files WHERE skill_id IN (${ph})`, ...skillIds)
    }
    await tx.run('DELETE FROM skills WHERE tenant_id = ?', tenantId)

    // 12. Drop workspace_docs -- vec_workspace_docs has no trigger, sync manually before main delete.
    // @sqlite-only: the sqlite-vec `vec0` table (the PostgreSQL phase moves it to pgvector).
    if (vecExtensionLoaded) {
      try { await tx.run('DELETE FROM vec_workspace_docs WHERE tenant_id = ?', tenantId) } catch { /* vec0 unavailable */ }
    }
    await tx.run('DELETE FROM workspace_docs WHERE tenant_id = ?', tenantId)

    // 13. Drop tenant_agent_availability (foreign_keys is on by default; the explicit delete is redundant with the cascade but harmless)
    await tx.run('DELETE FROM tenant_agent_availability WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM tenant_channel_bindings WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM agent_tenant_context WHERE tenant_id = ?', tenantId)

    // 14 & 15. Drop the vault SSH pool (child before parent by FK direction;
    //          foreign_keys is on by default, same as steps 10/13).
    await tx.run('DELETE FROM vault_ssh_servers WHERE tenant_id = ?', tenantId)
    await tx.run('DELETE FROM vault_ssh_keys WHERE tenant_id = ?', tenantId)

    // 15b. Tenant-keyed leftovers. import_audit_log goes before import_sources on purpose: the FK would
    //      cascade it, but a silent cascade is how 0041 once lost audit rows, so it is explicit and counted.
    purged.import_audit_log = (await tx.run('DELETE FROM import_audit_log WHERE tenant_id = ?', tenantId)).changes
    purged.import_sources = (await tx.run('DELETE FROM import_sources WHERE tenant_id = ?', tenantId)).changes
    // A label of this tenant can still be linked from a card of another tenant (links made before
    // labels carried a tenant): drop those links before the label rows go.
    await tx.run('DELETE FROM kanban_card_labels WHERE label_id IN (SELECT id FROM labels WHERE tenant_id = ?)', tenantId)
    for (const table of TENANT_PURGE_SIMPLE_TABLES) {
      purged[table] = (await tx.run(`DELETE FROM ${table} WHERE tenant_id = ?`, tenantId)).changes
    }

    // 15c. Agent-keyed rows tagged with this tenant: exclusive agent -> delete, anyone else -> re-tag.
    const exclusivePh = exclusiveAgents.map(() => '?').join(', ')
    for (const table of TENANT_PURGE_AGENT_KEYED_TABLES) {
      purged[table] = exclusiveAgents.length > 0
        ? (await tx.run(`DELETE FROM ${table} WHERE tenant_id = ? AND agent_id IN (${exclusivePh})`, tenantId, ...exclusiveAgents)).changes
        : 0
      purged[`${table}_retagged`] = (await tx.run(`UPDATE ${table} SET tenant_id = 'default' WHERE tenant_id = ?`, tenantId)).changes
    }

    // 16. Drop the tenant row
    await tx.run('DELETE FROM tenants WHERE id = ?', tenantId)

    return { memoriesDeleted: memIds.length, scheduleNames, purged, exclusiveAgents }
  })

  // agent_settings is one of TENANT_PURGE_AGENT_KEYED_TABLES above, written in the transaction,
  // bypassing the synchronous write-through cache (agent-settings-cache.ts). Reload it now the
  // transaction has committed -- database first, then the cache, same rule as every other writer of
  // that table. No await between the commit and the reload except the promise hop of dbx.tx itself.
  reloadAgentSettingsCache()

  // The one non-SQL step, after the commit (see the header): the vault.json entries of the tenant.
  let secretsDeleted: number
  try {
    secretsDeleted = purgeSecretsForTenant(tenantId)
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant deleted but its vault.json entries could not be purged: repeat the delete to remove them')
    throw err
  }

  return { ...sqlResult, secretsDeleted }
}

// ── B2B Dashboard user provisioning ──────────────────────────────────────────

/** Admin-controlled user provisioning: explicit role + tenant_id, no first-user-wins. */
export async function provisionDashboardUser(
  username: string,
  passwordHash: string,
  role: string,
  tenantId: string | null,
  email?: string | null,
  displayName?: string | null,
): Promise<DashboardUser> {
  const now = Math.floor(Date.now() / 1000)
  const { id } = (await dbx.get('INSERT INTO dashboard_users (username, password_hash, role, tenant_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id', username, passwordHash, role, tenantId, email ?? null, displayName ?? null, now, now)) as { id: number }
  return { id, username, password_hash: passwordHash, role, tenant_id: tenantId, email: email ?? null, display_name: displayName ?? null, created_at: now, updated_at: now, disabled: 0 }
}

export async function getDashboardUserById(id: number): Promise<DashboardUser | undefined> {
  return dbx.get<DashboardUser>('SELECT * FROM dashboard_users WHERE id = ?', id)
}

export interface ListUsersOpts {
  tenantId?: string | 'global'
  includeDisabled?: boolean
}

export async function listDashboardUsersFiltered(opts: ListUsersOpts = {}): Promise<DashboardUserPublic[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (!opts.includeDisabled) {
    conditions.push('disabled = 0')
  }
  if (opts.tenantId === 'global') {
    conditions.push('tenant_id IS NULL')
  } else if (opts.tenantId) {
    conditions.push('tenant_id = ?')
    params.push(opts.tenantId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return dbx.all<DashboardUserPublic>(`SELECT id, username, role, tenant_id, email, display_name, created_at, updated_at, disabled FROM dashboard_users ${where} ORDER BY username COLLATE NOCASE`, ...params)
}

export interface AdminUserPatch {
  role?: string
  tenant_id?: string | null
  password_hash?: string
  disabled?: boolean
  email?: string | null
  display_name?: string | null
}

export type AdminPatchOutcome =
  | { status: 'updated'; user: DashboardUser }
  | { status: 'last_admin' }
  | { status: 'not_found' }

/**
 * The patch that takes an active admin out of the active-admin count: a role other than admin, or disabled.
 * Only such a patch carries the last-admin condition.
 */
function patchLeavesAdmin(patch: AdminUserPatch): boolean {
  return (patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true
}

/**
 * One conditional UPDATE ... RETURNING decides and writes: a patch that makes the last active admin a non-admin or
 * disabled matches no row (the count condition is evaluated by the same statement that writes, so two concurrent
 * demotions of the two remaining admins cannot both pass: exactly one changes a row). The same compare-and-set as
 * deleteDashboardUserKeepingLastAdmin (sessions.ts), for the role change and the disabled flag together.
 * 'last_admin' and 'not_found' are told apart by a read AFTER the refused write; only the answer depends on it.
 */
export async function adminPatchDashboardUser(id: number, patch: AdminUserPatch): Promise<AdminPatchOutcome> {
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.role !== undefined) { fields.push('role = ?'); params.push(patch.role) }
  if ('tenant_id' in patch) { fields.push('tenant_id = ?'); params.push(patch.tenant_id ?? null) }
  if (patch.password_hash !== undefined) { fields.push('password_hash = ?'); params.push(patch.password_hash) }
  if (patch.disabled !== undefined) { fields.push('disabled = ?'); params.push(patch.disabled ? 1 : 0) }
  if ('email' in patch) { fields.push('email = ?'); params.push(patch.email ?? null) }
  if ('display_name' in patch) { fields.push('display_name = ?'); params.push(patch.display_name ?? null) }
  params.push(id)
  const guard = patchLeavesAdmin(patch)
    ? " AND NOT (role = 'admin' AND disabled = 0 AND (SELECT COUNT(*) FROM dashboard_users WHERE role = 'admin' AND disabled = 0) <= 1)"
    : ''
  const user = await dbx.get<DashboardUser>(`UPDATE dashboard_users SET ${fields.join(', ')} WHERE id = ?${guard} RETURNING *`, ...params)
  if (user) return { status: 'updated', user }
  return (await dbx.get('SELECT 1 AS present FROM dashboard_users WHERE id = ?', id)) ? { status: 'last_admin' } : { status: 'not_found' }
}

export async function countActiveAdmins(): Promise<number> {
  return ((await dbx.get("SELECT COUNT(*) AS c FROM dashboard_users WHERE role = 'admin' AND disabled = 0")) as { c: number }).c
}

// Prefix that marks a message as a completion report / acknowledgement.
// Used by shouldNotifyDelegator to avoid ping-pong chains.
export const COMPLETION_REPORT_PREFIX = '[Eredmény]'

// ── Partner Senders ───────────────────────────────────────────────────────────

export interface PartnerSender {
  sender_id: string
  tenant_id: string
  display_name: string
  created_by: string
  created_at: number
  disabled_at: number | null
}

export async function isAuthorizedPartnerSender(senderId: string, tenantId: string): Promise<boolean> {
  const row = await dbx.get('SELECT 1 FROM partner_senders WHERE sender_id = ? AND tenant_id = ? AND disabled_at IS NULL', senderId, tenantId)
  return row != null
}

export async function listPartnerSenders(tenantId?: string): Promise<PartnerSender[]> {
  if (tenantId != null) {
    return dbx.all<PartnerSender>('SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders WHERE tenant_id = ? ORDER BY created_at ASC', tenantId)
  }
  return dbx.all<PartnerSender>('SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders ORDER BY tenant_id, created_at ASC')
}

export async function createPartnerSender(senderId: string, tenantId: string, displayName: string, createdBy: string): Promise<PartnerSender> {
  // One statement: the row the caller gets back is the row this INSERT wrote (a separate read-back could meet a
  // concurrent disable or tenant delete and return nothing). A duplicate key rejects with the driver's constraint error.
  return (await dbx.get(
    'INSERT INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, ?, ?) RETURNING sender_id, tenant_id, display_name, created_by, created_at, disabled_at',
    senderId, tenantId, displayName, createdBy,
  )) as PartnerSender
}

export async function disablePartnerSender(senderId: string, tenantId: string): Promise<boolean> {
  const result = await dbx.run('UPDATE partner_senders SET disabled_at = unixepoch() WHERE sender_id = ? AND tenant_id = ? AND disabled_at IS NULL', senderId, tenantId)
  return result.changes > 0
}

// ── Token usage (token_usage, token_usage_cursors) ───────────────────
// Persistence and reporting queries for the transcript collector in
// web/token-usage.ts, which keeps the JSONL discovery and parsing.

export interface TokenUsageCall {
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  thinkingTokens: number
  model: string | null
  contentPreview: string
  toolName: string | null
}

export async function getTokenUsageCursor(filePath: string): Promise<{ last_line: number; last_size: number } | undefined> {
  return dbx.get<{ last_line: number; last_size: number }>('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?', filePath)
}

export async function setTokenUsageCursor(filePath: string, lastLine: number, lastSize: number): Promise<void> {
  await dbx.run(`INSERT INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET last_line = excluded.last_line, last_size = excluded.last_size`, filePath, lastLine, lastSize)
}

/** Upserts a file's parsed calls and advances its cursor in one transaction. */
export function recordTokenUsageCalls(
  calls: TokenUsageCall[],
  tenantId: string,
  filePath: string,
  linesRead: number,
  fileSize: number,
): void {
  const insertCall = db.prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
      model = CASE WHEN token_usage.model IS NULL AND excluded.model IS NOT NULL THEN excluded.model ELSE token_usage.model END,
      thinking_tokens = CASE WHEN (token_usage.thinking_tokens IS NULL OR token_usage.thinking_tokens = 0) AND excluded.thinking_tokens > 0 THEN excluded.thinking_tokens ELSE token_usage.thinking_tokens END,
      cache_creation_tokens = CASE WHEN (token_usage.cache_creation_tokens IS NULL OR token_usage.cache_creation_tokens = 0) AND excluded.cache_creation_tokens > 0 THEN excluded.cache_creation_tokens ELSE token_usage.cache_creation_tokens END,
      cache_read_tokens = CASE WHEN (token_usage.cache_read_tokens IS NULL OR token_usage.cache_read_tokens = 0) AND excluded.cache_read_tokens > 0 THEN excluded.cache_read_tokens ELSE token_usage.cache_read_tokens END,
      tenant_id = excluded.tenant_id
  `)
  db.transaction(() => {
    for (const c of calls) {
      insertCall.run(
        c.agent, c.sessionId, c.timestamp,
        c.inputTokens, c.outputTokens,
        c.cacheReadTokens, c.cacheCreationTokens,
        c.thinkingTokens, c.model,
        c.contentPreview || null, c.toolName,
        tenantId,
      )
    }
    setTokenUsageCursor(filePath, linesRead, fileSize)
  })()
}

export interface TokenSummaryModelRow {
  model: string | null
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalThinking: number
}

export interface TokenSummary {
  agent: string
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalThinking: number
  totalSessions: number
  firstSeen: number
  lastSeen: number
  perModel: TokenSummaryModelRow[]
}

export async function getTokenSummary(from?: number, to?: number): Promise<TokenSummary[]> {
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''

  const rows = (await dbx.all(`
    SELECT agent,
      COUNT(*) as totalCalls,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      SUM(thinking_tokens) as totalThinking,
      COUNT(DISTINCT session_id) as totalSessions,
      MIN(timestamp) as firstSeen,
      MAX(timestamp) as lastSeen
    FROM token_usage
    ${where}
    GROUP BY agent ORDER BY totalInput DESC
  `, ...params)) as Omit<TokenSummary, 'perModel'>[]

  const modelRows = (await dbx.all(`
    SELECT agent, model,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      SUM(thinking_tokens) as totalThinking
    FROM token_usage
    ${where}
    GROUP BY agent, model
  `, ...params)) as (TokenSummaryModelRow & { agent: string })[]

  const byAgent = new Map<string, TokenSummaryModelRow[]>()
  for (const mr of modelRows) {
    const { agent, ...rest } = mr as { agent: string } & TokenSummaryModelRow
    if (!byAgent.has(agent)) byAgent.set(agent, [])
    byAgent.get(agent)!.push(rest)
  }

  return rows.map(r => ({ ...r, perModel: byAgent.get(r.agent) ?? [] }))
}

export interface TokenUsageWindowModelRow {
  model: string | null
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** One agent's token rows with `from <= timestamp < to`, summed per model. */
export async function sumTokenUsageByModel(agent: string, from: number, to: number): Promise<TokenUsageWindowModelRow[]> {
  return dbx.all<TokenUsageWindowModelRow>(`
    SELECT model, COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens
    FROM token_usage
    WHERE agent = ? AND timestamp >= ? AND timestamp < ?
    GROUP BY model
  `, agent, from, to)
}

/** Timestamp of the newest token row of one agent, or null when it has none. */
export async function getLastTokenUsageTimestamp(agent: string): Promise<number | null> {
  const row = (await dbx.get('SELECT MAX(timestamp) AS ts FROM token_usage WHERE agent = ?', agent)) as { ts: number | null }
  return row.ts ?? null
}

export interface ModelDistEntry {
  model: string
  count: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalThinking: number
}

export async function getModelDistribution(from?: number, to?: number, agent?: string): Promise<ModelDistEntry[]> {
  const hasModelCol = (await dbx.get("SELECT COUNT(*) as n FROM pragma_table_info('token_usage') WHERE name='model'")) as { n: number }
  if (!hasModelCol.n) return []

  let sql = `
    SELECT model,
      COUNT(*) as count,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      SUM(thinking_tokens) as totalThinking
    FROM token_usage
  `
  const conditions: string[] = [
    "model IS NOT NULL",
    "model != ''",
    "model != '<synthetic>'",
  ]
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY model ORDER BY count DESC'

  return dbx.all<ModelDistEntry>(sql, ...params)
}

export interface ToolStatEntry {
  tool_name: string
  model: string | null
  count: number
  agents: string
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalThinking: number
}

export async function getToolStats(from?: number, to?: number, agent?: string): Promise<ToolStatEntry[]> {
  let sql = `
    SELECT tool_name,
      model,
      COUNT(*) as count,
      GROUP_CONCAT(DISTINCT agent) as agents,
      SUM(input_tokens) as totalInput,
      SUM(output_tokens) as totalOutput,
      SUM(cache_read_tokens) as totalCacheRead,
      SUM(cache_creation_tokens) as totalCacheCreation,
      SUM(thinking_tokens) as totalThinking
    FROM token_usage
    WHERE tool_name IS NOT NULL
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' AND ' + conditions.join(' AND ')
  sql += ' GROUP BY tool_name, model ORDER BY count DESC'

  return dbx.all<ToolStatEntry>(sql, ...params)
}

export interface TimelineBucket {
  bucket: number
  agent: string
  calls: number
  inputTokens: number
  outputTokens: number
}

export async function getTokenTimeline(
  bucketMinutes: number = 60,
  from?: number,
  to?: number,
  agent?: string,
): Promise<TimelineBucket[]> {
  const bucketSeconds = bucketMinutes * 60
  let sql = `
    SELECT
      (timestamp / ${bucketSeconds}) * ${bucketSeconds} as bucket,
      agent,
      COUNT(*) as calls,
      SUM(input_tokens + cache_read_tokens + cache_creation_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens
    FROM token_usage
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY bucket, agent ORDER BY bucket ASC'

  return dbx.all<TimelineBucket>(sql, ...params)
}

export interface TokenDetail {
  id: number
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  thinkingTokens: number
  model: string | null
  contentPreview: string | null
  toolName: string | null
  taskTitle: string | null
  project: string | null
}

export async function getTokenDetails(
  opts: { agent?: string; from?: number; to?: number; limit?: number; offset?: number; minTokens?: number; q?: string },
): Promise<TokenDetail[]> {
  let sql = `SELECT * FROM token_usage`
  const conditions: string[] = []
  const params: any[] = []
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.from) { conditions.push('timestamp >= ?'); params.push(opts.from) }
  if (opts.to) { conditions.push('timestamp <= ?'); params.push(opts.to) }
  if (opts.minTokens) {
    conditions.push('(input_tokens + cache_read_tokens + cache_creation_tokens) >= ?')
    params.push(opts.minTokens)
  }
  if (opts.q) {
    const like = `%${opts.q}%`
    conditions.push('(agent LIKE ? OR tool_name LIKE ? OR content_preview LIKE ? OR task_title LIKE ?)')
    params.push(like, like, like, like)
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY timestamp DESC'
  sql += ' LIMIT ? OFFSET ?'
  params.push(opts.limit || 100, opts.offset || 0)

  return dbx.all<TokenDetail>(sql, ...params)
}

export async function correlateWithKanban(): Promise<void> {
  const uncorrelated = (await dbx.all(`
    SELECT DISTINCT agent, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
    FROM token_usage
    WHERE task_title IS NULL
    GROUP BY agent
  `)) as { agent: string; minTs: number; maxTs: number }[]

  for (const row of uncorrelated) {
    const cards = await dbx.all<any>(`
      SELECT id, title, project, assignee, updated_at
      FROM kanban_cards
      WHERE (assignee = ? OR assignee LIKE '%' || ? || '%')
        AND updated_at BETWEEN ? AND ?
      ORDER BY updated_at ASC
    `, row.agent, row.agent, row.minTs, row.maxTs)

    for (const card of cards) {
      const nextCard = cards.find((c: any) => c.updated_at > card.updated_at)
      const endTs = nextCard ? nextCard.updated_at : row.maxTs

      await dbx.run(`
        UPDATE token_usage
        SET task_title = ?, project = ?
        WHERE agent = ? AND timestamp BETWEEN ? AND ? AND task_title IS NULL
      `, card.title, card.project || null, row.agent, card.updated_at, endTs)
    }
  }
}

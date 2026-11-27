// The gate-audit write of the PreToolUse gates, served from the serving backend (POST /api/v1/hooks/gate-audit).
//
// The seven gates of scripts/hooks/gate_audit_lib.py (stdlib Python, no database driver) count every decision in
// gate_decision_counts and file a 'deny' row in hook_audit_log. On a SQLite install the hook writes the file itself; in
// PostgreSQL mode it sends ONE request and this module writes both, in ONE transaction: a deny row never exists without its
// count, and a partial write is never acknowledged (the same semantic as the file writer).
//
// ONE named system job, `hook-gate-audit`. Why a system context: a gate process cannot resolve a tenant, so the SERVER stamps it
// from the token's agent (resolveWriteTenant; NULL for a shared agent with no fresh context), and under row-level security a NULL tenant on hook_audit_log is writable by a
// privileged context only (class B), as is the whole of gate_decision_counts (class D2). The statements are FIXED text with bound
// parameters, every value was validated by the route, and the agent id is the caller's TOKEN (the route takes it from the
// token, never from the body).
import { dbx } from './facade.js'
import { systemJob } from './background-jobs.js'
import { callerTraceId, currentTraceColumns } from './context.js'
import { resolveWriteTenantAt } from './write-tenant.js'

/** One running-count increment: how often `gate` ended in `decision` for `reason` since the last request. */
export interface GateCountIncrement {
  gate: string
  decision: string
  reason: string
  n: number
}

/** One deny row: gate, reason code, the time the gate decided, and the session id as the trace id (a deny only). */
export interface GateDenyRow {
  gate: string
  reason: string
  ts: number
  trace_id: string | null
}

/**
 * Write the increments and the deny rows of one caller in one transaction. The route has validated and clamped everything.
 * A failure anywhere rolls the whole request back, so the hook sees an error and keeps its spooled denies.
 */
export const recordGateAudit = systemJob('hook-gate-audit', async (agentId: string, counts: GateCountIncrement[], denies: GateDenyRow[]): Promise<{ counts: number; denies: number }> => {
  const now = Math.floor(Date.now() / 1000)
  // The tenant of a deny row is stamped HERE from the token's agent, never from the body: the agent's serving tenant, the one it serves,
  // 'default' for a fleet-internal agent, and NULL only when the resolver says so (a shared agent with no fresh tenant context: the row
  // says "unknown"). Resolved once per request, before the transaction (it reads agent_tenant_context and the availability).
  //
  // A deny row may be DELAYED (drained from the spool, decided earlier than it is written), and the resolver answers "now". For an
  // agent serving 2+ tenants whose tenant comes from the fresh context row, that tenant holds from the context row's updated_at on:
  // a deny decided BEFORE it (ts < updated_at) is stamped NULL ("unknown"), never with the tenant of a later request (cross-tenant
  // misattribution of audit evidence). Equality stamps. An agent serving one tenant or none keeps the resolver's answer with no time
  // condition. The route clamps a ts outside [now - 7 d, now + 60 s] to now, and a ts a minute ahead beats the context row's time exactly as a current one does, so a future ts wins nothing a present one would not.
  const resolved = denies.length > 0 ? await resolveWriteTenantAt(agentId) : { tenantId: null, sharedContextSince: null }
  const tenantOf = (ts: number): string | null =>
    resolved.sharedContextSince !== null && ts < resolved.sharedContextSince ? null : resolved.tenantId
  await dbx.tx(async (tx) => {
    for (const c of counts) {
      await tx.run(
        'INSERT INTO gate_decision_counts (gate, decision, reason, count, first_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(gate, decision, reason) DO UPDATE SET count = gate_decision_counts.count + excluded.count, updated_at = excluded.updated_at',
        c.gate, c.decision, c.reason, c.n, now, now,
      )
    }
    for (const d of denies) {
      // A named session trace (the raw session id the hook gives) has no server span of its own: the request span of this very
      // POST belongs to another trace. Without a usable name the row carries the server's own trace, as every writer does.
      const named = callerTraceId(d.trace_id)
      const [traceId, spanId] = named ? [named, null] : currentTraceColumns()
      await tx.run(
        'INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id, trace_id, span_id) '
        + 'VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)',
        d.ts, agentId, 'PreToolUse', 'deny', d.reason, d.gate, tenantOf(d.ts), traceId, spanId,
      )
    }
  })
  return { counts: counts.length, denies: denies.length }
})

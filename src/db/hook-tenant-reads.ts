// The reads (and the one write) of the tenant gates of the hooks, served from the serving backend.
//
// The tenant hooks (scripts/hooks/tenant-context.py, tenant-skill-gate.py) are stdlib Python without a database driver. On a
// SQLite install they read the file themselves; on PostgreSQL they ask the dashboard through /api/v1/hooks/*, and this module
// answers. It returns FACTS, never a verdict: the policy (what a message, a binding or a grant means for the gate) stays in
// the hook (tenant_context_lib.py), so the rule exists once and the SQLite path is unchanged.
//
// ONE system job, `hook-tenant-reads`, for the three entry points. Why a system context: the tables are row-level secured by
// tenant, and the facts are cross-tenant by nature (a message stamped with another tenant than the agent's current context,
// the grants of a skill, an `unknown` context row whose tenant is ''). The queries are FIXED text with bound parameters and
// the agent id is the caller's (taken from the token by the route, never from a query or a body). Ownership is checked here
// too: a message counts only when it is addressed to that agent.
//
// The SQL below mirrors the lookups of tenant_context_lib.py one to one (a differential cell runs both on the same fixtures).
import { dbx } from './facade.js'
import { kanbanSeqColumn } from './kanban.js'
import { systemJob } from './background-jobs.js'
import { agentServesTenant } from './tenant-channel-bindings.js'

export type HookSource =
  | { kind: 'channel'; channel: string; external_id: string }
  | { kind: 'message'; msg_id: number }
  | { kind: 'scheduled'; name: string }

export interface HookSourceFacts {
  kind: HookSource['kind']
  /** message: the row, only when it is addressed to the caller; otherwise null (the hook reads "not found or not for this agent"). */
  message?: { to_agent: string; from_agent: string | null; tenant_id: string | null } | null
  /** channel: the binding tenant of (caller, channel, external id), null when there is none. */
  binding?: string | null
  /** message: the binding tenant of (caller, 'inter-agent', the sender of the message), null when there is none. */
  inter_agent_binding?: string | null
  /** scheduled: the task of the caller (tenant_id may be null), null when the caller has no such task. */
  schedule?: { tenant_id: string | null } | null
}

export interface HookTenantFacts {
  sources: HookSourceFacts[]
  /** For every tenant id the facts surface (not the default tenant): does the caller still serve it. */
  serves: Record<string, boolean>
}

export interface HookContextRow {
  status: string
  tenant_id: string
  source: string
  session_id: string
  updated_at: number
}

export interface HookSkillRow {
  id: string
  name: string | null
  content: string | null
  tenant_id: string
  granted: string[]
}

const DEFAULT_TENANT = 'default'

async function bindingOf(agentId: string, channel: string, externalId: string): Promise<string | null> {
  const row = await dbx.get<{ tenant_id: string | null }>(
    'SELECT tenant_id FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?',
    agentId, channel, externalId,
  )
  return row ? row.tenant_id : null
}

/** The facts of the sources of one prompt, for ONE agent. Pure reads. */
export const getHookTenantFacts = systemJob('hook-tenant-reads', async (agentId: string, sources: HookSource[]): Promise<HookTenantFacts> => {
  const out: HookSourceFacts[] = []
  const tenants = new Set<string>()
  const note = (t: string | null | undefined): void => { if (t && t !== DEFAULT_TENANT) tenants.add(t) }
  for (const src of sources) {
    if (src.kind === 'channel') {
      const binding = await bindingOf(agentId, src.channel, src.external_id)
      note(binding)
      out.push({ kind: 'channel', binding })
    } else if (src.kind === 'message') {
      const row = await dbx.get<{ to_agent: string; from_agent: string | null; tenant_id: string | null }>(
        'SELECT to_agent, from_agent, tenant_id FROM agent_messages WHERE id = ?', src.msg_id,
      )
      if (!row || row.to_agent !== agentId) { out.push({ kind: 'message', message: null }); continue }
      note(row.tenant_id)
      // the binding of the sender is only consulted when the message carries no tenant of its own (as the hook does), but the
      // fact is cheap and the hook decides: it is sent either way
      const inter = await bindingOf(agentId, 'inter-agent', row.from_agent || '')
      note(inter)
      out.push({ kind: 'message', message: { to_agent: row.to_agent, from_agent: row.from_agent, tenant_id: row.tenant_id }, inter_agent_binding: inter })
    } else {
      const row = await dbx.get<{ tenant_id: string | null }>('SELECT tenant_id FROM schedules WHERE id = ? AND agent = ?', src.name, agentId)
      if (row) note(row.tenant_id)
      out.push({ kind: 'scheduled', schedule: row ? { tenant_id: row.tenant_id } : null })
    }
  }
  const serves: Record<string, boolean> = {}
  for (const t of tenants) serves[t] = await agentServesTenant(agentId, t)
  return { sources: out, serves }
})

/** The recorded tenant context of the agent, and whether a `bound` one is still served (an unbound context serves trivially). */
export const getHookContext = systemJob('hook-tenant-reads', async (agentId: string): Promise<{ context: HookContextRow | null; serves: boolean }> => {
  const row = await dbx.get<HookContextRow>(
    'SELECT status, tenant_id, source, session_id, updated_at FROM agent_tenant_context WHERE agent_id = ?', agentId,
  )
  if (!row) return { context: null, serves: true }
  const serves = row.status !== 'bound' ? true : await agentServesTenant(agentId, row.tenant_id)
  return { context: row, serves }
})

/** Every non-fleet skill with its grants. The route narrows it to the named targets and strips the content. */
export const listHookTenantSkills = systemJob('hook-tenant-reads', async (): Promise<HookSkillRow[]> => {
  const rows = await dbx.all<{ id: string; name: string | null; content: string | null; tenant_id: string }>(
    "SELECT id, name, content, tenant_id FROM skills WHERE tenant_id != 'fleet'",
  )
  const grants = new Map<string, string[]>()
  for (const g of await dbx.all<{ skill_id: string; tenant_id: string }>('SELECT skill_id, tenant_id FROM skill_tenant_access')) {
    const list = grants.get(g.skill_id) ?? []
    list.push(g.tenant_id)
    grants.set(g.skill_id, list)
  }
  return rows.map((r) => ({ ...r, granted: grants.get(r.id) ?? [] }))
})

/**
 * The idempotent upsert of the caller's own context row (one row per agent). The semantics of the hook are kept: the new row
 * REPLACES the old one, so an old tenant never survives a newer prompt. `unknown` and `conflict` carry an empty tenant, which a
 * tenant-scoped write would refuse: that is the second reason for the system context.
 */
export const recordHookContext = systemJob('hook-tenant-reads', async (agentId: string, status: string, tenantId: string, source: string, sessionId: string): Promise<boolean> => {
  // The caller cannot assert a tenant it does not serve: a `bound` context needs the agent to be enabled for that tenant now
  // (the hook only ever writes one after the same check), and a `default` context carries the default tenant and nothing else.
  // The readers (getServingTenant, the write tenant) take row.tenant_id of a `default` row without a serves check, so the
  // value of that row must be pinned here.
  if (status === 'default' && tenantId !== DEFAULT_TENANT) return false
  if (status === 'bound' && (tenantId === DEFAULT_TENANT || !(await agentServesTenant(agentId, tenantId)))) return false
  await dbx.run(
    `INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET tenant_id = excluded.tenant_id, status = excluded.status, source = excluded.source,
       session_id = excluded.session_id, updated_at = excluded.updated_at`,
    agentId, tenantId, status, source, sessionId, Math.floor(Date.now() / 1000),
  )
  return true
})

// ---------------------------------------------------------------------------------------------------------------------
// The context watchdog (scripts/hooks/context-watchdog.py) reads, served in PG mode through POST /api/v1/hooks/watchdog-facts.
//
// UNLIKE the tenant reads above these run in the REQUEST tenant context (no system job): the facts are not cross-tenant by
// nature. The caller's own blackboard row, the latest blackboard rows, its open cards and its last outgoing message are read
// through the row-level policies of the caller's tenant, so another tenant's rows never come back. (The SQLite hook read every
// blackboard row of the fleet, a cross-tenant read that was never a feature.)
//
// FACTS only, no text: the HANDOFF wording and every policy (threshold default, what counts as open work) stay in the hook.
// Fixed SQL, bound parameters, hard LIMITs and string clips here too, so the answer is bounded whatever a row holds.

/** Clips (characters). They equal the hook's own (HANDOFF_SUMMARY_MAX_CHARS, the 300 of the last outgoing message). */
export const WATCHDOG_SUMMARY_MAX = 600
export const WATCHDOG_LAST_OUT_MAX = 300
export const WATCHDOG_TITLE_MAX = 300
export const WATCHDOG_RECENT_LIMIT = 3
export const WATCHDOG_CARDS_LIMIT = 5

export interface WatchdogHandoffFacts {
  /** The caller's own blackboard row, null when it has none. */
  own: { task_ref: string | null; status: string; summary: string } | null
  /** The latest rows of the caller's tenant (the caller's own row included), newest first. */
  recent: Array<{ agent_id: string; status: string; summary: string }>
  /** The caller's open cards (in_progress, waiting, not archived), newest first. `number` is the number the dashboard shows. */
  cards: Array<{ number: number; title: string; status: string }>
  /** The content of the caller's last outgoing message, null when it sent none. */
  last_outgoing: string | null
}

const clip = (v: unknown, max: number): string => String(v ?? '').slice(0, max)

/**
 * thresholdTokens of the caller's context_restart_gate setting: a positive integer, or null when there is no row, the value is
 * not JSON, or the number is missing or not positive. The hook decides the default for null (never guessed here).
 */
export async function getWatchdogThreshold(agentId: string): Promise<number | null> {
  const row = await dbx.get<{ setting_value: string }>(
    "SELECT setting_value FROM agent_settings WHERE agent_id = ? AND setting_key = 'context_restart_gate'", agentId,
  )
  if (!row) return null
  try {
    const parsed: unknown = JSON.parse(row.setting_value)
    const v = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['thresholdTokens'] : undefined
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null
  } catch {
    return null
  }
}

/** The facts the HANDOFF is built from, for ONE agent, in the caller's request tenant context. Pure reads. */
export async function getWatchdogHandoffFacts(agentId: string): Promise<WatchdogHandoffFacts> {
  // The number a card carries on the dashboard: the SQLite rowid, or the identity column `seq` in PostgreSQL (kanban.ts).
  const numberCol = kanbanSeqColumn()
  const own = await dbx.get<{ task_ref: string | null; status: string; summary: string }>(
    'SELECT task_ref, status, summary FROM fleet_blackboard WHERE agent_id = ?', agentId,
  )
  const recent = await dbx.all<{ agent_id: string; status: string; summary: string }>(
    'SELECT agent_id, status, summary FROM fleet_blackboard ORDER BY updated_at DESC LIMIT ?', WATCHDOG_RECENT_LIMIT,
  )
  const cards = await dbx.all<{ number: number | string; title: string; status: string }>(
    `SELECT ${numberCol} AS number, title, status FROM kanban_cards
     WHERE assignee = ? AND status IN ('in_progress', 'waiting') AND archived_at IS NULL
     ORDER BY updated_at DESC LIMIT ?`,
    agentId, WATCHDOG_CARDS_LIMIT,
  )
  const lastOut = await dbx.get<{ content: string }>(
    'SELECT content FROM agent_messages WHERE from_agent = ? ORDER BY created_at DESC LIMIT 1', agentId,
  )
  return {
    own: own ? { task_ref: own.task_ref ?? null, status: own.status, summary: clip(own.summary, WATCHDOG_SUMMARY_MAX) } : null,
    recent: recent.map((r) => ({ agent_id: r.agent_id, status: r.status, summary: clip(r.summary, WATCHDOG_SUMMARY_MAX) })),
    // a PostgreSQL bigint can come back as a string: the number is an integer in the answer either way
    cards: cards.map((c) => ({ number: Number(c.number), title: clip(c.title, WATCHDOG_TITLE_MAX), status: c.status })),
    last_outgoing: lastOut ? clip(lastOut.content, WATCHDOG_LAST_OUT_MAX) : null,
  }
}

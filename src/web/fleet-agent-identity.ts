// Who a fleet_agent token lets its holder act as. A fleet agent's token names the agent
// (api_tokens.agent_id, resolved into ctx.tokenAgentId by the auth gate), so an endpoint that takes
// an agent id in its path, query or body can hold the caller to its own: a request that names
// another agent is a 403, not a trust-the-caller write. Every other principal (the admin tokens of
// the main agent and the operator, a dashboard session, a tenant user) is untouched: this module only
// ever narrows the fleet_agent role.
//
// The endpoints that call these helpers today: the conversation ledger, agent state and task state,
// the daily log, spans and the sender of an inter-agent message. Endpoints a fleet_agent can reach
// but that do not call them (memories, workspace, kanban, blackboard, recall) are reachable by
// permission only; the token counter watches them and, with TOKEN_IDENTITY_MODE=enforce, the gate in
// web.ts (token-shadow.ts) refuses the requests that name another agent. The one thing the routes
// themselves do under enforce is enforcedSelfScope below.

import { json } from './http-helpers.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { writeAgentAuditLog } from '../db.js'
import type { RouteContext } from './routes/types.js'

/** True when the request carries a fleet_agent token. */
export function isFleetAgentCaller(ctx: Pick<RouteContext, 'role'>): boolean {
  return ctx.role === 'fleet_agent'
}

/**
 * True when the caller may act as `agentId`. A fleet_agent may act only as the agent its token
 * names (a token without one, which the table CHECK rules out, may act as nobody); every other
 * principal may act as any agent, exactly as before.
 */
export function callerMayActAs(ctx: Pick<RouteContext, 'role' | 'tokenAgentId'>, agentId: string): boolean {
  if (ctx.role !== 'fleet_agent') return true
  return ctx.tokenAgentId !== undefined && ctx.tokenAgentId === agentId
}

/**
 * Writes the 403 and returns true when the caller may NOT act as `agentId`. Used as
 * `if (denyForeignAgent(ctx, id)) return true` in a route handler.
 */
export function denyForeignAgent(ctx: RouteContext, agentId: string): boolean {
  if (callerMayActAs(ctx, agentId)) return false
  json(ctx.res, { error: 'forbidden', hint: 'A fleet agent token may only act as its own agent' }, 403)
  return true
}

/**
 * The agent id a request acts as. A fleet_agent that names no agent acts as itself (never as the
 * default the route would otherwise fall back to, which is the main agent); anyone else keeps the
 * route's own fallback.
 */
export function actingAgentId(ctx: Pick<RouteContext, 'role' | 'tokenAgentId'>, claimed: string | null | undefined, fallback: string): string {
  const named = claimed?.trim()
  if (named) return named
  return ctx.role === 'fleet_agent' && ctx.tokenAgentId ? ctx.tokenAgentId : fallback
}

/**
 * The agent a fleet_agent's request is scoped to when it names none, under TOKEN_IDENTITY_MODE=enforce:
 * its own. A listing, search or graph without an agent filter reads across every agent of the tenant
 * for any other principal; the fleet_agent reads its own rows (and the shared tier, which the agent-scoped
 * queries add) instead. null = no scoping: shadow mode (the default, nothing changes), or a principal that
 * is not a fleet_agent.
 */
export function enforcedSelfScope(ctx: Pick<RouteContext, 'role' | 'tokenAgentId' | 'identityEnforced'>): string | null {
  if (!ctx.identityEnforced) return null
  return ctx.role === 'fleet_agent' && ctx.tokenAgentId ? ctx.tokenAgentId : null
}

/**
 * The agent an agent-bound admin token (role admin, kind token, a token that names an agent) speaks
 * for, or null for any other caller. The approvals route stores such a request under this exact id,
 * not under the spelling the body used: the self-approval guard of the resolve route is an exact
 * comparison, so a request stored as `MAIN-X` would not stop the token `main-x` from resolving it.
 */
export function agentBoundAdminId(ctx: Pick<RouteContext, 'role' | 'auth' | 'tokenAgentId'>): string | null {
  return ctx.role === 'admin' && ctx.auth?.kind === 'token' && ctx.tokenAgentId ? ctx.tokenAgentId : null
}

/** How many characters of a refused, caller-supplied agent id the audit row keeps. */
const DECLARED_ID_AUDIT_MAX = 128

/**
 * An agent-bound admin token (the main agent's `main-agent:<id>`: role admin, a token that names an
 * agent) opens an approval request only as the agent it names. The admin role keeps every other
 * reach; this is the one place it is held to its own identity, because an approval carries who is
 * asking and the self-approval guard of the resolve route compares that to the resolver. A request that
 * names another agent is a 403 (`agent_id_mismatch`), the attempt is audited, and nothing is stored. The
 * comparison is on the normalised identifier (sanitizeAgentIdent, case-folded; the route then stores the
 * token's own id, see agentBoundAdminId), and unlike the sender of an inter-agent message the platform senders (`scheduler`, `system`) get no
 * exception: an approval is never theirs.
 * The operator's token (it names no agent), a dashboard session and a federation peer are untouched.
 * Writes the 403 and returns true when the request must stop.
 */
export async function denyAgentBoundAdminForeign(
  ctx: Pick<RouteContext, 'role' | 'auth' | 'tokenAgentId' | 'res'>,
  agentId: string,
): Promise<boolean> {
  const ownId = agentBoundAdminId(ctx)
  if (!ownId) return false
  if (sanitizeAgentIdent(agentId).toLowerCase() === sanitizeAgentIdent(ownId).toLowerCase()) return false
  // The declared id is whatever the caller sent, so the audit row keeps its first 128 characters and its length.
  const declared = agentId.trim()
  try {
    await writeAgentAuditLog({
      agent_id: ownId, entity: 'approval', action: 'create_refused',
      detail: {
        declared_agent_id: declared.slice(0, DECLARED_ID_AUDIT_MAX), declared_agent_id_len: declared.length,
        principal: (ctx.auth as { tokenName?: string }).tokenName ?? null, principalSource: 'token',
      },
    })
  } catch { /* an audit failure must not change the refusal: the request still stops below */ }
  json(ctx.res, { error: 'forbidden', code: 'agent_id_mismatch', hint: 'An agent-bound admin token may only open an approval request as its own agent' }, 403)
  return true
}

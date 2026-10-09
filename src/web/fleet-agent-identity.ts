// Who a fleet_agent token lets its holder act as. A fleet agent's token names the agent
// (api_tokens.agent_id, resolved into ctx.tokenAgentId by the auth gate), so an endpoint that takes
// an agent id in its path, query or body can hold the caller to its own: a request that names
// another agent is a 403, not a trust-the-caller write. Every other principal (the admin tokens of
// the main agent and the operator, a dashboard session, a tenant user) is untouched: this module only
// ever narrows the fleet_agent role.
//
// The endpoints that call these helpers today: the conversation ledger, agent state and task state,
// the daily log, spans and the sender of an inter-agent message. Endpoints a fleet_agent can reach
// but that do not call them yet (memories, workspace, kanban, blackboard, hook-audit, skill-usage,
// tool-log) are reachable by permission only; their per-agent scoping is the follow-up that the
// shadow counter of the next phase measures.

import { json } from './http-helpers.js'
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

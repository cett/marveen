// Sender routing rule: WHO may address WHICH agent. Pure decision, no I/O.
//
// Owner decision (platform weekly 2026-10-30, section 8): every human user talks only to THEIR OWN main
// agent; default-deny. This module is the rule table. The callers (POST /api/messages, and the router at
// delivery time) work out the sender class from the authenticated principal, build the RoutingContext
// from the tenant tables, and ask isRouteAllowed(). Nothing here reads a database or a file, so every cell
// of the table can be tested with fake context objects (the style of team-trust.ts).
//
// | sender class   | allowed target                                                        |
// |----------------|-----------------------------------------------------------------------|
// | owner          | the owner's main agent                                                |
// | tenant_user    | the main agent of the user's OWN tenant (tenants.main_agent_id)       |
// | partner_sender | the main agent or an enabled agent of the partner's tenant            |
// | fleet_agent    | the existing trusted-peer rules (isTrustedPeer)                       |
// | federated      | the owner's main agent or an agent the manifest advertises (see below)|
// | anything else  | refused                                                               |
//
// Agent ids are compared EXACTLY. The caller passes the ids as the router normalises them; a different
// case or a stray space is a different (unknown) agent and is refused, never "corrected" here.
//
// `federated` (owner decision A, 2026-11-04): a federated peer may reach the owner's main agent and the agents
// the local manifest advertises (catalogAgentNames, ONE source: the caller passes that list, so what the
// manifest promises and what routes cannot drift apart). Never a coordinator (heartbeat and the channel
// coordinators), and never an agent that belongs to a non-default tenant (tenants.main_agent_id /
// tenant_agent_availability): such an agent is refused even if it is advertised by mistake. Federated mail
// is always wrapped as untrusted by the classifier; this module only decides the target.

export type SenderClass = 'owner' | 'tenant_user' | 'partner_sender' | 'fleet_agent' | 'federated'

/** What the decision needs to know, as data or pure lookups. Built by the caller from the tenant tables. */
export interface RoutingContext {
  /** The owner's main agent (the main agent of the default tenant). */
  ownerMainAgentId: string
  /** tenants.main_agent_id of a tenant; null/undefined when the tenant has none or does not exist. */
  tenantMainAgentId(tenantId: string): string | null | undefined
  /** The agents enabled for a tenant (tenant_agent_availability, enabled = 1). Unknown tenant: empty. */
  tenantAgentIds(tenantId: string): ReadonlySet<string> | readonly string[]
  /** The fleet's existing decision for a pair of agents (src/team-trust.ts isTrustedPeer). */
  isTrustedPeer(from: string, to: string): boolean
  /** The local sub-agents the manifest advertises (catalogAgentNames()); the main agent is not in it. */
  advertisedAgentIds(): ReadonlySet<string> | readonly string[]
  /** Never a federated target (MANIFEST_EXCLUDED_AGENTS: heartbeat and the channel coordinators). */
  excludedAgentIds: ReadonlySet<string> | readonly string[]
  /** True when the agent belongs to a tenant other than the default one (main agent or enabled agent of it). */
  isNonDefaultTenantAgent(agentId: string): boolean
}

export interface RouteRequest {
  /** From the authenticated principal, never from a message body. An unknown value is refused. */
  senderClass: string
  senderId: string
  /** The sender's tenant: required for tenant_user and partner_sender. */
  tenantId: string | null | undefined
  toAgent: string
}

export type RouteRefusal =
  | 'unknown_sender_class'
  | 'empty_target'
  | 'target_not_owner_main_agent'
  | 'tenant_unknown'
  | 'tenant_has_no_main_agent'
  | 'target_not_tenant_main_agent'
  | 'target_not_in_tenant'
  | 'not_trusted_peer'
  | 'federated_target_is_coordinator'
  | 'federated_target_in_other_tenant'
  | 'federated_target_not_advertised'

export type RouteDecision = { ok: true } | { ok: false; reason: RouteRefusal }

const ALLOW: RouteDecision = { ok: true }
const refuse = (reason: RouteRefusal): RouteDecision => ({ ok: false, reason })

function has(ids: ReadonlySet<string> | readonly string[], id: string): boolean {
  return Array.isArray(ids) ? ids.includes(id) : (ids as ReadonlySet<string>).has(id)
}

function routeOwner(req: RouteRequest, ctx: RoutingContext): RouteDecision {
  return req.toAgent === ctx.ownerMainAgentId ? ALLOW : refuse('target_not_owner_main_agent')
}

function routeTenantUser(req: RouteRequest, ctx: RoutingContext): RouteDecision {
  if (!req.tenantId) return refuse('tenant_unknown')
  const main = ctx.tenantMainAgentId(req.tenantId)
  if (!main) return refuse('tenant_has_no_main_agent')
  return req.toAgent === main ? ALLOW : refuse('target_not_tenant_main_agent')
}

function routePartner(req: RouteRequest, ctx: RoutingContext): RouteDecision {
  if (!req.tenantId) return refuse('tenant_unknown')
  const main = ctx.tenantMainAgentId(req.tenantId)
  if (main && req.toAgent === main) return ALLOW
  return has(ctx.tenantAgentIds(req.tenantId), req.toAgent) ? ALLOW : refuse('target_not_in_tenant')
}

function routeFleetAgent(req: RouteRequest, ctx: RoutingContext): RouteDecision {
  return ctx.isTrustedPeer(req.senderId, req.toAgent) ? ALLOW : refuse('not_trusted_peer')
}

function routeFederated(req: RouteRequest, ctx: RoutingContext): RouteDecision {
  // The exclusions come first: they win over "advertised" and over "main agent".
  if (has(ctx.excludedAgentIds, req.toAgent)) return refuse('federated_target_is_coordinator')
  if (ctx.isNonDefaultTenantAgent(req.toAgent)) return refuse('federated_target_in_other_tenant')
  if (req.toAgent === ctx.ownerMainAgentId || has(ctx.advertisedAgentIds(), req.toAgent)) return ALLOW
  return refuse('federated_target_not_advertised')
}

/** Default-deny: only a listed sender class with a matching target is allowed; every other input is refused. */
export function isRouteAllowed(req: RouteRequest, ctx: RoutingContext): RouteDecision {
  if (typeof req.toAgent !== 'string' || req.toAgent === '') return refuse('empty_target')
  switch (req.senderClass as SenderClass) {
    case 'owner': return routeOwner(req, ctx)
    case 'tenant_user': return routeTenantUser(req, ctx)
    case 'partner_sender': return routePartner(req, ctx)
    case 'fleet_agent': return routeFleetAgent(req, ctx)
    case 'federated': return routeFederated(req, ctx)
    default: return refuse('unknown_sender_class')
  }
}

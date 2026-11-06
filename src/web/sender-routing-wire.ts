// Wiring of the sender routing rule (sender-routing.ts, a pure decision) into the two places a message can
// be stopped: POST /api/messages (when it is written) and the message router / the main-agent inbox pull
// (when it is delivered). This file owns what the pure module deliberately does not: the mode switch, the
// RoutingContext built from the tenant tables, and the sender class worked out from the principal.
//
// MODE. SENDER_ROUTING_MODE is a registry setting (config-registry.ts): `audit` (the code default) or
// `enforce`. It is read on every call through getEffectiveSettingValue (system_config DB, then .env, then the
// default), so a switch takes effect on the next request / router tick without a restart. Anything that is
// not exactly `enforce` after trim and lower-casing, and any failure to read the setting, is `audit`: a
// broken switch must never start refusing messages.
//
// LANES. A message is either a human/agent sender the table judges (lane `routed`) or a platform sender
// (lane `system`): the channel coordinator (a direct DB insert that never passes the route), the scheduler,
// `system` and the SYSTEM_SENDER_IDS neighbours. The system lane is decided on code constants, never on a
// sender class, and is never sent to isRouteAllowed: the table has no class for it and would refuse it.
// The audit row carries `lane: system` instead.
//
// The class of a sender comes from the authenticated principal, not from the body. The one claim that is
// still the caller's own is the `from` of a request made with a bearer token that cannot be pinned to one
// agent (the shared dashboard token): such a request is judged as `unknown_sender_class` unless `from` is
// the owner or a platform sender, so a forged agent name does not buy a class.

import { MAIN_AGENT_ID, SYSTEM_SENDER_IDS, OWNER_NAME, parseSystemSenderIds } from '../config.js'
import { logger } from '../logger.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { isTrustedPeer } from '../team-trust.js'
import { writeAgentAuditLog } from '../db/audit.js'
import { closeOpenMessage, listEnabledAgentAvailability } from '../db/agents.js'
import { listTenants } from '../db/observability.js'
import { isKnownAgent } from './agent-config.js'
import { readAgentTeam } from './agent-team.js'
import { isChannelCoordinatorSender } from './agent-message-wrap.js'
import { MANIFEST_EXCLUDED_AGENTS, catalogAgentNames } from './federation/local-catalog.js'
import { isRouteAllowed, type RouteDecision, type RoutingContext, type SenderClass } from './sender-routing.js'

export type SenderRoutingMode = 'audit' | 'enforce'

export const SENDER_ROUTING_MODE_KEY = 'SENDER_ROUTING_MODE'

/** The live mode. Per call, never cached in this process; unknown value or unreadable setting is `audit`. */
export function getSenderRoutingMode(): SenderRoutingMode {
  try {
    const raw = String(getEffectiveSettingValue(SENDER_ROUTING_MODE_KEY)).trim().toLowerCase()
    return raw === 'enforce' ? 'enforce' : 'audit'
  } catch {
    return 'audit'
  }
}

// Platform senders: the ids the server or a neighbouring system posts as. The two sets are the ones
// POST /api/messages already treats as legitimate non-agent senders (single source for both files).
export const BUILTIN_SYSTEM_FROM: ReadonlySet<string> = new Set(['scheduler', 'system'])
export const SYSTEM_SENDERS: ReadonlySet<string> = parseSystemSenderIds(SYSTEM_SENDER_IDS, sanitizeAgentIdent)

/** A platform sender, judged on the SANITIZED id and on code constants only. */
export function isPlatformSender(safeFrom: string): boolean {
  return BUILTIN_SYSTEM_FROM.has(safeFrom) || SYSTEM_SENDERS.has(safeFrom) || isChannelCoordinatorSender(safeFrom)
}

/**
 * The RoutingContext, read from the two small tenant tables ONCE (one request, or one router tick); every
 * lookup the decision makes afterwards is synchronous and touches no database.
 */
export async function buildRoutingContext(): Promise<RoutingContext> {
  const tenants = await listTenants()
  const availability = await listEnabledAgentAvailability()
  const mainByTenant = new Map<string, string>()
  for (const t of tenants) if (t.main_agent_id) mainByTenant.set(t.id, t.main_agent_id)
  const agentsByTenant = new Map<string, Set<string>>()
  const enabledInDefault = new Set<string>()
  for (const row of availability) {
    let set = agentsByTenant.get(row.tenant_id)
    if (!set) { set = new Set(); agentsByTenant.set(row.tenant_id, set) }
    set.add(row.agent_id)
    if (row.tenant_id === 'default') enabledInDefault.add(row.agent_id)
  }
  // An agent belongs to another tenant when it is that tenant's main agent, or when it is enabled for a
  // non-default tenant and not also enabled for the default one (a shared agent stays reachable).
  const otherTenantAgents = new Set<string>()
  for (const [tenantId, main] of mainByTenant) if (tenantId !== 'default') otherTenantAgents.add(main)
  for (const [tenantId, ids] of agentsByTenant) {
    if (tenantId === 'default') continue
    for (const id of ids) if (!enabledInDefault.has(id)) otherTenantAgents.add(id)
  }
  const advertised = new Set(catalogAgentNames())
  return {
    ownerMainAgentId: mainByTenant.get('default') || MAIN_AGENT_ID,
    tenantMainAgentId: (tenantId) => mainByTenant.get(tenantId),
    tenantAgentIds: (tenantId) => agentsByTenant.get(tenantId) ?? new Set<string>(),
    isTrustedPeer: (from, to) => isTrustedPeer(from, to, { mainAgentId: MAIN_AGENT_ID, isKnownAgent, readAgentTeam }),
    advertisedAgentIds: () => advertised,
    excludedAgentIds: MANIFEST_EXCLUDED_AGENTS,
    isNonDefaultTenantAgent: (agentId) => otherTenantAgents.has(agentId),
  }
}

export type SenderLane = 'routed' | 'system'

export interface SenderIdentity {
  lane: SenderLane
  /** A SenderClass, or the string `unknown_sender_class` when no principal rule matches (refused by the table). */
  senderClass: SenderClass | 'unknown_sender_class' | 'system'
  senderId: string
  tenantId: string | null
}

/** What POST /api/messages knows about the caller by the time it has accepted the sender. */
export interface RouteSenderFacts {
  role: string | undefined
  authKind: string | undefined
  /** ctx.tenantId: null/undefined/'default' for the fleet's own tenant. */
  tenantId: string | null | undefined
  /** The agent a fleet_agent token names (ctx.tokenAgentId). */
  tokenAgentId: string | null | undefined
  /** The agent an agent-bound admin token names (agentBoundAdminId), null for every other principal. */
  boundAgent: string | null
  /** `from` after the route has pinned it to a token's agent, sanitized. */
  safeFrom: string
  /** True when the partner-tenant path accepted this `from` for ctx.tenantId. */
  isPartnerTenant: boolean
}

/**
 * The class of the sender of a POST /api/messages request, from the principal. One place, pure, tested.
 *  - a platform sender id (never a coordinator: the route refuses that id before this point)  -> lane system
 *  - a partner tenant's token whose `from` the partner allowlist accepted                      -> partner_sender
 *  - a fleet_agent token                                                                       -> fleet_agent (the token's agent)
 *  - an agent-bound admin token posting as its own agent                                       -> fleet_agent (that agent)
 *  - an admin principal posting as the owner                                                   -> owner
 *  - everything else (including a tenant-bound non-partner caller, which has no path today)    -> unknown_sender_class
 */
export function classifyRouteSender(f: RouteSenderFacts): SenderIdentity {
  const partnerTenant = f.tenantId != null && f.tenantId !== 'default'
  if (f.isPartnerTenant && partnerTenant) {
    return { lane: 'routed', senderClass: 'partner_sender', senderId: f.safeFrom, tenantId: f.tenantId ?? null }
  }
  if (f.role === 'fleet_agent') {
    const own = sanitizeAgentIdent(f.tokenAgentId ?? '')
    return own
      ? { lane: 'routed', senderClass: 'fleet_agent', senderId: own, tenantId: null }
      : { lane: 'routed', senderClass: 'unknown_sender_class', senderId: f.safeFrom, tenantId: null }
  }
  if (f.role === 'admin') {
    if (isPlatformSender(f.safeFrom)) return { lane: 'system', senderClass: 'system', senderId: f.safeFrom, tenantId: null }
    if (f.safeFrom === sanitizeAgentIdent(OWNER_NAME)) return { lane: 'routed', senderClass: 'owner', senderId: f.safeFrom, tenantId: null }
    if (f.boundAgent && f.safeFrom === sanitizeAgentIdent(f.boundAgent)) {
      return { lane: 'routed', senderClass: 'fleet_agent', senderId: f.safeFrom, tenantId: null }
    }
  }
  return { lane: 'routed', senderClass: 'unknown_sender_class', senderId: f.safeFrom, tenantId: partnerTenant ? f.tenantId ?? null : null }
}

/** The facts of a stored row: what delivery time knows (from_agent, tenant_id), no principal. */
export interface DeliveryRowFacts { from_agent: string; tenant_id?: string | null }

/**
 * The class of the sender of a STORED message, for the router and the inbox pull. The same table, the same
 * lanes, worked out from the row. A slash-qualified sender is federated; the channel coordinator and the
 * platform senders are the system lane (by constant); the owner name is the owner; a registered agent is a
 * fleet_agent; a non-default tenant row from a non-agent is that tenant's partner sender. Nothing else.
 */
export function classifyDeliverySender(row: DeliveryRowFacts): SenderIdentity {
  const rawFrom = String(row.from_agent ?? '')
  if (rawFrom.includes('/')) return { lane: 'routed', senderClass: 'federated', senderId: rawFrom, tenantId: null }
  const safeFrom = sanitizeAgentIdent(rawFrom)
  if (!safeFrom) return { lane: 'routed', senderClass: 'unknown_sender_class', senderId: '', tenantId: null }
  if (isPlatformSender(safeFrom)) return { lane: 'system', senderClass: 'system', senderId: safeFrom, tenantId: null }
  const rowTenant = row.tenant_id && row.tenant_id !== 'default' ? row.tenant_id : null
  if (safeFrom === sanitizeAgentIdent(OWNER_NAME)) return { lane: 'routed', senderClass: 'owner', senderId: safeFrom, tenantId: null }
  if (isKnownAgent(safeFrom)) return { lane: 'routed', senderClass: 'fleet_agent', senderId: safeFrom, tenantId: rowTenant }
  if (rowTenant) return { lane: 'routed', senderClass: 'partner_sender', senderId: safeFrom, tenantId: rowTenant }
  return { lane: 'routed', senderClass: 'unknown_sender_class', senderId: safeFrom, tenantId: null }
}

export interface RouteVerdict {
  mode: SenderRoutingMode
  lane: SenderLane
  senderClass: string
  senderId: string
  to: string
  decision: RouteDecision
  /** True only when the mode is enforce and the decision refuses: the caller must stop. */
  deny: boolean
}

/** Judge one message. The system lane never reaches the table and is always allowed. */
export function judgeRoute(identity: SenderIdentity, toAgent: string, ctx: RoutingContext, mode: SenderRoutingMode): RouteVerdict {
  const to = sanitizeAgentIdent(toAgent)
  if (identity.lane === 'system') {
    return { mode, lane: 'system', senderClass: identity.senderClass, senderId: identity.senderId, to, decision: { ok: true }, deny: false }
  }
  const decision = isRouteAllowed({ senderClass: identity.senderClass, senderId: identity.senderId, tenantId: identity.tenantId, toAgent: to }, ctx)
  return { mode, lane: 'routed', senderClass: identity.senderClass, senderId: identity.senderId, to, decision, deny: mode === 'enforce' && !decision.ok }
}

/**
 * The audit row of a verdict (action `sender_route_checked`). `stage` says where it was judged. The reason
 * lives only here, never in a response: a refused caller must not learn who is allowed. A failing audit
 * write is logged and swallowed: it must neither refuse nor accept a message.
 */
export async function auditRouteVerdict(
  v: RouteVerdict,
  stage: 'route' | 'delivery',
  extra: { entityId?: number; principal?: string | null; principalSource?: string } = {},
): Promise<void> {
  try {
    await writeAgentAuditLog({
      agent_id: v.senderId || 'unknown',
      entity: 'message',
      action: 'sender_route_checked',
      ...(extra.entityId !== undefined ? { entity_id: extra.entityId } : {}),
      detail: {
        stage,
        mode: v.mode,
        lane: v.lane,
        senderClass: v.senderClass,
        from: v.senderId,
        to: v.to,
        ok: v.decision.ok,
        reason: v.decision.ok ? null : v.decision.reason,
        denied: v.deny,
        ...(extra.principal !== undefined ? { principal: extra.principal } : {}),
        ...(extra.principalSource !== undefined ? { principalSource: extra.principalSource } : {}),
      },
    })
  } catch (err) {
    logger.warn({ err, stage }, 'sender-routing: audit write failed')
  }
}

// The delivery-time audit is written once per message id, not once per router tick: a message that stays
// pending (its session is down) is judged again on every tick, and a row each time would flood the log.
const auditedAtDelivery = new Set<number>()
const AUDITED_AT_DELIVERY_CAP = 5000

/**
 * The delivery side of the rule: the router tick, the reconnect-backlog batch and the main-agent inbox pull
 * all pass the messages they are about to deliver through here. The verdict is worked out from the stored row
 * (from_agent, to_agent, tenant_id), so it also covers what never passed POST /api/messages: the channel
 * coordinator's direct inserts, platform senders, federated rows.
 *
 * `audit` mode: every message is returned, the verdict is only logged. `enforce` mode: a refused message is
 * closed with the existing refusal mechanism (closeOpenMessage, compare-and-set: status failed + refused_reason
 * `sender_route_<reason>`) and left out of the returned list, so nothing is injected or shown for it.
 * The tenant tables are read once per call, however many messages there are.
 *
 * Audit rows at this stage are written for what the route cannot have audited or what is refused or would be
 * refused: a platform sender, a federated sender, and any non-allowed verdict. An allowed message from a
 * routed sender already has its row from the route.
 *
 * If the context cannot be read: audit mode returns the batch untouched; enforce mode returns nothing, so the
 * messages stay pending and are judged again on the next tick.
 */
export async function gateDeliveryBatch<T extends { id: number; from_agent: string; to_agent: string; tenant_id?: string | null }>(
  batch: readonly T[],
): Promise<T[]> {
  if (batch.length === 0) return []
  const mode = getSenderRoutingMode()
  let ctx: RoutingContext
  try {
    ctx = await buildRoutingContext()
  } catch (err) {
    logger.warn({ err, mode }, 'sender-routing: could not build the routing context for delivery')
    return mode === 'enforce' ? [] : [...batch]
  }
  const kept: T[] = []
  for (const m of batch) {
    const identity = classifyDeliverySender(m)
    const verdict = judgeRoute(identity, m.to_agent, ctx, mode)
    const auditWorthy = !verdict.decision.ok || identity.lane === 'system' || identity.senderClass === 'federated'
    if (auditWorthy && !auditedAtDelivery.has(m.id)) {
      if (auditedAtDelivery.size >= AUDITED_AT_DELIVERY_CAP) auditedAtDelivery.clear()
      auditedAtDelivery.add(m.id)
      await auditRouteVerdict(verdict, 'delivery', { entityId: m.id })
    }
    if (verdict.deny) {
      const reason = verdict.decision.ok ? 'denied' : verdict.decision.reason
      try {
        // Compare-and-set: a row that was closed in the meantime (done / failed, e.g. by PUT /api/messages/:id)
        // keeps its outcome; the refusal only lands on a row that is still open (pending, or delivered by the claim).
        if (!await closeOpenMessage(m.id, 'refused', `sender_route_${reason}`)) {
          logger.warn({ id: m.id }, 'sender-routing: the refusal did not apply, the message was already closed')
        }
      } catch (err) {
        logger.warn({ err, id: m.id }, 'sender-routing: could not close a refused message')
      }
      continue
    }
    kept.push(m)
  }
  return kept
}

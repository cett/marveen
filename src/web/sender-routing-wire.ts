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
import { closeOpenMessage, createAgentMessage, listEnabledAgentAvailability } from '../db/agents.js'
import { getAgentMessage } from '../db/tasks.js'
import { COMPLETION_REPORT_PREFIX, listTenants } from '../db/observability.js'
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

/**
 * Judge one message. The system lane never reaches the table and is always allowed.
 *
 * A fleet agent writing to ITSELF (the sanitized sender id equals the sanitized recipient) is allowed before the
 * table is asked: it grants no new reach, the agent only talks to its own session. The exception is for the
 * fleet_agent class alone; an owner, a partner sender, a federated sender, a tenant user or an unclassified sender
 * addressing the same name gets no such pass and meets the table as before. The table (sender-routing.ts) and the
 * peer relation (team-trust.ts, where from === to is false on purpose) are untouched: this is the one place the
 * self-message rule lives, and both the route and the delivery gate come through here.
 */
export function judgeRoute(identity: SenderIdentity, toAgent: string, ctx: RoutingContext, mode: SenderRoutingMode): RouteVerdict {
  const to = sanitizeAgentIdent(toAgent)
  if (identity.lane === 'system') {
    return { mode, lane: 'system', senderClass: identity.senderClass, senderId: identity.senderId, to, decision: { ok: true }, deny: false }
  }
  if (identity.lane === 'routed' && identity.senderClass === 'fleet_agent' && to !== '' && sanitizeAgentIdent(identity.senderId) === to) {
    return { mode, lane: 'routed', senderClass: identity.senderClass, senderId: identity.senderId, to, decision: { ok: true }, deny: false }
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

// The delivery-time audit is written once per message id AND mode, not once per router tick: a message that stays
// pending (its session is down) is judged again on every tick, and a row each time would flood the log. The mode is
// part of the key so that a switch audit -> enforce (no restart) writes the enforcing verdict (denied: true) too,
// instead of leaving the audit-mode row as the only trace of that message.
const auditedAtDelivery = new Set<string>()
const AUDITED_AT_DELIVERY_CAP = 5000

type DeliveryRow = { id: number; from_agent: string; to_agent: string; tenant_id?: string | null }

/** A delivery gate that could be opened: `judge` applies the rule to a batch. */
export interface OpenDeliveryGate {
  open: true
  judge<T extends DeliveryRow>(batch: readonly T[]): Promise<T[]>
}
/** The gate could not be opened: enforce mode and the routing context cannot be read, so nothing can be judged. */
export interface ClosedDeliveryGate { open: false }

/**
 * Open the delivery gate: read the routing context (the tenant tables, once) and return the judge for batches.
 *
 * This is separate from judging so that a PULL path (the main-agent inbox drain), which changes the state of a row
 * when it claims it, can learn BEFORE the claim whether a verdict is possible at all. `open: false` means "enforce
 * mode and the context cannot be read": the caller must not claim anything, the rows stay pending and are asked
 * for again on the next call. In audit mode a context that cannot be read opens a pass-through gate (every message
 * is returned, as before): audit never withholds a message.
 */
export async function openDeliveryGate(): Promise<OpenDeliveryGate | ClosedDeliveryGate> {
  const mode = getSenderRoutingMode()
  let ctx: RoutingContext
  try {
    ctx = await buildRoutingContext()
  } catch (err) {
    logger.warn({ err, mode }, 'sender-routing: could not build the routing context for delivery')
    if (mode === 'enforce') return { open: false }
    return { open: true, judge: (batch) => Promise.resolve([...batch]) }
  }
  return { open: true, judge: (batch) => judgeDeliveryBatch(batch, mode, ctx) }
}

/**
 * The delivery side of the rule: the router tick and the reconnect-backlog batch pass the messages they are about
 * to deliver through here (the main-agent inbox pull opens the gate before its claim: openDeliveryGate, and then
 * judges what it claimed). The verdict is worked out from the stored row
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
export async function gateDeliveryBatch<T extends DeliveryRow>(batch: readonly T[]): Promise<T[]> {
  if (batch.length === 0) return []
  const gate = await openDeliveryGate()
  return gate.open ? gate.judge(batch) : []
}

// ---- The notice to the sender of a message the delivery gate refused -----------------------------------------------
//
// On the route the sender gets a 403 at once. A DELIVERY refusal (router tick, backlog, inbox pull: a message that never
// passed the route, or one judged after the rule changed) used to be silent: the row went to failed with a
// refused_reason and the sender never heard. After a refusal that landed, the sender gets ONE short notice.
//  - It is posted by `system`, not by the recipient: the notice the PUT handler sends on a close goes recipient -> sender,
//    which is the refused pair reversed, so under enforce it would be refused itself and the sender would hear nothing.
//    `system` is the platform lane, which the table never sees.
//  - Only a local, known agent is told (the logic of shouldNotifyDelegator): not a self-message, not the owner, a
//    partner, a federated or a platform sender, not the channel coordinator, and not a message that is itself a
//    completion report (`[Eredmény]`), so a notice can never produce a notice.
//  - The text is fixed and general: the message id and "delivery refused (sender rule)". The reason (who is allowed) is
//    NOT in it, the same as the 403 of the route.
//  - Noise guard: at most REFUSAL_NOTICES_PER_MINUTE notices per sender in a minute, then ONE summary notice, then none
//    until the minute is over. The counter lives in this process (a restart resets it, which can only add a notice).
//  - The notice stays in the tenant of the refused message.
// A failure to write the notice is logged and swallowed: it must neither undo the refusal nor stop the batch.

const REFUSAL_NOTICE_FROM = 'system'
export const REFUSAL_NOTICES_PER_MINUTE = 5
const REFUSAL_NOTICE_WINDOW_MS = 60_000
const REFUSAL_NOTICE_TEXT = 'kézbesítés tiltva (küldő-szabály)'
const REFUSAL_NOTICE_SUMMARY_TEXT = 'további kézbesítések tiltva (küldő-szabály), ebben a percben több értesítés nem megy'
const REFUSAL_NOTICE_TRACKED_CAP = 1000
const refusalNoticeWindows = new Map<string, { start: number; count: number }>()

/** Should the sender of a refused message be told? Pure apart from the agent lookup. */
export function shouldNotifyRefusedSender(identity: SenderIdentity, toAgent: string, content: string): boolean {
  if (identity.lane !== 'routed' || identity.senderClass !== 'fleet_agent') return false
  if (sanitizeAgentIdent(identity.senderId) === sanitizeAgentIdent(toAgent)) return false
  if (content.startsWith(COMPLETION_REPORT_PREFIX)) return false
  return isKnownAgent(identity.senderId)
}

function takeRefusalNoticeSlot(sender: string, nowMs: number): 'notice' | 'summary' | 'none' {
  if (refusalNoticeWindows.size >= REFUSAL_NOTICE_TRACKED_CAP) {
    for (const [k, w] of refusalNoticeWindows) if (nowMs - w.start >= REFUSAL_NOTICE_WINDOW_MS) refusalNoticeWindows.delete(k)
    if (refusalNoticeWindows.size >= REFUSAL_NOTICE_TRACKED_CAP) refusalNoticeWindows.clear()
  }
  let w = refusalNoticeWindows.get(sender)
  if (!w || nowMs - w.start >= REFUSAL_NOTICE_WINDOW_MS) {
    w = { start: nowMs, count: 0 }
    refusalNoticeWindows.set(sender, w)
  }
  w.count += 1
  if (w.count <= REFUSAL_NOTICES_PER_MINUTE) return 'notice'
  return w.count === REFUSAL_NOTICES_PER_MINUTE + 1 ? 'summary' : 'none'
}

/** Forget the noise-guard counters (tests). */
export function resetRefusalNoticeWindows(): void { refusalNoticeWindows.clear() }

async function notifyRefusedSender(m: DeliveryRow, identity: SenderIdentity): Promise<void> {
  try {
    const row = await getAgentMessage(m.id)
    if (!row || !shouldNotifyRefusedSender(identity, m.to_agent, row.content)) return
    const slot = takeRefusalNoticeSlot(sanitizeAgentIdent(identity.senderId), Date.now())
    if (slot === 'none') return
    const body = slot === 'notice'
      ? `${COMPLETION_REPORT_PREFIX} msg_id:${m.id} status:failed\n\n${REFUSAL_NOTICE_TEXT}`
      : `${COMPLETION_REPORT_PREFIX} status:failed\n\n${REFUSAL_NOTICE_SUMMARY_TEXT}`
    // pinTenant: the notice belongs to the refused message, so it keeps that message's tenant.
    await createAgentMessage(REFUSAL_NOTICE_FROM, identity.senderId, body, null, null, row.tenant_id ?? 'default', null, true)
  } catch (err) {
    logger.warn({ err, id: m.id }, 'sender-routing: could not post the refusal notice')
  }
}

async function judgeDeliveryBatch<T extends DeliveryRow>(batch: readonly T[], mode: SenderRoutingMode, ctx: RoutingContext): Promise<T[]> {
  const kept: T[] = []
  for (const m of batch) {
    const identity = classifyDeliverySender(m)
    const verdict = judgeRoute(identity, m.to_agent, ctx, mode)
    const auditWorthy = !verdict.decision.ok || identity.lane === 'system' || identity.senderClass === 'federated'
    const auditKey = `${m.id}:${mode}`
    if (auditWorthy && !auditedAtDelivery.has(auditKey)) {
      if (auditedAtDelivery.size >= AUDITED_AT_DELIVERY_CAP) auditedAtDelivery.clear()
      auditedAtDelivery.add(auditKey)
      await auditRouteVerdict(verdict, 'delivery', { entityId: m.id })
    }
    if (verdict.deny) {
      const reason = verdict.decision.ok ? 'denied' : verdict.decision.reason
      try {
        // Compare-and-set: a row that was closed in the meantime (done / failed, e.g. by PUT /api/messages/:id)
        // keeps its outcome; the refusal only lands on a row that is still open (pending, or delivered by the claim).
        if (!await closeOpenMessage(m.id, 'refused', `sender_route_${reason}`)) {
          logger.warn({ id: m.id }, 'sender-routing: the refusal did not apply, the message was already closed')
        } else {
          // Only a refusal that LANDED is told to the sender: a row closed in the meantime, or judged again on a
          // later tick, has already had its outcome and gets no second notice.
          await notifyRefusedSender(m, identity)
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

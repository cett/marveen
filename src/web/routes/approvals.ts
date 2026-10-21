import { randomUUID } from 'node:crypto'
import { PROJECT_ROOT, MAIN_AGENT_ID, APPROVAL_HUMAN_ONLY_ENFORCE, APPROVAL_CONSUME_WINDOW_S } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, countApprovals,
  getApprovalStatusCounts, getOldestPendingApproval, expireTimedOutApprovals,
  createAgentMessage, writeAgentAuditLog, getAutonomyCategory, recordApprovalEvent,
  createApprovalOnce, countApprovalsRequestedSince, isContentHash,
  type Approval, type ApprovalResolvedVia,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { denyForeignAgent } from '../fleet-agent-identity.js'
import { checkCategory, humanSessionOf, isHumanOnly, isEmailSendCategory, EMAIL_SEND_CATEGORY } from '../approval-human-only.js'
import { parseEmailEnvelope, describeEmail, MAX_PAYLOAD_BYTES } from '../email-envelope.js'
import {
  notifyOwnerOfHumanOnlyRequest, approvalRequestLine, humanOnlyRequestLine, ownerUnreachedLine, approvalResolvedLine,
} from '../approval-owner-notice.js'
import { parsePagination } from '../utils/pagination.js'
import type { RouteContext } from './types.js'
import { resolveApprovalTimeoutSeconds } from '../approval-timeout.js'
import { tryHandleApprovalUse } from './approvals-consume.js'

// Every approval gets a deadline: the category's timeout_minutes, or the 24 h ceiling for an unknown
// category / NULL value / unreadable DB. The caller's timeout_seconds can only shorten it.
async function getTimeoutAt(category: string, requestedSeconds: unknown): Promise<number> {
  let categoryMinutes: number | null = null
  try {
    categoryMinutes = (await getAutonomyCategory(category))?.timeout_minutes ?? null
  } catch (err) {
    logger.warn({ err, category }, 'Autonomy category lookup failed, using the default approval timeout')
  }
  return Math.floor(Date.now() / 1000) + resolveApprovalTimeoutSeconds(categoryMinutes, requestedSeconds)
}

// An agent may have this many email requests open at once, and the owner is told of this many new ones
// per agent and hour; the rest wait on the Approvals page. A runaway loop of requests fills a table
// the owner can read, not their phone.
const MAX_PENDING_EMAIL_REQUESTS = 10
const MAX_EMAIL_OWNER_NOTICES_PER_HOUR = 5
const HOUR_S = 3600

/** True when this new email request is within the agent's hourly allowance of owner notices. */
function withinOwnerNoticeAllowance(approval: Approval): boolean {
  try {
    const earlier = countApprovalsRequestedSince({
      agent_id: approval.agent_id, category: approval.category, tenant_id: approval.tenant_id,
      since: Math.floor(Date.now() / 1000) - HOUR_S, exceptId: approval.id,
    })
    return earlier < MAX_EMAIL_OWNER_NOTICES_PER_HOUR
  } catch (err) {
    // A count that cannot be read must not silence the owner: tell them.
    logger.warn({ err, approvalId: approval.id }, 'Could not count recent email requests, notifying anyway')
    return true
  }
}

/** A request is human-only when its row says so (a snapshot, so a later widening of the set also reaches it) or its category is. */
async function isHumanOnlyApproval(approval: Approval | undefined): Promise<boolean> {
  return approval !== undefined && (approval.human_only === 1 || await isHumanOnly(approval.category))
}

/**
 * Journal a decision attempted on a human-only approval without a human session. In enforce mode it is
 * refused; otherwise it went through and the row says it only would have been. Never throws: a journal
 * fault must not turn a refusal into a success.
 */
function journalNonHumanDecision(approval: Approval, actor: string | undefined): void {
  try {
    recordApprovalEvent({
      approval_id: approval.id,
      tenant_id: approval.tenant_id,
      event: 'bearer_denied',
      reason: APPROVAL_HUMAN_ONLY_ENFORCE ? 'human_only_category' : 'human_only_category_advisory',
      actor: actor ?? null,
    })
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'Could not journal a decision attempted without a human session')
  }
}

const HUMAN_ONLY_REFUSAL = {
  error: 'forbidden',
  code: 'human_only_category',
  hint: 'This approval is human-only: it is decided by a person logged in to the dashboard, not by a token',
} as const

/**
 * Tell the fleet about a new request. With enforcement on, a human-only one is handled differently: the
 * server messages the owner itself (a dashboard link, no way to decide in the chat), the main agent is
 * told not to relay or decide it, and a failed owner message is reported back as OWNER_UNREACHED. The
 * requester hears the outcome from notifyRequester. Never throws: the approval exists either way.
 */
async function notifyAboutNewRequest(approval: Approval): Promise<void> {
  if (approval.category === EMAIL_SEND_CATEGORY && !withinOwnerNoticeAllowance(approval)) {
    logger.warn({ approvalId: approval.id, agent: approval.agent_id }, 'Email approval request not announced: the hourly notice allowance is used up')
    try {
      recordApprovalEvent({ approval_id: approval.id, tenant_id: approval.tenant_id, event: 'notify_suppressed', reason: 'rate_limited', actor: 'system' })
    } catch (err) {
      logger.warn({ err, approvalId: approval.id }, 'Could not journal a suppressed owner notice')
    }
    return
  }
  if (!APPROVAL_HUMAN_ONLY_ENFORCE || !await isHumanOnlyApproval(approval)) {
    notifyMainAgent(approval)
    return
  }
  // The main agent asking for itself does not need to be told about its own request.
  if (approval.agent_id !== MAIN_AGENT_ID) sendSystemMessage(MAIN_AGENT_ID, humanOnlyRequestLine(approval), approval)
  void notifyOwnerOfHumanOnlyRequest(approval).then((delivered) => {
    if (delivered) return
    logger.warn({ approvalId: approval.id }, 'The owner could not be told about a human-only approval request')
    try {
      recordApprovalEvent({ approval_id: approval.id, tenant_id: approval.tenant_id, event: 'owner_unreached', actor: 'system' })
    } catch (err) {
      logger.warn({ err, approvalId: approval.id }, 'Could not journal an unreached owner')
    }
    sendSystemMessage(MAIN_AGENT_ID, ownerUnreachedLine(approval), approval)
  })
}

/** Tell the requester how its human-only request was decided (enforcement on). Best effort. */
async function notifyRequester(approval: Approval | undefined): Promise<void> {
  if (!approval || !await isHumanOnlyApproval(approval) || !APPROVAL_HUMAN_ONLY_ENFORCE) return
  sendSystemMessage(approval.agent_id, approvalResolvedLine(approval), approval)
}

function sendSystemMessage(to: string, content: string, approval: Approval): void {
  try {
    createAgentMessage('system', to, content)
  } catch (err) {
    // Non-fatal: the approval stands regardless; these notices are best-effort
    logger.warn({ err, approvalId: approval.id, to }, 'Failed to send an approval notice')
  }
}

function notifyMainAgent(approval: Approval): void {
  try {
    createAgentMessage('system', MAIN_AGENT_ID, approvalRequestLine(approval))
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) {
        logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
        writeAgentAuditLog({ agent_id: 'system', entity: 'approval', action: 'timeout_sweep', detail: { expired } })
      }
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Using up an approved request, and its journal (approvals-consume.ts).
  if (await tryHandleApprovalUse(ctx)) return true

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    // Tenant users (session-auth, non-admin) cannot create approval requests;
    // only fleet agents and admins do. This prevents a coarse approvals:write
    // permission from allowing unintended creation via the dashboard.
    if (ctx.auth?.kind === 'session' && ctx.role !== 'admin') {
      json(res, { error: 'forbidden', hint: 'Tenant users cannot create approval requests' }, 403)
      return true
    }

    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; content_hash?: unknown; tenant_id?: unknown; timeout_seconds?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, content_hash, tenant_id, timeout_seconds } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'required', field: 'agent_id', hint: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'required', field: 'category', hint: 'category is required' }, 400)
      return true
    }
    // An email request is described by the server, from the envelope it hashes; the requester's own
    // description is not asked for and not used.
    const emailSend = isEmailSendCategory(category)
    if (!emailSend && (typeof action_description !== 'string' || !action_description.trim())) {
      json(res, { error: 'required', field: 'action_description', hint: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'invalid_value', field: 'action_payload', hint: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }
    if (content_hash !== undefined && !isContentHash(content_hash)) {
      json(res, { error: 'invalid_value', field: 'content_hash', hint: 'content_hash must be 64 lowercase hex characters (a sha256)' }, 400)
      return true
    }
    if (tenant_id !== undefined && typeof tenant_id !== 'string') {
      json(res, { error: 'invalid_value', field: 'tenant_id', hint: 'tenant_id must be a string if provided' }, 400)
      return true
    }

    // A fleet_agent asks for approval as itself, in the tenant it is serving (never one it names).
    if (denyForeignAgent(ctx, agent_id.trim())) return true
    const requestTenant: string | null =
      ctx.role === 'fleet_agent' ? (ctx.tenantId ?? null) : (typeof tenant_id === 'string' ? tenant_id.trim() || null : null)

    // With enforcement on, the category is stored in its canonical form and a spelling that reads as a
    // human-only category without being it is refused (an unguarded twin of the gated name). Without it
    // the name is stored as sent, as before; the human-only snapshot below is taken either way.
    const requester = agent_id.trim()
    let storedCategory = category.trim()
    if (APPROVAL_HUMAN_ONLY_ENFORCE) {
      const checked = await checkCategory(category)
      if (!checked.ok) {
        json(res, { error: 'invalid_value', field: 'category', code: checked.error, hint: checked.hint }, 400)
        return true
      }
      storedCategory = checked.category
    }

    if (!emailSend) {
      const id = randomUUID()
      const approval = createApproval({
        id,
        agent_id: requester,
        category: storedCategory,
        human_only: await isHumanOnly(storedCategory),
        action_description: (action_description as string).trim(),
        action_payload: typeof action_payload === 'string' ? action_payload : null,
        content_hash: typeof content_hash === 'string' ? content_hash : null,
        timeout_at: await getTimeoutAt(storedCategory, timeout_seconds),
        tenant_id: requestTenant,
      })
      await notifyAboutNewRequest(approval)
      try {
        writeAgentAuditLog({ agent_id: approval.agent_id, entity: 'approval', action: 'create', entity_id: approval.id, detail: { category: approval.category } })
      } catch { /* audit failure must not abort the write */ }
      logger.info({ id, agent_id, category }, 'Approval request created')
      json(res, approval, 201)
      return true
    }

    // An email request: only the main agent sends mail, so only it asks to (a sub-agent's mail goes
    // through the main agent). The body is the envelope of the exact mail; the server rebuilds the
    // hash and the description from it and keeps what it hashed as the payload.
    if (requester !== MAIN_AGENT_ID) {
      json(res, { error: 'forbidden', hint: 'An email_send approval is requested by the main agent that sends the mail; a sub-agent gets 403' }, 403)
      return true
    }
    if (typeof action_payload !== 'string') {
      json(res, { error: 'required', field: 'action_payload', hint: 'action_payload is required for email_send: the JSON envelope of the mail' }, 400)
      return true
    }
    if (Buffer.byteLength(action_payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      json(res, { error: 'invalid_value', field: 'action_payload', hint: `action_payload is larger than ${MAX_PAYLOAD_BYTES} bytes` }, 400)
      return true
    }
    let envelopeInput: unknown
    try {
      envelopeInput = JSON.parse(action_payload)
    } catch {
      json(res, { error: 'invalid_value', field: 'action_payload', hint: 'action_payload must be a JSON object (the email envelope)' }, 400)
      return true
    }
    const parsed = parseEmailEnvelope(envelopeInput, requester)
    if (!parsed.ok) {
      json(res, { error: 'invalid_value', field: 'action_payload', code: 'invalid_envelope', envelope_field: parsed.field, hint: parsed.hint }, 400)
      return true
    }
    // A mail with an HTML part cannot be approved: the person deciding is shown the text part and the
    // fingerprint of the HTML, but the recipient would read the HTML, so harmless text could be approved and
    // a different page sent. Refused until the dashboard shows the HTML part as text.
    if (parsed.envelope.html_sha256 !== undefined) {
      json(res, {
        error: 'invalid_value', field: 'action_payload', code: 'html_not_supported', envelope_field: 'html_sha256',
        hint: 'A mail with an HTML part cannot be approved: the approval shows the text, the recipient would read the HTML. Send the mail as plain text.',
      }, 400)
      return true
    }
    if (typeof content_hash === 'string' && content_hash !== parsed.hash) {
      // The payload is not the mail the requester thinks it hashed: a parity fault, or a tampered request.
      try {
        writeAgentAuditLog({ agent_id: requester, entity: 'approval', action: 'envelope_hash_mismatch', detail: { client_hash_prefix: content_hash.slice(0, 12), server_hash_prefix: parsed.hash.slice(0, 12) } })
      } catch { /* audit failure must not change the refusal */ }
      json(res, { error: 'invalid_value', field: 'content_hash', code: 'hash_mismatch', hint: 'content_hash does not match the hash the server computes from action_payload' }, 400)
      return true
    }

    const opened = createApprovalOnce({
      id: randomUUID(),
      agent_id: requester,
      category: EMAIL_SEND_CATEGORY,
      human_only: true,
      action_description: describeEmail(parsed.envelope, parsed.hash),
      action_payload: parsed.canon,
      content_hash: parsed.hash,
      timeout_at: await getTimeoutAt(EMAIL_SEND_CATEGORY, timeout_seconds),
      tenant_id: requestTenant,
      max_pending: MAX_PENDING_EMAIL_REQUESTS,
    })
    if (!opened.ok) {
      if (opened.reason === 'hash_mismatch') {
        json(res, { error: 'invalid_value', field: 'content_hash', code: 'hash_mismatch', hint: 'content_hash is not a valid hash' }, 400)
      } else {
        json(res, { error: 'conflict', reason: 'too_many_pending', hint: `There are already ${MAX_PENDING_EMAIL_REQUESTS} email requests waiting for a decision` }, 409)
      }
      return true
    }
    // The same mail asked for again while its request is open gets that request back: nothing new is
    // announced to the owner.
    if (opened.deduplicated) {
      json(res, { ...opened.approval, deduplicated: true }, 200)
      return true
    }
    const approval = opened.approval
    await notifyAboutNewRequest(approval)
    try {
      writeAgentAuditLog({ agent_id: approval.agent_id, entity: 'approval', action: 'create', entity_id: approval.id, detail: { category: approval.category } })
    } catch { /* audit failure must not abort the write */ }
    logger.info({ id: approval.id, agent_id: requester, category: approval.category }, 'Approval request created')
    json(res, approval, 201)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const content_hash = url.searchParams.get('content_hash') ?? undefined
    if (content_hash !== undefined && !isContentHash(content_hash)) {
      json(res, { error: 'invalid_value', field: 'content_hash', hint: 'content_hash must be 64 lowercase hex characters (a sha256)' }, 400)
      return true
    }

    const page = parsePagination(url.searchParams, res, { defaultLimit: 25, maxLimit: 500 })
    if (!page) return true
    const { limit, offset } = page

    // A fleet_agent token lists its OWN requests, whatever ?agent= says, and gets no fleet-wide
    // aggregates (the oldest-pending row would be another agent's request).
    if (ctx.role === 'fleet_agent') {
      if (agent_id !== undefined && denyForeignAgent(ctx, agent_id)) return true
      const own = { agent_id: ctx.tokenAgentId, category, status, content_hash }
      json(res, { items: listApprovals({ ...own, limit, offset }), total: countApprovals(own), offset, limit, counts: {}, oldest_pending: null, window_s: APPROVAL_CONSUME_WINDOW_S })
      return true
    }

    // Admin sees all tenants; non-admin session users are scoped to their own
    // tenant. Bearer-token (fleet agents) callers are treated as admin-equivalent
    // for reads (they use the global dashboard token, no tenant affiliation).
    // Fail-closed: a non-admin session with no tenant assignment returns 403
    // rather than silently dropping the filter and leaking all tenants' data.
    // Admin may pass ?tenant= to narrow the view to a specific tenant.
    let tenantId: string | undefined
    if (ctx.role === 'admin') {
      const tenantParam = url.searchParams.get('tenant')
      if (tenantParam) tenantId = tenantParam
    } else if (ctx.auth?.kind === 'session') {
      if (!ctx.tenantId) {
        json(res, { error: 'forbidden', hint: 'No tenant scope assigned to this session' }, 403)
        return true
      }
      tenantId = ctx.tenantId
    }

    const filter = { agent_id, category, status, content_hash, tenantId }
    const items = listApprovals({ ...filter, limit, offset })
    const total = countApprovals(filter)
    const counts = getApprovalStatusCounts(tenantId)
    const oldestPending = getOldestPendingApproval(tenantId) ?? null
    json(res, { items, total, offset, limit, counts, oldest_pending: oldestPending, window_s: APPROVAL_CONSUME_WINDOW_S })
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    // A fleet_agent reads its own requests only; a tenant user, those of its own tenant. Both get the
    // same 404 as a missing id (no existence oracle).
    const hidden = approval !== undefined && (
      (ctx.role === 'fleet_agent' && approval.agent_id !== ctx.tokenAgentId) ||
      (ctx.auth?.kind === 'session' && ctx.role !== 'admin' && approval.tenant_id !== ctx.tenantId)
    )
    if (!approval || hidden) {
      json(res, { error: 'not_found', hint: 'Not found' }, 404)
      return true
    }
    json(res, approval)
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    // An approval is a human's (or the main agent's) decision. A fleet agent's token may ask for one
    // (POST) and read it, never resolve it: approvals:write reaches this route only because the same
    // permission also covers the request.
    if (ctx.role === 'fleet_agent') {
      const asked = getApproval(idMatch[1])
      if (asked && await isHumanOnlyApproval(asked)) journalNonHumanDecision(asked, ctx.tokenAgentId)
      json(res, { error: 'forbidden', hint: 'A fleet agent token cannot resolve approvals' }, 403)
      return true
    }
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'invalid_value', field: 'status', hint: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }

    // Who resolved it comes from the authenticated principal, never from the body: a session user, a
    // federation peer, an enrolled device, the agent a token names, the name of a registered token, or
    // 'shared-token' for the legacy file token (which cannot say who held it). The body's resolved_by
    // is only a self-declared label (the channel the decision came by, e.g. telegram_text): it goes
    // into the audit detail as `declared_resolved_by`, never into the stored resolver or the guard.
    const principal: string | undefined =
      ctx.auth?.user ?? ctx.auth?.peer ?? ctx.auth?.device ?? ctx.tokenAgentId ?? ctx.auth?.tokenName ??
      (ctx.auth?.kind === 'token' ? 'shared-token' : undefined)
    const declared: string | undefined = typeof resolved_by === 'string' && resolved_by.trim() ? resolved_by.trim() : undefined
    let effectiveResolvedBy: string | undefined = principal ?? declared

    if (!effectiveResolvedBy) {
      json(res, { error: 'required', field: 'resolved_by', hint: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null
    const target = getApproval(idMatch[1])

    // Human-only approval: the one way to decide it is a person's dashboard session (a global admin),
    // whatever token the request also carries and whatever status it asks for (a rejection or a timeout
    // by a token is as much a decision as an approval). Without enforcement the request goes through as
    // before, and the journal records that it would have been refused.
    let resolvedVia: ApprovalResolvedVia | null = ctx.auth?.kind === 'session' ? 'dashboard_session' : ctx.auth ? 'bearer' : null
    if (target && await isHumanOnlyApproval(target)) {
      const human = humanSessionOf(req)
      if (human) {
        resolvedVia = 'dashboard_session'
        if (APPROVAL_HUMAN_ONLY_ENFORCE) effectiveResolvedBy = `human:session:${human.user}`
      } else {
        journalNonHumanDecision(target, effectiveResolvedBy)
        if (APPROVAL_HUMAN_ONLY_ENFORCE) {
          json(res, HUMAN_ONLY_REFUSAL, 403)
          return true
        }
      }
    }

    // Self-approval guard: the requesting agent cannot approve its own request. It runs on the
    // authenticated principal above, so a body naming someone else no longer slips past it. It does not
    // close self-approval by itself (the main agent relays a human's decision under its own token); the
    // real control lives on the main-agent side (approval-request-handling skill).
    if (target && effectiveResolvedBy === target.agent_id) {
      json(res, { error: 'forbidden', hint: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    // IDOR guard: non-admin session users may only resolve approvals that belong
    // to their own tenant.
    if (ctx.auth?.kind === 'session' && ctx.role !== 'admin') {
      if (!ctx.tenantId) {
        // Session has no tenant scope -- config error, fail-closed.
        json(res, { error: 'forbidden', hint: 'No tenant scope assigned to this session' }, 403)
        return true
      }
      if (!target || target.tenant_id !== ctx.tenantId) {
        // Cross-tenant or not found -- anti-enumeration: same as kanban/memories.
        json(res, { error: 'not_found' }, 404)
        return true
      }
    }

    const updated = resolveApproval(idMatch[1], status, effectiveResolvedBy, msgId, resolvedVia)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'not_found', hint: 'Not found' }, 404)
      } else if (existing.status === 'pending') {
        // Still pending, so the refusal came from the deadline: expired, but not swept yet.
        json(res, { error: 'conflict', hint: 'Approval has expired' }, 409)
      } else {
        json(res, { error: 'conflict', hint: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    await notifyRequester(approval)
    try {
      writeAgentAuditLog({ agent_id: effectiveResolvedBy, entity: 'approval', action: 'update', entity_id: idMatch[1], detail: { status, requested_by: approval?.agent_id ?? null, ...(declared && declared !== effectiveResolvedBy ? { declared_resolved_by: declared } : {}) } })
    } catch { /* audit failure must not abort the write */ }
    logger.info({ id: idMatch[1], status, resolved_by: effectiveResolvedBy }, 'Approval resolved')
    json(res, approval)
    return true
  }

  return false
}

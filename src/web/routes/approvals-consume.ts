import { APPROVAL_CONSUME_WINDOW_S } from '../../config.js'
import {
  consumeApproval, claimApproval, getApproval, listApprovalEvents, writeAgentAuditLog, isContentHash,
  type Approval, type ConsumeOutcome, type ClaimOutcome,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { loadOrCreateClaimSigningKey, signClaim, signUse } from '../claim-signature.js'
import type { RouteContext } from './types.js'

// Using up an approved email request: POST /api/approvals/:id/consume (the approval is named) and
// POST /api/approvals/claim (the mail is named, by its hash). Both are the send gate's calls, made with
// the token of the agent that asked. The storage layer (db/vault.ts) holds the rules; this file holds
// the identity, the body checks, the answer shapes and the audit row.
//
// A 200 carries `sig`, an HMAC the caller checks with the key in store/.claim-signing-key (claim-signature.ts),
// so a listener that only mirrors the request cannot pass for the dashboard. When the key cannot be loaded the
// answer is 503, and it is decided BEFORE anything is used up: an approval is never spent on an answer that
// could not be signed.

const MAX_REF_CHARS = 200
const MAX_CONSUMER_CHARS = 64
const SAFE_LABEL = /^[\x20-\x7e]*$/

interface UseBody { content_hash: string; category?: string; ref: string | null; consumer: string | null; mode: 'send' | null }

/** The agent a request acts as: the one its token names. A shared token, a session and a device name none. */
function principalOf(ctx: RouteContext): string | undefined {
  return typeof ctx.tokenAgentId === 'string' && ctx.tokenAgentId !== '' ? ctx.tokenAgentId : undefined
}

function tenantOf(ctx: RouteContext): string {
  return typeof ctx.tenantId === 'string' && ctx.tenantId !== '' ? ctx.tenantId : 'default'
}

/** What a refusal may say about the row: its state, never its content. */
function stateOf(approval: Approval | undefined) {
  if (!approval) return undefined
  return {
    id: approval.id, status: approval.status,
    consumed_at: approval.consumed_at ?? null, consumed_by: approval.consumed_by ?? null, consumed_ref: approval.consumed_ref ?? null,
  }
}

function invalid(ctx: RouteContext, field: string, hint: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint }, 400)
  return true
}

async function readUseBody(ctx: RouteContext, needCategory: boolean): Promise<UseBody | null> {
  let raw: unknown
  try {
    raw = JSON.parse((await readBody(ctx.req)).toString())
  } catch {
    json(ctx.res, { error: 'parse_error', hint: 'Invalid JSON' }, 400)
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(ctx, 'body', 'The body must be a JSON object')
    return null
  }
  const b = raw as Record<string, unknown>
  if (!isContentHash(b['content_hash'])) {
    invalid(ctx, 'content_hash', 'content_hash is required: 64 lowercase hex characters (the sha256 of the mail)')
    return null
  }
  if (needCategory && (typeof b['category'] !== 'string' || b['category'].trim() === '')) {
    json(ctx.res, { error: 'required', field: 'category', hint: 'category is required' }, 400)
    return null
  }
  const label = (field: 'ref' | 'consumer', max: number): string | null | undefined => {
    const v = b[field]
    if (v === undefined || v === null) return null
    if (typeof v !== 'string' || v.length > max || !SAFE_LABEL.test(v)) {
      invalid(ctx, field, `${field} must be printable ASCII, at most ${max} characters`)
      return undefined
    }
    return v === '' ? null : v
  }
  const ref = label('ref', MAX_REF_CHARS)
  if (ref === undefined) return null
  const consumer = label('consumer', MAX_CONSUMER_CHARS)
  if (consumer === undefined) return null
  // `mode: "send"` is the official sender's claim (it seals the effect and takes over the gate's reservation); the
  // gate sends no mode. It belongs to the claim call and needs the sender's own ref.
  const rawMode = b['mode']
  let mode: 'send' | null = null
  if (rawMode !== undefined && rawMode !== null) {
    if (rawMode !== 'send' || !needCategory) {
      invalid(ctx, 'mode', 'mode must be "send", and only on POST /api/approvals/claim')
      return null
    }
    if (ref === null) {
      json(ctx.res, { error: 'required', field: 'ref', hint: 'ref is required with mode "send"' }, 400)
      return null
    }
    mode = 'send'
  }
  return { content_hash: b['content_hash'], category: needCategory ? (b['category'] as string).trim() : undefined, ref, consumer, mode }
}

/** Every use attempt leaves an audit row, refused or not; a failure to write it changes no answer. */
function auditUse(principal: string, via: 'id' | 'claim', outcome: ConsumeOutcome | ClaimOutcome, id: string | undefined, hash: string): void {
  try {
    writeAgentAuditLog({
      agent_id: principal, entity: 'approval', action: 'consume', entity_id: id ?? (outcome.approval ? outcome.approval.id : undefined),
      detail: {
        via, outcome: outcome.ok ? (outcome.replayed ? 'replayed' : 'adopted' in outcome && outcome.adopted ? 'adopted' : 'consumed') : outcome.reason,
        hash_prefix: hash.slice(0, 12),
      },
    })
  } catch { /* audit failure must not change the answer */ }
}

function signingUnavailable(ctx: RouteContext): true {
  json(ctx.res, {
    error: 'internal_error', reason: 'claim_signing_unavailable',
    hint: 'The approval service cannot sign its answer, so it uses nothing up. Check store/.claim-signing-key on the server.',
  }, 503)
  return true
}

async function handleUse(ctx: RouteContext, id: string | null): Promise<true> {
  const principal = principalOf(ctx)
  if (!principal) {
    json(ctx.res, {
      error: 'forbidden', reason: 'agent_identity_required',
      hint: 'An approval is used up with the token of the agent that asked for it; a shared token, a session or a device cannot',
    }, 403)
    return true
  }
  const body = await readUseBody(ctx, id === null)
  if (!body) return true

  let signingKey: Buffer
  try {
    signingKey = loadOrCreateClaimSigningKey()
  } catch {
    // The message names no path and no key material.
    logger.error({ agent: principal }, 'Approval not used: the claim signing key cannot be loaded')
    return signingUnavailable(ctx)
  }

  const common = { content_hash: body.content_hash, principal, tenant_id: tenantOf(ctx), window_s: APPROVAL_CONSUME_WINDOW_S, ref: body.ref, consumer: body.consumer }
  const outcome = id !== null
    ? consumeApproval({ ...common, id })
    : claimApproval({ ...common, category: body.category as string, ...(body.mode === 'send' ? { mode: 'send' as const } : {}) })
  auditUse(principal, id !== null ? 'id' : 'claim', outcome, id ?? undefined, body.content_hash)

  if (outcome.ok) {
    logger.info({ id: outcome.approval.id, agent: principal, replayed: outcome.replayed }, 'Approval used up')
    const a = outcome.approval
    // The signed values are the stored ones, so a replayed answer carries the same signature as the first.
    if (typeof a.consumed_at !== 'number' || typeof a.content_hash !== 'string') return signingUnavailable(ctx)
    if (body.mode === 'send') {
      // The sender's answer is a different, versioned signature (v2) over ITS ref and the moment it sealed the use.
      if (typeof a.used_at !== 'number' || typeof a.used_ref !== 'string') return signingUnavailable(ctx)
      const sig = signUse({
        content_hash: a.content_hash, category: a.category, agent_id: a.agent_id, ref: a.used_ref, consumed_at: a.consumed_at, used_at: a.used_at,
      }, signingKey)
      json(ctx.res, { ok: true, replayed: outcome.replayed, adopted: 'adopted' in outcome && outcome.adopted === true, window_s: APPROVAL_CONSUME_WINDOW_S, approval: a, sig })
      return true
    }
    const sig = signClaim({
      content_hash: a.content_hash, category: a.category, agent_id: a.agent_id, ref: a.consumed_ref ?? null, consumed_at: a.consumed_at,
    }, signingKey)
    json(ctx.res, { ok: true, replayed: outcome.replayed, window_s: APPROVAL_CONSUME_WINDOW_S, approval: a, sig })
    return true
  }
  switch (outcome.reason) {
    case 'not_found':
      // Another tenant's id answers like a missing one.
      json(ctx.res, { error: 'not_found', hint: 'No such approval' }, 404)
      return true
    case 'agent_mismatch':
      json(ctx.res, { error: 'forbidden', reason: 'agent_mismatch', hint: 'The approval was requested by another agent' }, 403)
      return true
    default: {
      // `pending` names the open request so the gate does not open a second one.
      const open = outcome.reason === 'pending' && outcome.approval ? { approval_id: outcome.approval.id } : {}
      json(ctx.res, { error: 'conflict', reason: outcome.reason, window_s: APPROVAL_CONSUME_WINDOW_S, ...open, approval: stateOf(outcome.approval) }, 409)
      return true
    }
  }
}

/** GET /api/approvals/:id/events -- the journal of one approval, for diagnosis and the Approvals page. */
function handleEvents(ctx: RouteContext, id: string): true {
  // The journal names the principals that touched the row: a person's or the admin's view, not an agent's.
  if (ctx.role === 'fleet_agent') {
    json(ctx.res, { error: 'forbidden', hint: 'The approval journal is read by the owner, not by a fleet agent token' }, 403)
    return true
  }
  const approval = getApproval(id)
  const foreignTenant = approval !== undefined && ctx.auth?.kind === 'session' && ctx.role !== 'admin' && approval.tenant_id !== ctx.tenantId
  if (!approval || foreignTenant) {
    json(ctx.res, { error: 'not_found', hint: 'Not found' }, 404)
    return true
  }
  json(ctx.res, { approval_id: approval.id, items: listApprovalEvents(approval.id) })
  return true
}

/** The use-up and journal routes of approvals; false when the request is none of them. */
export async function tryHandleApprovalUse(ctx: RouteContext): Promise<boolean> {
  const { path, method } = ctx
  if (method === 'POST') {
    if (path === '/api/approvals/claim') return handleUse(ctx, null)
    const m = path.match(/^\/api\/approvals\/([^/]+)\/consume$/)
    if (m) return handleUse(ctx, m[1])
  }
  if (method === 'GET') {
    const m = path.match(/^\/api\/approvals\/([^/]+)\/events$/)
    if (m) return handleEvents(ctx, m[1])
  }
  return false
}

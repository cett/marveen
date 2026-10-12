// Routes an agent must not be able to use to obtain a person's session or a credential of its own.
//
// A dashboard login is what makes a human-only approval decision a person's: it is only granted to
// someone who knows a user's password. If a bearer token (the main agent's included) could create a
// user, reset a password or mint a credential, the agent could log in and decide for itself, so these
// routes are reachable only with a human session once the APPROVAL_HUMAN_ONLY_ENFORCE switch is on. The
// guard lives in each route because the RBAC table cannot say "a session, and not a token".
//
// Both helpers write the refusal themselves and return true when they did, so a route reads:
//   if (denyUnlessHumanSession(ctx, 'auth.user.create')) return true

import { APPROVAL_HUMAN_ONLY_ENFORCE } from '../config.js'
import { countDashboardUsers, writeAdminAuditLog } from '../db.js'
import { logger } from '../logger.js'
import { json } from './http-helpers.js'
import { humanSessionOf } from './approval-human-only.js'
import type { RouteContext } from './routes/types.js'

/** Journal a refused attempt. Never throws: an audit fault must not change the answer. */
function auditRefusal(ctx: RouteContext, action: string): void {
  try {
    const actor = ctx.auth?.tokenName ?? ctx.auth?.user ?? ctx.tokenAgentId ?? ctx.auth?.kind ?? 'unknown'
    writeAdminAuditLog(actor, 'security.human_session_required', action, {
      path: ctx.path,
      method: ctx.method,
      kind: ctx.auth?.kind ?? null,
      role: ctx.role ?? null,
      token_agent: ctx.tokenAgentId ?? null,
    })
  } catch (err) {
    logger.warn({ err, action }, 'Could not journal a refused session-only request')
  }
}

function refuse(ctx: RouteContext, action: string, hint: string): true {
  auditRefusal(ctx, action)
  json(ctx.res, { error: 'forbidden', code: 'human_session_required', hint }, 403)
  return true
}

/**
 * Session-only guard for user management and the bearer password reset. With the switch on and at least
 * one enabled dashboard user, only a person logged in as a global admin passes. With no enabled user
 * (first run) the bearer stays the way to create the first one, and with the switch off nothing changes.
 * Returns true when it refused (the response is written).
 */
export function denyUnlessHumanSession(ctx: RouteContext, action: string): boolean {
  if (!APPROVAL_HUMAN_ONLY_ENFORCE) return false
  if (countDashboardUsers(false) === 0) return false
  if (humanSessionOf(ctx.req)) return false
  return refuse(ctx, action, 'Managing dashboard users needs a person logged in to the dashboard as a global admin')
}

/**
 * Guard for the routes that hand out a credential (API token, browser enrollment code, device key).
 * With the switch on, a fleet agent token, any token that carries an agent identity (the main agent's
 * included) and any caller that is neither a token nor a session (a device key, a federation peer) is
 * refused; the operator's token, other admin tokens and any session pass. A valid human session cookie
 * passes whatever else the request carries. Returns true when it refused.
 */
export function denyAgentCredentialIssue(ctx: RouteContext, action: string): boolean {
  if (!APPROVAL_HUMAN_ONLY_ENFORCE) return false
  const kind = ctx.auth?.kind
  const agentLike = ctx.role === 'fleet_agent' || !!ctx.tokenAgentId || (kind !== 'token' && kind !== 'session')
  if (!agentLike) return false
  if (humanSessionOf(ctx.req)) return false
  return refuse(ctx, action, 'An agent cannot issue credentials; ask the owner to do it from the dashboard')
}

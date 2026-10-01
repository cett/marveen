import { createAgentMessage, writeAgentAuditLog } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import type { RouteContext } from './routes/types.js'

// Side effects of a schedule write that a person has to be able to trace: one
// agent_audit_log row per write, and a message to the main agent when a task is sent back
// to review. Both are best-effort: a failed audit insert or a failed notification never
// turns a successful write into an error (the review gate itself is the status the row
// holds, not these).

export type ScheduleAuditAction = 'create' | 'update' | 'delete' | 'toggle' | 'activate' | 'review_requested'

export interface ScheduleActor {
  /** agent_audit_log.agent_id: the session user, the token name, the device name, or `claimed:<id>`. */
  agentId: string
  actorKind: 'session' | 'token' | 'device' | 'other'
  /** The self-declared X-Agent-Id, kept apart because it is not authentication. */
  claimedAgent: string | null
}

export function scheduleActor(ctx: RouteContext): ScheduleActor {
  const claimedAgent = (ctx.agentId ?? '').trim() || null
  const auth = ctx.auth
  if (auth?.kind === 'session') return { agentId: auth.user ?? 'session', actorKind: 'session', claimedAgent }
  if (auth?.kind === 'device') return { agentId: `device:${auth.device ?? 'unknown'}`, actorKind: 'device', claimedAgent }
  if (auth?.kind === 'token') {
    // A scoped token has a name; the shared dashboard token has none and is the way every
    // fleet agent calls, so the (unverified) claim is the most useful thing to record.
    if (auth.tokenName) return { agentId: `token:${auth.tokenName}`, actorKind: 'token', claimedAgent }
    return { agentId: claimedAgent ? `claimed:${claimedAgent}` : 'token:shared', actorKind: 'token', claimedAgent }
  }
  return { agentId: claimedAgent ? `claimed:${claimedAgent}` : 'unknown', actorKind: 'other', claimedAgent }
}

export function auditScheduleWrite(
  ctx: RouteContext,
  action: ScheduleAuditAction,
  name: string,
  tenant: string,
  detail: Record<string, unknown> = {},
): void {
  const actor = scheduleActor(ctx)
  try {
    writeAgentAuditLog({
      agent_id: actor.agentId,
      entity: 'schedule',
      action,
      entity_id: name,
      detail: { tenant, actor_kind: actor.actorKind, claimed_agent: actor.claimedAgent, ...detail },
    })
  } catch (err) {
    logger.warn({ err, name, action }, 'schedule audit log write failed')
  }
}

// One notification per task per window, so a client that saves a task in a loop cannot
// turn the main agent's inbox into a feed. The state is per process: a restart forgets it,
// which only means one extra message, never a lost one.
export const REVIEW_NOTIFY_WINDOW_MS = 60 * 60 * 1000
const lastNotified = new Map<string, number>()

/** Test hook: forget the throttle state. */
export function resetReviewNotifyThrottle(): void {
  lastNotified.clear()
}

export function notifyScheduleReview(opts: {
  name: string
  tenant: string
  reason: 'edited' | 'created'
  changed?: ReadonlyArray<string>
  by: string
  now?: number
}): boolean {
  const now = opts.now ?? Date.now()
  const key = `${opts.name}:${opts.reason}`
  const last = lastNotified.get(key)
  if (last !== undefined && now - last < REVIEW_NOTIFY_WINDOW_MS) return false
  const parts = [
    '[SCHEDULE_REVIEW]',
    `task=${opts.name}`,
    `tenant=${opts.tenant}`,
    `reason=${opts.reason}`,
    ...(opts.changed && opts.changed.length > 0 ? [`changed=[${opts.changed.join(',')}]`] : []),
    `by=${opts.by}`,
  ]
  try {
    createAgentMessage('system', MAIN_AGENT_ID, parts.join(' '))
    lastNotified.set(key, now)
    return true
  } catch (err) {
    logger.warn({ err, name: opts.name }, 'Failed to notify main agent of a schedule review request')
    return false
  }
}

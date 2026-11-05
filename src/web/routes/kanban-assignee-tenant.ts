// The assignee of a kanban card is a NAME the caller writes (the claimant of POST /:id/claim, the `assignee` of
// PUT /:id and POST /). A tenant-bound caller must not be able to put the name of ANOTHER tenant's agent there: the
// dispatch would wake that agent and the audit row would carry its id.
//
// A deny rule, not an allowlist: the live assignees are free text (human names, other capitalisation, a comma list
// like "rick, zack") and fleet-internal agents that no tenant lists (rick, zack, boo ...) serve the default tenant by
// convention, so an allowlist of the tenant's enabled agents would break them at once. A part of the value is judged
// only when it is an agent name; anything else is free text and passes.

import type http from 'node:http'
import { getServedTenantIds } from '../../db/agents.js'
import { isKnownAgent } from '../agent-config.js'
import { BOT_NAME, MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'

/**
 * 'foreign' when any comma-separated part of `value` is the name of an agent that does not serve `callerTenantId`;
 * 'ok' otherwise. An agent name is one that is a known agent (main agent or an agents/<name> folder) or that serves a
 * tenant. The tenants of an agent no tenant lists are ['default'] (the owning-tenant convention).
 */
export async function assigneeTenantVerdict(value: string, callerTenantId: string): Promise<'ok' | 'foreign'> {
  for (const typed of value.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')) {
    // The dispatcher (canonicalAgentId in kanban-dispatch.ts) maps the bot name onto the main agent, so that is the
    // agent a card assigned to the bot name wakes: judge it as the main agent, not as free text.
    const part = typed === BOT_NAME.toLowerCase() ? MAIN_AGENT_ID.toLowerCase() : typed
    const served = await getServedTenantIds(part)
    if (served.length === 0 && !isKnownAgent(part)) continue
    const tenants = served.length > 0 ? served : ['default']
    if (!tenants.includes(callerTenantId)) return 'foreign'
  }
  return 'ok'
}

/**
 * Answers the request and returns true when the assignee must be refused: a foreign agent as a 404 (like a missing
 * reference), a failed lookup as a 500 (fail closed: never let it through). Returns false when the caller may go on.
 */
export async function refuseForeignAssignee(res: http.ServerResponse, value: string, field: 'assignee' | 'agent', callerTenantId: string): Promise<boolean> {
  let verdict: 'ok' | 'foreign'
  try {
    verdict = await assigneeTenantVerdict(value, callerTenantId)
  } catch (err) {
    logger.error({ err, field }, 'kanban: the assignee tenant check failed, the request is refused')
    json(res, { error: 'internal_error', hint: 'Failed to check the assignee' }, 500)
    return true
  }
  if (verdict === 'ok') return false
  json(res, { error: 'not_found', field, hint: 'Agent not found' }, 404)
  return true
}

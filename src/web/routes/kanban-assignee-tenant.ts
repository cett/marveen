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
 * `servedMemo` (optional, one per request) remembers the tenants an agent name served, so a batch that names the same
 * agent many times looks it up once.
 */
export async function assigneeTenantVerdict(value: string, callerTenantId: string, servedMemo?: Map<string, string[]>): Promise<'ok' | 'foreign'> {
  for (const typed of value.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')) {
    // The dispatcher (canonicalAgentId in kanban-dispatch.ts) maps the bot name onto the main agent, so that is the
    // agent a card assigned to the bot name wakes: judge it as the main agent, not as free text.
    const part = typed === BOT_NAME.toLowerCase() ? MAIN_AGENT_ID.toLowerCase() : typed
    let served = servedMemo?.get(part)
    if (served === undefined) {
      served = await getServedTenantIds(part)
      servedMemo?.set(part, served)
    }
    if (served.length === 0 && !isKnownAgent(part)) continue
    const tenants = served.length > 0 ? served : ['default']
    if (!tenants.includes(callerTenantId)) return 'foreign'
  }
  return 'ok'
}

/**
 * An `assignee` the caller writes in a request body (PUT /:id, POST /, a subtask of POST /:id/breakdown/accept).
 *
 * The TYPE rule holds for every caller, the admin included: the value is a string or null. The database layer writes
 * whatever it is handed (a one-element array resolves to its single element as a bound parameter and lands as that
 * text, a longer array or an object throws, a number lands as "123.0"), so anything but a string or null is a 400
 * before any write, and before the tenant verdict (a verdict judges a string only, a non-string would walk past it).
 * An absent key is 'unchanged' (the caller does not call this); null and a blank string unassign and are not judged.
 *
 * The TENANT verdict (a foreign agent is a 404) is for a tenant-bound caller only: `callerTenantId` is null for the
 * admin (no tenant line to hold), and the verdict is then skipped.
 *
 * Answers the request and returns true when it is refused; false when the caller may go on.
 */
export async function refuseBodyAssignee(
  res: http.ServerResponse,
  value: unknown,
  callerTenantId: string | null,
  field = 'assignee',
  servedMemo?: Map<string, string[]>,
): Promise<boolean> {
  if (value === null) return false
  if (typeof value !== 'string') {
    json(res, { error: 'invalid_value', field, hint: 'assignee must be a string or null' }, 400)
    return true
  }
  if (callerTenantId === null || value.trim() === '') return false
  return refuseForeignAssignee(res, value, field, callerTenantId, servedMemo)
}

/**
 * The `subtasks` of POST /:id/breakdown/accept: every element, in order, up to the first refusal (one bad element
 * refuses the WHOLE batch, nothing is written). An element must be an object (400 field `subtasks`); its `assignee`,
 * when the key is present, follows refuseBodyAssignee with the field `subtasks[<i>].assignee`. The agent lookups of the
 * batch share one memo, so the same name many times is looked up once.
 */
export async function refuseSubtaskAssignees(res: http.ServerResponse, subtasks: unknown[], callerTenantId: string | null): Promise<boolean> {
  const servedMemo = new Map<string, string[]>()
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i]
    if (typeof st !== 'object' || st === null || Array.isArray(st)) {
      json(res, { error: 'invalid_value', field: 'subtasks', hint: 'Every subtask must be an object' }, 400)
      return true
    }
    if (!('assignee' in st)) continue
    if (await refuseBodyAssignee(res, (st as { assignee?: unknown }).assignee, callerTenantId, `subtasks[${i}].assignee`, servedMemo)) return true
  }
  return false
}

/**
 * Answers the request and returns true when the assignee must be refused: a foreign agent as a 404 (like a missing
 * reference), a failed lookup as a 500 (fail closed: never let it through). Returns false when the caller may go on.
 */
export async function refuseForeignAssignee(
  res: http.ServerResponse,
  value: string,
  field: string,
  callerTenantId: string,
  servedMemo?: Map<string, string[]>,
): Promise<boolean> {
  let verdict: 'ok' | 'foreign'
  try {
    verdict = await assigneeTenantVerdict(value, callerTenantId, servedMemo)
  } catch (err) {
    logger.error({ err, field }, 'kanban: the assignee tenant check failed, the request is refused')
    json(res, { error: 'internal_error', hint: 'Failed to check the assignee' }, 500)
    return true
  }
  if (verdict === 'ok') return false
  json(res, { error: 'not_found', field, hint: 'Agent not found' }, 404)
  return true
}

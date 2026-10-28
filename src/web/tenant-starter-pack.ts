import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, WEB_PORT } from '../config.js'
import {
  getTenant,
  getTenantForMainAgent,
  getTenantsForAgent,
  getEnabledAgentsForTenant,
  getScheduleFromDb,
} from '../db.js'
import { logger } from '../logger.js'
import { sanitizeScheduleName } from './sanitize.js'
import { writeScheduledTask } from './scheduled-tasks-io.js'
import { knownScheduleAgents, scheduleAgentServesTenant } from './schedule-tenant.js'
import { auditScheduleWrite, isHumanAdmin, notifyScheduleReview, scheduleActor } from './schedule-review-effects.js'
import type { RouteContext } from './routes/types.js'

// Tenant starter pack: ONE scheduled task per tenant, a daily summary of the tenant's own
// memories. It is created as `draft` + disabled: activation (a person) and the enable toggle
// are two separate steps, so nothing is ever sent before an admin has looked at it. The pair
// rule of the schedules route applies (the agent must serve the tenant), and the agent must
// not be shared with another tenant, because a shared agent runs this prompt in whichever
// tenant context its session happens to hold.

export const STARTER_TASK_SUFFIX = 'starter-daily-summary'
const TEMPLATE_DIR = join(PROJECT_ROOT, 'templates', 'tenant-starter-pack', 'daily-summary')

/** The scheduled-task name of a tenant's starter summary. */
export function starterTaskName(tenantId: string): string {
  return `${sanitizeScheduleName(tenantId)}-${STARTER_TASK_SUFFIX}`
}

export interface StarterTemplate {
  prompt: string
  schedule: string
  type: 'task'
  description: string
  skipIfBusy: boolean
  forceSend: boolean
}

/** Pure: the four placeholders of the template, nothing else. The tenant's display name is not one of them. */
export function renderStarterPrompt(
  body: string,
  vars: { tenantId: string; agentId: string; installDir: string; webPort: number | string },
): string {
  return body
    .replaceAll('{{TENANT_ID}}', vars.tenantId)
    .replaceAll('{{AGENT_ID}}', vars.agentId)
    .replaceAll('{{INSTALL_DIR}}', vars.installDir)
    .replaceAll('{{WEB_PORT}}', String(vars.webPort))
    .trim()
}

export function loadStarterTemplate(tenantId: string, agentId: string): StarterTemplate {
  const config = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'task-config.json'), 'utf-8')) as Record<string, unknown>
  const body = readFileSync(join(TEMPLATE_DIR, 'SKILL.md'), 'utf-8')
  return {
    prompt: renderStarterPrompt(body, { tenantId, agentId, installDir: PROJECT_ROOT, webPort: WEB_PORT }),
    schedule: String(config['schedule']),
    type: 'task',
    description: String(config['description'] ?? ''),
    skipIfBusy: config['skipIfBusy'] === true,
    forceSend: config['forceSend'] === true,
  }
}

// ── Agent resolution ──────────────────────────────────────────────────────────

export type StarterAgentReason =
  | 'explicit'
  | 'main_agent'
  | 'single_enabled'
  | 'tenant_unavailable'   // unknown, disabled or the default tenant
  | 'not_serving'          // an explicit agent that does not serve the tenant
  | 'shared'               // the candidate also serves another tenant
  | 'ambiguous'            // zero or several candidates

export interface StarterAgentResolution {
  agent: string | null
  reason: StarterAgentReason
}

/** True when the agent is tied to a tenant other than `tenantId` (an enabled availability row, or being its main agent). */
export function agentIsShared(agent: string, tenantId: string): boolean {
  if (getTenantsForAgent(agent).some(t => t !== tenantId)) return true
  const mainOf = getTenantForMainAgent(agent)
  return mainOf !== undefined && mainOf.id !== tenantId
}

/**
 * The agent that runs the tenant's starter task: an explicit one, else the tenant's main agent,
 * else the only agent enabled for it. A null agent carries the reason it could not be chosen.
 */
export async function resolveStarterAgent(tenantId: string, explicit?: string): Promise<StarterAgentResolution> {
  const tenant = getTenant(tenantId)
  if (!tenant || tenant.disabled_at !== null || tenantId === 'default') return { agent: null, reason: 'tenant_unavailable' }
  const known = new Set(knownScheduleAgents())

  const accept = async (agent: string, reason: StarterAgentReason): Promise<StarterAgentResolution> => {
    if (!await scheduleAgentServesTenant(agent, tenantId)) return { agent: null, reason: 'not_serving' }
    if (agentIsShared(agent, tenantId)) return { agent: null, reason: 'shared' }
    return { agent, reason }
  }

  if (explicit) return accept(explicit, 'explicit')
  if (tenant.main_agent_id && known.has(tenant.main_agent_id) && tenant.main_agent_id !== MAIN_AGENT_ID) {
    return accept(tenant.main_agent_id, 'main_agent')
  }
  const enabled = getEnabledAgentsForTenant(tenantId).filter(a => known.has(a) && a !== MAIN_AGENT_ID)
  if (enabled.length === 1) return accept(enabled[0]!, 'single_enabled')
  return { agent: null, reason: 'ambiguous' }
}

// ── Create / reconcile ────────────────────────────────────────────────────────

export type StarterState = 'created' | 'ok' | 'retargeted' | 'needs_agent' | 'absent'

export interface StarterResult {
  tenant_id: string
  name: string
  state: StarterState
  agent: string | null
  /** Why no agent could be chosen (state needs_agent, or a create that was refused). */
  reason?: StarterAgentReason
  created: string[]
  skipped: { name: string; reason: 'exists' | 'name_conflict' }[]
  retargeted: { name: string; from: string; to: string }[]
}

function emptyResult(tenantId: string, name: string, state: StarterState, agent: string | null): StarterResult {
  return { tenant_id: tenantId, name, state, agent, created: [], skipped: [], retargeted: [] }
}

/** The tenant's starter row, only when it really is this tenant's (same name, same tenant_id). */
async function ownStarterRow(tenantId: string, name: string) {
  const row = await getScheduleFromDb(name)
  if (!row) return { row: undefined, conflict: false }
  return row.tenant_id === tenantId ? { row, conflict: false } : { row: undefined, conflict: true }
}

/**
 * Creates the tenant's starter task if it is missing, and reconciles it when it exists (the button
 * is also the manual repair). Returns an error shape instead of writing when no agent can be chosen.
 */
export async function createStarterPack(
  ctx: RouteContext,
  tenantId: string,
  opts: { agentId?: string } = {},
): Promise<{ ok: true; result: StarterResult } | { ok: false; error: 'tenant_unavailable' | 'ambiguous' | 'not_serving' | 'shared' | 'name_conflict'; name: string }> {
  const name = starterTaskName(tenantId)
  const { row, conflict } = await ownStarterRow(tenantId, name)
  if (conflict) return { ok: false, error: 'name_conflict', name }
  if (row) return { ok: true, result: await reconcileStarterPack(ctx, tenantId, { explicitAgent: opts.agentId, existed: true }) }

  const resolved = await resolveStarterAgent(tenantId, opts.agentId)
  if (!resolved.agent) return { ok: false, error: resolved.reason as 'tenant_unavailable' | 'ambiguous' | 'not_serving' | 'shared', name }
  const template = loadStarterTemplate(tenantId, resolved.agent)
  await writeScheduledTask(name, {
    description: template.description,
    prompt: template.prompt,
    schedule: template.schedule,
    type: template.type,
    skipIfBusy: template.skipIfBusy,
    forceSend: template.forceSend,
    agent: resolved.agent,
    enabled: false,
    status: 'draft',
    tenantId,
  })
  await auditScheduleWrite(ctx, 'create', name, tenantId, { status: 'draft', type: template.type, agent: resolved.agent, starter_pack: true })
  logger.info({ name, tenantId, agent: resolved.agent }, 'Tenant starter task created')
  const result = emptyResult(tenantId, name, 'created', resolved.agent)
  result.created.push(name)
  return { ok: true, result }
}

// ── Automatic creation for new tenants ────────────────────────────────────────

// A tenant created from now on gets its starter task (as the same draft + disabled row the button makes) without
// anyone asking. A new tenant has no agent yet, so creation usually cannot pick one: the tenant is then marked
// "pending" and the task is made when an agent is enabled for it. The marker is a file per tenant, removed once the
// task exists, so a task an admin deletes later does not come back, and a tenant that existed before this
// (no marker) is left to the button as before.

const PENDING_DIR_NAME = 'starter-pack-pending'
const pendingMarker = (tenantId: string): string | null =>
  /^[a-z0-9_-]+$/.test(tenantId) ? join(STORE_DIR, PENDING_DIR_NAME, tenantId) : null

/** Marks a freshly created tenant as owed its starter task. */
export function markStarterPackPending(tenantId: string): void {
  const file = pendingMarker(tenantId)
  if (!file) return
  try {
    mkdirSync(join(STORE_DIR, PENDING_DIR_NAME), { recursive: true })
    writeFileSync(file, new Date().toISOString() + '\n')
  } catch (err) {
    logger.warn({ err, tenantId }, 'starter pack: could not mark the tenant as pending')
  }
}

export function starterPackIsPending(tenantId: string): boolean {
  const file = pendingMarker(tenantId)
  return file !== null && existsSync(file)
}

/**
 * Creates the starter task of a tenant that is owed one, if an agent can be chosen now. A tenant that is not
 * pending is left alone. Returns the result when the task was created, null otherwise (not pending, or no agent yet).
 */
export async function autoCreateStarterPack(ctx: RouteContext, tenantId: string): Promise<StarterResult | null> {
  if (!starterPackIsPending(tenantId)) return null
  const out = await createStarterPack(ctx, tenantId)
  const file = pendingMarker(tenantId)!
  const settle = (): void => { try { unlinkSync(file) } catch { /* already gone */ } }
  if (out.ok) {
    settle()
    return out.result.created.length > 0 ? out.result : null
  }
  // A name taken by another tenant's task cannot be solved by waiting; every other refusal is "no agent yet".
  if (out.error === 'name_conflict') settle()
  return null
}

type StarterPlan =
  | { kind: 'ok'; agent: string }
  | { kind: 'retarget'; agent: string }
  | { kind: 'needs_agent'; reason: StarterAgentReason }

/** What reconciling an existing starter row would do. Pure reads, shared by the write path and the GET. */
async function planStarter(tenantId: string, currentAgent: string, explicitAgent?: string): Promise<StarterPlan> {
  const target = await resolveStarterAgent(tenantId, explicitAgent)
  if (target.agent) return target.agent === currentAgent ? { kind: 'ok', agent: currentAgent } : { kind: 'retarget', agent: target.agent }
  if (await scheduleAgentServesTenant(currentAgent, tenantId) && !agentIsShared(currentAgent, tenantId)) return { kind: 'ok', agent: currentAgent }
  return { kind: 'needs_agent', reason: target.reason }
}

export interface StarterDescription {
  tenant_id: string
  name: string
  exists: boolean
  /** absent | ok | retarget_pending (the next reconcile moves it) | needs_agent (its agent no longer serves the tenant and none can be chosen) */
  state: 'absent' | 'ok' | 'retarget_pending' | 'needs_agent'
  task: { agent: string; status: string; enabled: boolean } | null
  /** The agent a create (or reconcile) would pick right now, or why none can be picked. */
  resolution: StarterAgentResolution
}

/** Read-only view for the admin UI: the task row, and what the next create or reconcile would do. */
export async function describeStarterPack(tenantId: string): Promise<StarterDescription> {
  const name = starterTaskName(tenantId)
  const { row } = await ownStarterRow(tenantId, name)
  const resolution = await resolveStarterAgent(tenantId)
  if (!row) return { tenant_id: tenantId, name, exists: false, state: 'absent', task: null, resolution }
  const plan = await planStarter(tenantId, row.agent)
  const state = plan.kind === 'ok' ? 'ok' : plan.kind === 'retarget' ? 'retarget_pending' : 'needs_agent'
  return { tenant_id: tenantId, name, exists: true, state, task: { agent: row.agent, status: row.status, enabled: row.enabled === 1 }, resolution }
}

/**
 * Re-aims the tenant's starter task after the agent behind it changed. Touches only the task whose
 * name and tenant match; never creates one. A definite new agent replaces the old one and sends the
 * task back to draft + disabled; with no definite agent, a task whose agent still serves the tenant
 * is left alone, and one whose agent no longer does is parked (draft + disabled, agent unchanged)
 * and reported as needs_agent. A second run changes nothing.
 */
export async function reconcileStarterPack(
  ctx: RouteContext,
  tenantId: string,
  opts: { explicitAgent?: string; existed?: boolean } = {},
): Promise<StarterResult> {
  const name = starterTaskName(tenantId)
  const { row } = await ownStarterRow(tenantId, name)
  if (!row) return emptyResult(tenantId, name, 'absent', null)

  const current = row.agent
  const result = emptyResult(tenantId, name, 'ok', current)
  if (opts.existed) result.skipped.push({ name, reason: 'exists' })

  const plan = await planStarter(tenantId, current, opts.explicitAgent)
  if (plan.kind === 'ok') return result

  if (plan.kind === 'retarget') {
    await writeScheduledTask(name, { agent: plan.agent, status: 'draft', enabled: false })
    await auditScheduleWrite(ctx, 'retarget', name, tenantId, { from: current, to: plan.agent, starter_pack: true })
    if (!isHumanAdmin(ctx)) {
      await notifyScheduleReview({ name, tenant: tenantId, reason: 'retargeted', by: scheduleActor(ctx).agentId })
    }
    result.state = 'retargeted'
    result.agent = plan.agent
    result.retargeted.push({ name, from: current, to: plan.agent })
    return result
  }

  result.state = 'needs_agent'
  result.reason = plan.reason
  if (row.status !== 'draft' || row.enabled !== 0) {
    await writeScheduledTask(name, { status: 'draft', enabled: false })
    await auditScheduleWrite(ctx, 'retarget', name, tenantId, { from: current, to: null, parked: true, reason: plan.reason, starter_pack: true })
  }
  return result
}

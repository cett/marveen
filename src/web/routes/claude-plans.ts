// Named Claude subscription registry -- dashboard-facing CRUD (PR2b), plus
// the rotation trigger (PR2c). See
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md sections 6
// and 7.
//
// GET was the whole surface in PR1 (moved here unchanged from agents-models.ts
// on this fork). PR2b added POST/PUT/DELETE on store/claude-plans.json plus a
// read-only GET .../state. PR2c adds the write side of the state side-car
// (POST .../rotate) -- the one code path both a (not-yet-built) manual
// dashboard button and the automatic heartbeat decision (design 6.3, wired in
// scripts/claude-plan-rotate-check.ts) call.
//
// Every plan write runs the body through validatePlan() -- the exact function
// resolveClaudePlans() uses to parse the file back -- so nothing invalid can
// reach disk through this route that the read side would then silently drop.
import { homedir } from 'node:os'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { readClaudePlans, writeClaudePlans, validatePlan } from '../claude-plans.js'
import { readClaudePlansState, recordRotationEntry } from '../claude-plans-state.js'
import { performRotation } from '../plan-rotation-apply.js'
import { getPlanRotationLive } from '../plan-rotation-monitor.js'
import type { RouteContext } from './types.js'

export async function tryHandleClaudePlans(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Resolved + validated registry. Feeds the per-agent plan dropdown; empty
  // array when no registry file exists (opt-in feature).
  if (path === '/api/claude-plans' && method === 'GET') {
    json(res, readClaudePlans())
    return true
  }

  // Create a new plan.
  if (path === '/api/claude-plans' && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
      return true
    }

    const plan = validatePlan(body, homedir())
    if (!plan) {
      json(res, {
        error: 'invalid_value',
        hint: 'id (letters/digits/_.- only), label, configDir (safe absolute or ~-prefixed path, no traversal/spaces), planType (personal|team) and channelsAllowed (boolean) are all required',
      }, 400)
      return true
    }

    const current = readClaudePlans()
    if (current.some((p) => p.id === plan.id)) {
      json(res, { error: 'conflict', hint: `Plan id already exists: ${plan.id}` }, 409)
      return true
    }

    writeClaudePlans([...current, plan])
    logger.info({ id: plan.id }, 'Claude plan created')
    json(res, plan, 201)
    return true
  }

  // Rotation telemetry side-car (store/claude-plans-state.json). An honest
  // empty state ({activePlanByAgent:{}, plans:{}}) when nothing has rotated
  // yet, rather than 404ing, so the dashboard cards can render "no rotation
  // data yet" instead of treating the endpoint itself as missing. Checked
  // before the :id matcher below so a plan literally named "state" can never
  // shadow this route.
  //
  // `monitor.live` is the backend monitor's own view (applied mode + stored + reason, the last measurement and
  // tick, counters, the S4 class and position). It is a whitelist built in plan-rotation-monitor.ts live(); the
  // side-car fields next to it (rotationLog, breaker, resetAt, health) are the existing ones. Fleet
  // infrastructure, not tenant data: the route is listed in rbac.ts as admin only.
  if (path === '/api/claude-plans/state' && method === 'GET') {
    const state = readClaudePlansState()
    json(res, { ...state, monitor: { ...state.monitor, live: await getPlanRotationLive() } })
    return true
  }

  // Trigger a rotation for one agent (PR2c, design 6.5/5). Body:
  // { agentId?: string, targetPlanId: string }. agentId defaults to the main
  // channels agent -- the only caller today is the heartbeat script, and a
  // manual dashboard button (not yet built) would default the same way.
  //
  // This is ALSO how an agent's very first plan assignment happens: there is
  // no separate "bootstrap" endpoint. applyRotation() just adds an entry when
  // none existed (design 6.5/4's open bootstrap question -- resolved this
  // way because a first assignment and a later rotation are the same
  // operation: "agentId is now on targetPlanId").
  if (path === '/api/claude-plans/rotate' && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
      return true
    }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim() : MAIN_AGENT_ID
    const targetPlanId = typeof b.targetPlanId === 'string' ? b.targetPlanId.trim() : ''
    if (!targetPlanId) {
      json(res, { error: 'required', hint: 'targetPlanId is required' }, 400)
      return true
    }

    // Every gate, the state write, the restart and the mirror write live in
    // performRotation (plan-rotation-apply.ts), shared with the backend
    // rotation monitor. This route only parses and maps the result.
    const fromPlanId = readClaudePlansState().activePlanByAgent[agentId] ?? null
    const result = await performRotation({ agentId, targetPlanId })
    if (!result.ok) {
      json(res, { error: result.error, hint: result.hint }, result.status)
      return true
    }
    // A person's rotation goes in the same log the monitor's cooldown reads, tagged manual: it starts the
    // cooldown (the fleet did move) but does not count toward the breaker or the restart give-up. The
    // rotation already happened, so a log write failure must not turn the answer into an error.
    try {
      recordRotationEntry({
        ts: Date.now(),
        agentId: result.agentId,
        from: fromPlanId,
        to: result.activePlanId,
        trigger: 'manual',
        mode: 'act',
        result: 'rotated',
        source: 'manual',
      })
    } catch (err) {
      logger.warn({ err, agentId: result.agentId }, 'Could not log the manual plan rotation')
    }
    json(res, { ok: true, agentId: result.agentId, activePlanId: result.activePlanId })
    return true
  }

  const idMatch = path.match(/^\/api\/claude-plans\/([^/]+)$/)

  // Replace an existing plan's fields. The id in the URL is authoritative --
  // a differing id in the body is discarded, so this can never rename a plan
  // into colliding with a different existing entry.
  if (idMatch && method === 'PUT') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
      return true
    }

    const current = readClaudePlans()
    const idx = current.findIndex((p) => p.id === idMatch[1])
    if (idx === -1) {
      json(res, { error: 'not_found', hint: 'Plan not found' }, 404)
      return true
    }

    const candidate = { ...(body && typeof body === 'object' ? body : {}), id: idMatch[1] }
    const plan = validatePlan(candidate, homedir())
    if (!plan) {
      json(res, {
        error: 'invalid_value',
        hint: 'label, configDir (safe absolute or ~-prefixed path, no traversal/spaces), planType (personal|team) and channelsAllowed (boolean) are all required',
      }, 400)
      return true
    }

    const next = [...current]
    next[idx] = plan
    writeClaudePlans(next)
    logger.info({ id: plan.id }, 'Claude plan updated')
    json(res, plan)
    return true
  }

  // Remove a plan. An agent still pointing a claudePlan field at this id
  // simply starts reporting planUnresolved afterwards (resolveAgentConfigDir
  // already handles that) -- deleting here does not touch any agent config.
  if (idMatch && method === 'DELETE') {
    const current = readClaudePlans()
    const next = current.filter((p) => p.id !== idMatch[1])
    if (next.length === current.length) {
      json(res, { error: 'not_found', hint: 'Plan not found' }, 404)
      return true
    }

    writeClaudePlans(next)
    logger.info({ id: idMatch[1] }, 'Claude plan deleted')
    json(res, { ok: true })
    return true
  }

  return false
}

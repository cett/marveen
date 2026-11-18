// performRotation: the ONE code path that moves an agent onto another Claude
// plan. Lifted out of the POST /api/claude-plans/rotate route unchanged in
// behaviour (same gates, same order, same status codes, same side effects) so
// the backend rotation monitor can call it as a plain function: no HTTP hop,
// no token, no dependence on any agent session being alive.
//
// The route is now a thin wrapper (parse body, call this, map the result to
// JSON); src/__tests__/claude-plans-routes.test.ts pins that the wrapper
// behaves exactly as before.
import { existsSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { readClaudePlans } from './claude-plans.js'
import { readClaudePlansState, writeClaudePlansState, applyRotation } from './claude-plans-state.js'
import { agentDir, writeAgentClaudePlan } from './agent-config.js'
import { restartAgentProcess } from './agent-process.js'
import { hardRestartMarveenChannels } from './channel-monitor.js'
import { activatePlanForAgent } from '../db.js'

export type RotationApplyResult =
  | { ok: true; agentId: string; activePlanId: string }
  | {
      ok: false
      /** HTTP status the route maps this to; the monitor only logs it. */
      status: 400 | 404 | 409 | 500
      error: 'disabled' | 'not_found' | 'invalid_value' | 'managed_settings_missing' | 'internal_error'
      hint: string
    }

// Best-effort DB mirror write: a rotation's real effect is the file write
// (writeClaudePlansState/applyRotation, which the DB-less main-agent boot path
// reads) -- the agent_active_plans row is only for the blackboard badge /
// dashboard / handoff-recovery, so a mirror failure must never fail the
// rotation itself.
async function mirrorActivation(agentId: string, planId: string): Promise<void> {
  try { await activatePlanForAgent(agentId, planId, 'rotation') } catch { /* see comment above */ }
}

export function isRotationEnabled(): boolean {
  try { return String(getEffectiveSettingValue('CLAUDE_ROTATION_ENABLED')) === '1' } catch { return false }
}

export function isMainAgentIsolated(): boolean {
  try { return String(getEffectiveSettingValue('MAIN_AGENT_ISOLATED_CONFIG')) === '1' } catch { return false }
}

/**
 * Move `agentId` onto `targetPlanId` and restart it so the new plan takes
 * effect. Never throws for an expected refusal: the reason is in the result.
 */
export async function performRotation(input: {
  agentId: string
  targetPlanId: string
}): Promise<RotationApplyResult> {
  const { agentId, targetPlanId } = input

  if (!isRotationEnabled()) {
    return { ok: false, status: 409, error: 'disabled', hint: 'Rotation is disabled (CLAUDE_ROTATION_ENABLED=0)' }
  }

  const plans = readClaudePlans()
  const target = plans.find((p) => p.id === targetPlanId)
  if (!target) {
    return { ok: false, status: 400, error: 'not_found', hint: `Unknown target plan id: ${targetPlanId}` }
  }
  // Guardrail from design decision #5: a plan not marked channelsAllowed is
  // not a rotation candidate, whatever the caller asks for.
  if (!target.channelsAllowed) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_value',
      hint: `Plan ${targetPlanId} does not allow channels use (channelsAllowed=false)`,
    }
  }

  if (agentId === MAIN_AGENT_ID) {
    // Design 6.2: rotation is only meaningful on the isolated-config path, and
    // only once 2+ plans exist -- otherwise there is nothing to resolve a
    // "rotated" configDir against (agent-process.js:
    // resolveMainAgentRotatedConfigDir has the same gate, so a stale state
    // entry can never silently take effect if the operator turns isolation
    // back off or drops to one plan).
    if (!isMainAgentIsolated() || plans.length < 2) {
      return {
        ok: false,
        status: 409,
        error: 'managed_settings_missing',
        hint: 'Rotation not applicable: main agent needs MAIN_AGENT_ISOLATED_CONFIG=1 and at least 2 registered plans',
      }
    }

    // Record the decision BEFORE restarting: the next launch resolves its
    // CLAUDE_CONFIG_DIR by reading this file back
    // (main-agent-isolated-config.mjs -> resolveMainAgentRotatedConfigDir), so
    // the state has to be on disk before the process that will read it comes up.
    writeClaudePlansState(applyRotation(readClaudePlansState(), MAIN_AGENT_ID, targetPlanId))
    await mirrorActivation(MAIN_AGENT_ID, targetPlanId)

    const result = hardRestartMarveenChannels()
    if (!result.ok) {
      return { ok: false, status: 500, error: 'internal_error', hint: result.error || 'Main agent restart failed' }
    }
    logger.info({ agentId, targetPlanId }, 'Claude plan rotation: main agent restarted')
    return { ok: true, agentId, activePlanId: targetPlanId }
  }

  // Sub-agent path: point its claudePlan field at the target and restart it
  // through the same primitive the dashboard's own restart button uses -- no
  // separate sub-agent rotation mechanism to keep in sync.
  if (!existsSync(agentDir(agentId))) {
    return { ok: false, status: 404, error: 'not_found', hint: `Agent not found: ${agentId}` }
  }
  writeClaudePlansState(applyRotation(readClaudePlansState(), agentId, targetPlanId))
  writeAgentClaudePlan(agentId, targetPlanId)
  // restartAgentProcess stops the agent first (which drops any
  // agent_active_plans row via deactivatePlanForAgent, see
  // agent-process-spawn.ts) -- so the mirror activation MUST happen after the
  // restart succeeds, not before, or it would be wiped immediately.
  const result = await restartAgentProcess(agentId)
  if (!result.ok) {
    return { ok: false, status: 500, error: 'internal_error', hint: result.error || `Restart failed for agent ${agentId}` }
  }
  await mirrorActivation(agentId, targetPlanId)
  logger.info({ agentId, targetPlanId }, 'Claude plan rotation: agent restarted')
  return { ok: true, agentId, activePlanId: targetPlanId }
}

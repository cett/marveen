import { getActiveBlackboardAgentIds, getAgentTier, markBlackboardStale, sweepStaleActivePlans } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'

// Sweep runs every 5 minutes. Most thresholds are 60+ minutes so this gives
// at least 12 checks before the first possible mark -- acceptable precision.
const SWEEP_INTERVAL_MS = 5 * 60_000

export const TIER_CONFIG_KEY: Record<string, string> = {
  orchestrator:    'BB_STALE_ORCHESTRATOR_MIN',
  interactive:     'BB_STALE_INTERACTIVE_MIN',
  'short-running': 'BB_STALE_SHORT_RUNNING_MIN',
  default:         'BB_STALE_DEFAULT_MIN',
}

function resolveThresholdSec(agentId: string): number {
  const tier = getAgentTier(agentId)
  const key = TIER_CONFIG_KEY[tier] ?? 'BB_STALE_DEFAULT_MIN'
  return (getEffectiveSettingValue(key) as number) * 60
}

// `getInFlightAgents` names the agents whose scheduled run is still being
// tracked (see getInflightScheduleAgents in schedule-runner.ts); their active
// row is the runner's to close, so it is not marked stale while the run lasts.
// A provider that throws must not stop the sweep: stale marking then runs as before.
export function startBlackboardStaleSweeper(
  getInFlightAgents: () => ReadonlySet<string> = () => new Set(),
): NodeJS.Timeout {
  const sweep = async () => {
    try {
      const activeIds = getActiveBlackboardAgentIds()
      const thresholdsByAgent: Record<string, number> = {}
      for (const id of activeIds) {
        thresholdsByAgent[id] = resolveThresholdSec(id)
      }
      const defaultSec = resolveThresholdSec('__nonexistent__')
      const assignedSec = (getEffectiveSettingValue('BB_STALE_ASSIGNED_MIN') as number) * 60
      let inFlight: ReadonlySet<string> = new Set()
      try {
        inFlight = getInFlightAgents()
      } catch (err) {
        logger.warn({ err }, 'blackboard-stale-sweeper: in-flight lookup failed, sweeping without the exemption')
      }
      const marked = await markBlackboardStale(thresholdsByAgent, defaultSec, assignedSec, undefined, inFlight)
      if (marked > 0) {
        logger.info({ marked }, 'blackboard-stale-sweeper: marked stale rows')
      }
      // #886 plan-sweeper, runs alongside the BB sweep (design section 4):
      // drop agent_active_plans bindings whose last_heartbeat has gone
      // quiet for longer than PLAN_STALE_MIN, independent of blackboard
      // per-tier thresholds above.
      const planStaleMin = getEffectiveSettingValue('PLAN_STALE_MIN') as number
      const plansSwept = await sweepStaleActivePlans(planStaleMin)
      if (plansSwept > 0) {
        logger.info({ plansSwept }, 'blackboard-stale-sweeper: swept stale active-plan bindings')
      }
    } catch (err) {
      logger.error({ err }, 'blackboard-stale-sweeper: sweep failed')
    }
  }
  // sweep wraps its whole body in try/catch, so the timer only starts it.
  return setInterval(() => { void sweep() }, SWEEP_INTERVAL_MS)
}

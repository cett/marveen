import { sweepExpiredWorkspaceDocs } from '../workspace-store.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'

// sweepExpiredWorkspaceDocs() (workspace-store.ts) existed with no caller --
// the table only grew. Sweep on the same cadence as the blackboard-stale
// sweeper; the TTL itself is minutes-to-days scale, so 5-minute granularity
// is more than enough precision.
const SWEEP_INTERVAL_MS = 5 * 60_000

export function startWorkspaceDocsTtlSweeper(): NodeJS.Timeout {
  const sweep = () => {
    try {
      const ttlDays = getEffectiveSettingValue('WORKSPACE_DOCS_TTL_DAYS') as number
      const deleted = sweepExpiredWorkspaceDocs(ttlDays)
      if (deleted > 0) {
        logger.info({ deleted, ttlDays }, 'workspace-docs-ttl-sweeper: deleted expired docs')
      }
    } catch (err) {
      logger.error({ err }, 'workspace-docs-ttl-sweeper: sweep failed')
    }
  }
  return setInterval(sweep, SWEEP_INTERVAL_MS)
}

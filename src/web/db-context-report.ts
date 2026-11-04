// An hourly line about the db context counter (db/context.ts), so the Phase 1 measurement window can be read from the log
// without asking the endpoint. A line with an unexpected call or a tenant mismatch since the last report is a warning with the
// top call sites; otherwise it is one quiet summary line.

import { getDbContextStats } from '../db/context.js'
import { logger } from '../logger.js'

export const DB_CONTEXT_REPORT_INTERVAL_MS = 60 * 60 * 1000
const REPORT_SITES = 5

export function startDbContextReport(): NodeJS.Timeout {
  let lastUnexpected = getDbContextStats().unexpected
  let lastMismatches = getDbContextStats().tenantMismatches
  const timer = setInterval(() => {
    const s = getDbContextStats()
    const newUnexpected = s.unexpected - lastUnexpected
    const newMismatches = s.tenantMismatches - lastMismatches
    lastUnexpected = s.unexpected
    lastMismatches = s.tenantMismatches
    const meta = { total: s.total, unexpected: s.unexpected, newUnexpected, anonymous: s.anonymous, tenantMismatches: s.tenantMismatches, newMismatches }
    if (newUnexpected > 0 || newMismatches > 0) {
      logger.warn({ ...meta, sites: s.sites.filter((x) => !x.boot).slice(0, REPORT_SITES) }, 'db context: calls without a context or in another tenant since the last report')
    } else {
      logger.info(meta, 'db context: no unexpected call since the last report')
    }
  }, DB_CONTEXT_REPORT_INTERVAL_MS)
  timer.unref()
  return timer
}

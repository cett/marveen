import { json } from '../http-helpers.js'
import { getClaudeUpdateStatus } from '../claude-update.js'
import type { RouteContext } from './types.js'

// Read-only view of the central Claude Code update (scripts/claude-update.sh and
// the idle-only restart that follows it). Starting an update needs no endpoint:
// the seeded `claude-update` schedule has run-now, and the setting is a
// registry-backed one.
export async function tryHandleClaudeUpdate(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path === '/api/claude-update/status' && method === 'GET') {
    json(res, getClaudeUpdateStatus())
    return true
  }
  return false
}

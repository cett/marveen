import { isKnownAgent } from '../agent-config.js'
import { json } from '../http-helpers.js'
import { callerCanSeeAgent, isAdminCaller } from './agent-tenant-scope.js'
import type { RouteContext } from './types.js'

// Front door for every read of /api/agents/<name>[/...]. Registered first in
// the dispatcher so a new sub-resource route cannot ship without tenant scoping:
// before this, only GET /api/agents and GET /api/agents/:name filtered by
// tenant, while /team, /conversation, /pane/stream, /status, /security,
// /skills, /channel-requests ... answered for ANY agent to any role.
//
// A non-admin caller asking for an agent their tenant has not been given gets
// the same 404 the unknown-agent case returns, so "not mine" and "does not
// exist" are indistinguishable.
//
// Deliberately NOT covered here:
//  - /context-guard and /auto-restart: agents-process.ts has its own
//    own-tenant check (agentBelongsToTenant, which also admits a tenant's
//    designated main agent) and answers 403.
//  - non-GET methods: writes are decided by the RBAC permission table
//    (admin:all unless a row says otherwise).
//  - callers without a resolved role (ungated public paths such as avatars).

const AGENT_PATH = /^\/api\/agents\/([^/]+)(\/[^?]*)?$/
const OWN_CHECK_SUFFIX = /^\/(context-guard|auto-restart)$/

export async function tryGuardAgentTenantReads(ctx: RouteContext): Promise<boolean> {
  if (ctx.method !== 'GET' || ctx.role === undefined || isAdminCaller(ctx)) return false
  const m = AGENT_PATH.exec(ctx.path)
  if (!m) return false
  if (m[2] && OWN_CHECK_SUFFIX.test(m[2])) return false
  let name: string
  try { name = decodeURIComponent(m[1]) } catch { return false }
  // Unknown names (including the static routes /activity, /export-all, ...)
  // fall through to their own handlers / 404.
  if (!isKnownAgent(name)) return false
  if (callerCanSeeAgent(ctx, name)) return false
  json(ctx.res, { error: 'not_found', field: 'name' }, 404)
  return true
}

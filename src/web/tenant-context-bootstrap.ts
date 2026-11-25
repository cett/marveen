// The two hook routes a shared agent may call WITHOUT a fresh tenant context.
//
// A fleet_agent token of a shared agent (enabled for two or more tenants) with no fresh agent_tenant_context is refused 403 on
// every route (web.ts and checkPermission: no tenant can be named, none is guessed). In PostgreSQL mode the tenant hooks
// (scripts/hooks/tenant-context.py) are the ones that CREATE that context, through these two routes, so refusing them leaves the
// agent unable to ever record its first (or a stale) context: every prompt of the hook is then refused (exit 2).
//
//   POST /api/hooks/tenant-facts    the facts of the sources of the prompt: only the caller's OWN rows (the agent is the token's,
//                                   a message only when it is addressed to the caller, binding and schedule only the caller's)
//   PUT  /api/hooks/tenant-context  the caller's own context row; the server still refuses (403) a tenant the agent does not serve
//
// Deliberately NOT here: POST /api/hooks/skill-gate (without a context its 403 is the correct fail-closed answer: the gate then
// denies the tenant-skill call), GET anything, every other route. One predicate, EXACT method and path, used by BOTH places that
// refuse a missing context (web.ts and checkPermission), so the two cannot drift.
//
// `path` is the NORMALISED path: the /api/v1/... alias is already /api/..., and a query string is not part of it (the same input
// requiresAuth and resolveRequiredPermission get). It is an exact comparison, never a prefix: a trailing slash or a longer path
// is not the route (the route table does not know it either), so it stays refused.
export function isTenantContextBootstrapRoute(method: string, path: string): boolean {
  return (method === 'POST' && path === '/api/hooks/tenant-facts')
    || (method === 'PUT' && path === '/api/hooks/tenant-context')
}

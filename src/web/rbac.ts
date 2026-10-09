// RBAC model: roles, permissions, and endpoint-to-permission mapping.
//
// This module is the single source of truth for access-control decisions.
// The authorization middleware resolves a role from the auth result
// and then calls hasPermission() to check if the request is allowed.
//
// Design constraints:
// - Fail-closed: unknown permission or role -> deny.
// - Admin role is the only cross-tenant role; all others are tenant-scoped.
// - The current store/.dashboard-token bearer maps to the 'admin' role via
//   the backward-compat fallback in auth-gate.ts (no code change needed there
//   until the api_tokens table is populated (token-management step).

// ── Roles ──────────────────────────────────────────────────────────────────

// The roles a dashboard user (a person) can hold. 'agent' here is the B2B tenant user, not a fleet agent.
export type UserRole = 'admin' | 'agent' | 'read_only' | 'viewer'

// 'fleet_agent' is the role of a fleet agent's own API token (api_tokens.agent_id names the agent). It
// is a machine principal, never a dashboard user's role: dashboard_users.role and the Users tab keep
// the four UserRoles, and the dashboard's permission matrix mirrors only those.
export const FLEET_AGENT_ROLE = 'fleet_agent' as const

export type Role = UserRole | typeof FLEET_AGENT_ROLE

// The dashboard-user roles (what the Users tab and its mirror files list). Not the fleet_agent role.
export const ALL_ROLES: readonly UserRole[] = ['admin', 'agent', 'read_only', 'viewer']

// ── Permissions ────────────────────────────────────────────────────────────

// Each permission maps to one or more HTTP operations on a resource group.
// Naming: <resource>:<action>  -- kebab-case resource, colon separator.
// The tuple is the single list of permissions; the type is derived from it, so a test (and the
// dashboard mirror's drift guard) can walk every permission at runtime instead of keeping a
// second hand-written list that falls behind.
export const ALL_PERMISSIONS = [
  'memories:read',
  'memories:write',
  'kanban:read',
  'kanban:write',
  'agents:read',
  'agents:write',
  'messages:write',
  'approvals:read',
  'approvals:write',
  'blackboard:read',
  'blackboard:write',
  'schedules:read',
  'schedules:write',
  'admin:all',
  'federation:read',
  'federation:write',
] as const

// Permissions that exist for the fleet's own plumbing: the endpoints agents and their hooks call on
// themselves. Only the admin role and the fleet_agent role hold them; no tenant user (agent,
// read_only, viewer) ever did, because every one of these endpoints was admin:all before. They are a
// separate tuple so the dashboard's Users-tab matrix (a view of the roles a person can hold) does not
// have to list machine permissions; fleet-agent-rbac.test.ts is the drift guard for this tuple.
export const FLEET_AGENT_PERMISSIONS = [
  'ledger:read',
  'ledger:write',
  'agent-state:read',
  'agent-state:write',
  'daily-log:read',
  'daily-log:write',
  'telemetry:write',
  'artifacts:read',
  'artifacts:write',
  'skills:read',
  'skills:write',
  'fleet-config:read',
] as const

export type Permission = typeof ALL_PERMISSIONS[number] | typeof FLEET_AGENT_PERMISSIONS[number]

// ── Permission sets per role ────────────────────────────────────────────────

// Only the admin role carries admin:all; all others are strictly scoped.
// read_only and viewer are intentionally narrow -- no write permissions.
// viewer includes blackboard:read so B2B users can see the fleet health bar.
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set<Permission>([
    'memories:read',
    'memories:write',
    'kanban:read',
    'kanban:write',
    'agents:read',
    'agents:write',
    'messages:write',
    'approvals:read',
    'approvals:write',
    'blackboard:read',
    'blackboard:write',
    'schedules:read',
    'schedules:write',
    'admin:all',
    'federation:read',
    'federation:write',
    ...FLEET_AGENT_PERMISSIONS,
  ]),
  // A fleet agent's own token. The grant follows the T0 matrix: what an agent needs to run itself.
  // "Own" scoping (the agent id comes from the token, a foreign one is a 403) is enforced per
  // endpoint in the routes (fleet-agent-identity.ts); this set only decides which endpoints are
  // reachable at all. Deliberately absent: admin:all (agent lifecycle, vault, tokens, rbac, intel),
  // agents:write, federation:*. approvals:write reaches POST /api/approvals (a request); the route
  // itself refuses a fleet_agent the resolving PATCH.
  fleet_agent: new Set<Permission>([
    'memories:read',
    'memories:write',
    'kanban:read',
    'kanban:write',
    'agents:read',
    'messages:write',
    'approvals:read',
    'approvals:write',
    'blackboard:read',
    'blackboard:write',
    'schedules:read',
    'schedules:write',
    ...FLEET_AGENT_PERMISSIONS,
  ]),
  agent: new Set<Permission>([
    'memories:read',
    'memories:write',
    'kanban:read',
    'kanban:write',
    'agents:read',
    // agents:write is intentionally narrower than the other *:write
    // permissions here look -- it only unlocks the two ENDPOINT_PERMISSION_REGEX_TABLE
    // rows below (per-agent context-guard/auto-restart settings, #985 group 3),
    // and the route itself still enforces own-tenant-vs-cross-tenant (403) for
    // a non-admin caller. It does NOT cover /start, /stop, /restart, /remote --
    // those have no table entry at all and stay admin:all-only via the
    // resolveRequiredPermission fallback.
    'agents:write',
    'messages:write',
    'approvals:read',
    'blackboard:read',
    'blackboard:write',
    // schedules:write is granted to every tenant user (the 'agent' role), automatically: there is
    // no per-tenant switch. What makes that safe is the review gate (an edit of a live task by a
    // non-admin sends it back to pending_review, only a signed-in admin activates) and the route
    // guards in routes/schedules.ts (own non-default tenant only, no device key, draft cap).
    'schedules:read',
    'schedules:write',
    'federation:read',
    'federation:write',
  ]),
  read_only: new Set<Permission>([
    'memories:read',
    'kanban:read',
    'agents:read',
    'blackboard:read',
    'schedules:read',
    'approvals:read',
    'approvals:write',
  ]),
  viewer: new Set<Permission>([
    'memories:read',
    'kanban:read',
    'agents:read',
    'blackboard:read',
    'schedules:read',
    'approvals:read',
    'approvals:write',
  ]),
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false
}

// ── Endpoint-to-permission lookup ──────────────────────────────────────────
//
// Each entry maps a (method pattern, path pattern) pair to the Permission
// required to execute it. The middleware iterates entries in order and uses
// the first match. Patterns use simple prefix matching or exact matching.
//
// Conventions:
// - method: HTTP verb or '*' for any verb.
// - pathPattern: string prefix (must start with '/'); trailing '*' means prefix match.
// - If no entry matches, the middleware falls back to 'admin:all' (deny non-admin).

export interface EndpointPermissionEntry {
  method: '*' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  pathPattern: string
  /** Whether pathPattern is a prefix (true) or exact match (false). */
  prefix: boolean
  permission: Permission
}

export const ENDPOINT_PERMISSION_TABLE: readonly EndpointPermissionEntry[] = [
  // Admin namespace -- must be checked before generic /api/* entries.
  { method: '*', pathPattern: '/api/admin/', prefix: true, permission: 'admin:all' },
  { method: '*', pathPattern: '/api/v1/admin/', prefix: true, permission: 'admin:all' },
  // Boot-time reads of every dashboard session: brand/agent name and the UI language. Every role may
  // read; the route returns the full response to the admin and an allowlist to anyone else
  // (src/web/non-admin-views.ts). memories:read is the permission every role has and the overview
  // already uses for fleet-filtered data. Writes (PUT /api/marveen, POST /api/settings) stay unmapped,
  // so admin:all.
  { method: 'GET', pathPattern: '/api/marveen', prefix: false, permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/settings', prefix: false, permission: 'memories:read' },
  // RBAC observability (shadow-log). Listed explicitly even though the unmapped-path
  // fallback is also admin:all, so a later broad /api/* entry cannot widen it by accident.
  { method: '*', pathPattern: '/api/rbac/', prefix: true, permission: 'admin:all' },

  // Federation wire endpoints.
  { method: 'GET', pathPattern: '/api/federation/', prefix: true, permission: 'federation:read' },
  { method: 'POST', pathPattern: '/api/federation/', prefix: true, permission: 'federation:write' },
  { method: 'GET', pathPattern: '/api/v1/federation/', prefix: true, permission: 'federation:read' },
  { method: 'POST', pathPattern: '/api/v1/federation/', prefix: true, permission: 'federation:write' },

  // Approvals -- tenant users can read and resolve their own tenant's requests (IDOR-guarded in route).
  { method: 'GET', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:read' },
  { method: 'POST', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PATCH', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PUT', pathPattern: '/api/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'GET', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:read' },
  { method: 'POST', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PATCH', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:write' },
  { method: 'PUT', pathPattern: '/api/v1/approvals', prefix: true, permission: 'approvals:write' },

  // Blackboard.
  { method: 'GET', pathPattern: '/api/blackboard', prefix: true, permission: 'blackboard:read' },
  { method: 'POST', pathPattern: '/api/blackboard', prefix: true, permission: 'blackboard:write' },
  { method: 'GET', pathPattern: '/api/v1/blackboard', prefix: true, permission: 'blackboard:read' },
  { method: 'POST', pathPattern: '/api/v1/blackboard', prefix: true, permission: 'blackboard:write' },

  // Schedules. Paths reach this table already normalised (/api/v1 -> /api, see versioning.ts), so
  // there are no /api/v1 rows. Order matters inside the group: tick-status is admin-only and must
  // be matched before the GET prefix below, and activate (regex table, first match) before the POST
  // prefix, which would otherwise cover it. Create, toggle, run, expand-* are POSTs, a delete of a
  // task or of a pending retry is a DELETE: all schedules:write.
  { method: 'GET', pathPattern: '/api/schedules/tick-status', prefix: false, permission: 'admin:all' },
  { method: 'GET', pathPattern: '/api/schedules', prefix: true, permission: 'schedules:read' },
  { method: 'POST', pathPattern: '/api/schedules', prefix: true, permission: 'schedules:write' },
  { method: 'PUT', pathPattern: '/api/schedules', prefix: true, permission: 'schedules:write' },
  { method: 'DELETE', pathPattern: '/api/schedules', prefix: true, permission: 'schedules:write' },

  // Fleet-agent plumbing: the endpoints an agent and its hooks call on themselves. Every one was
  // admin:all (unmapped) before, and the permissions are held by admin and fleet_agent only, so no
  // tenant user gains anything. Paths arrive normalised (/api/v1 -> /api). Read-side listings that
  // reveal other agents' work (GET /api/hook-audit, /api/traces, /api/tool-log, /api/skill-usage*)
  // stay unmapped on purpose: admin only. The ledger, state and taskstate routes check that the agent
  // id in the path or body is the caller's own (fleet-agent-identity.ts).
  { method: 'GET', pathPattern: '/api/conversation-ledger', prefix: true, permission: 'ledger:read' },
  { method: 'POST', pathPattern: '/api/conversation-ledger', prefix: true, permission: 'ledger:write' },
  { method: 'GET', pathPattern: '/api/agent-state', prefix: true, permission: 'agent-state:read' },
  { method: 'PUT', pathPattern: '/api/agent-state', prefix: true, permission: 'agent-state:write' },
  { method: 'GET', pathPattern: '/api/agent-taskstate', prefix: true, permission: 'agent-state:read' },
  { method: 'POST', pathPattern: '/api/agent-taskstate', prefix: true, permission: 'agent-state:write' },
  { method: 'DELETE', pathPattern: '/api/agent-taskstate', prefix: true, permission: 'agent-state:write' },
  { method: 'GET', pathPattern: '/api/daily-log', prefix: true, permission: 'daily-log:read' },
  { method: 'POST', pathPattern: '/api/daily-log', prefix: false, permission: 'daily-log:write' },
  { method: 'POST', pathPattern: '/api/hook-audit', prefix: false, permission: 'telemetry:write' },
  { method: 'POST', pathPattern: '/api/spans', prefix: false, permission: 'telemetry:write' },
  { method: 'POST', pathPattern: '/api/skill-usage', prefix: false, permission: 'telemetry:write' },
  { method: 'POST', pathPattern: '/api/tool-log', prefix: false, permission: 'telemetry:write' },
  { method: 'GET', pathPattern: '/api/artifacts', prefix: true, permission: 'artifacts:read' },
  { method: 'POST', pathPattern: '/api/artifacts', prefix: false, permission: 'artifacts:write' },
  { method: 'GET', pathPattern: '/api/skills/sql', prefix: true, permission: 'skills:read' },
  { method: 'POST', pathPattern: '/api/skills/sql', prefix: true, permission: 'skills:write' },
  { method: 'PUT', pathPattern: '/api/skills/sql', prefix: true, permission: 'skills:write' },
  { method: 'DELETE', pathPattern: '/api/skills/sql', prefix: true, permission: 'skills:write' },
  { method: 'GET', pathPattern: '/api/egress-allowlist', prefix: false, permission: 'fleet-config:read' },
  { method: 'GET', pathPattern: '/api/autonomy', prefix: false, permission: 'fleet-config:read' },
  { method: 'GET', pathPattern: '/api/voice/directive', prefix: false, permission: 'fleet-config:read' },

  // Messages.
  { method: 'POST', pathPattern: '/api/messages', prefix: true, permission: 'messages:write' },
  { method: 'POST', pathPattern: '/api/v1/messages', prefix: true, permission: 'messages:write' },

  // Agents -- read-only for broad roles.
  { method: 'GET', pathPattern: '/api/agents', prefix: true, permission: 'agents:read' },
  { method: 'GET', pathPattern: '/api/v1/agents', prefix: true, permission: 'agents:read' },
  // The org chart behind the Agents page's tree view. The route filters to the
  // caller's tenant (agent-tenant-scope.ts) exactly as GET /api/agents does, so it
  // is readable by every role that can read the agent list. prefix:false: the PUT
  // that rewires reporting lines lives under /api/agents/:name/team, not here.
  { method: 'GET', pathPattern: '/api/team/graph', prefix: false, permission: 'agents:read' },
  { method: 'GET', pathPattern: '/api/v1/team/graph', prefix: false, permission: 'agents:read' },

  // Kanban.
  { method: 'GET', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:read' },
  { method: 'POST', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'PATCH', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'DELETE', pathPattern: '/api/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'GET', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:read' },
  { method: 'POST', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'PATCH', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:write' },
  { method: 'DELETE', pathPattern: '/api/v1/kanban', prefix: true, permission: 'kanban:write' },

  // Memories.
  { method: 'GET', pathPattern: '/api/memories', prefix: true, permission: 'memories:read' },
  { method: 'POST', pathPattern: '/api/memories', prefix: true, permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/memories', prefix: true, permission: 'memories:write' },
  { method: 'GET', pathPattern: '/api/v1/memories', prefix: true, permission: 'memories:read' },
  { method: 'POST', pathPattern: '/api/v1/memories', prefix: true, permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/v1/memories', prefix: true, permission: 'memories:write' },

  // Recall, overview and me -- non-admin readable (memories:read is the narrowest fitting permission).
  // /api/overview response is further filtered in the route handler: fleet-level fields are omitted
  // for non-admin callers -- a tenant user must not learn the fleet's internal structure.
  { method: 'GET', pathPattern: '/api/recall',      prefix: true,  permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/v1/recall',   prefix: true,  permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/overview',    prefix: false, permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/v1/overview', prefix: false, permission: 'memories:read' },
  // prefix:false because /api/me has no sub-paths yet; avoids matching /api/messages.
  // Add explicit rows when 625 introduces sub-paths.
  { method: 'GET', pathPattern: '/api/me',          prefix: false, permission: 'memories:read' },
  { method: 'GET', pathPattern: '/api/v1/me',       prefix: false, permission: 'memories:read' },
  // Profile self-edit (PATCH) -- handler (me.ts) requires session auth itself;
  // memories:read is the narrowest non-admin permission, matching the GET rows above.
  { method: 'PATCH', pathPattern: '/api/me',              prefix: false, permission: 'memories:read' },
  { method: 'PATCH', pathPattern: '/api/v1/me',           prefix: false, permission: 'memories:read' },
  // Auth self-service (session-callers only; auth.ts handlers enforce session kind themselves,
  // this table only gates the shadow/enforce RBAC layer).
  { method: 'POST',  pathPattern: '/api/auth/password',   prefix: false, permission: 'memories:read' },
  { method: 'POST',  pathPattern: '/api/auth/logout-all', prefix: false, permission: 'memories:read' },
  { method: 'GET',   pathPattern: '/api/auth/sessions',   prefix: false, permission: 'memories:read' },

  // User-guide docs viewer (read-only markdown) -- B2B tenant users read the
  // guide from the dashboard without repo access; memories:read is the
  // narrowest non-admin permission, same tier as the reads above.
  { method: 'GET',   pathPattern: '/api/docs',            prefix: true,  permission: 'memories:read' },
  { method: 'GET',   pathPattern: '/api/v1/docs',         prefix: true,  permission: 'memories:read' },

  // Workspace docs -- fleet-agent produced working documents.
  { method: 'GET',    pathPattern: '/api/workspace',    prefix: true,  permission: 'memories:read' },
  { method: 'POST',   pathPattern: '/api/workspace',    prefix: false, permission: 'memories:write' },
  { method: 'PATCH',  pathPattern: '/api/workspace',    prefix: true,  permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/workspace',    prefix: true,  permission: 'memories:write' },
  { method: 'GET',    pathPattern: '/api/v1/workspace', prefix: true,  permission: 'memories:read' },
  { method: 'POST',   pathPattern: '/api/v1/workspace', prefix: false, permission: 'memories:write' },
  { method: 'PATCH',  pathPattern: '/api/v1/workspace', prefix: true,  permission: 'memories:write' },
  { method: 'DELETE', pathPattern: '/api/v1/workspace', prefix: true,  permission: 'memories:write' },
]

// ── Regex-matched entries (variable path segment) ───────────────────────────
//
// ENDPOINT_PERMISSION_TABLE above only supports prefix/exact matching, which
// can't isolate a path with a variable segment in the MIDDLE (e.g. an agent
// name) from its siblings -- a prefix of '/api/agents/' would also loosen
// /start, /stop, /restart, /remote, which must stay admin:all-only. This
// table is checked first, before the prefix table, for the few endpoints
// that need it.
interface RegexPermissionEntry {
  method: '*' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  regex: RegExp
  permission: Permission
}

const ENDPOINT_PERMISSION_REGEX_TABLE: readonly RegexPermissionEntry[] = [
  // Agent bundles (a whole agent's CLAUDE.md/SOUL.md/MCP config and, with
  // ?secrets=1, its vault secrets). They sit under the GET /api/agents prefix row
  // below, which would make them agents:read for every role; this row, checked
  // first, keeps them admin-only (the routes also refuse a non-admin themselves).
  { method: 'GET', regex: /^\/api\/(v1\/)?agents\/(export-all|[^/]+\/export)$/, permission: 'admin:all' },
  // Per-agent context-guard / auto-restart settings (agent_settings,
  // migration 0058, #985 group 3/8). Unlike egress_allowlist (group 1,
  // admin-only writes -- a hook OUTSIDE this process unions every tenant's
  // rows into one fleet-wide policy), these settings are read and enforced
  // entirely inside this backend process, per agent_id, with no external
  // unioning consumer -- so a tenant-scoped write here does not expand any
  // OTHER tenant's effective policy. This entry only lets a non-admin
  // 'agent' role reach the route; agents-process.ts itself still enforces
  // own-tenant-vs-cross-tenant (403) for both GET and PUT.
  { method: 'PUT', regex: /^\/api\/agents\/[^/]+\/(context-guard|auto-restart)$/, permission: 'agents:write' },
  // Activating a draft / held schedule is the approval step itself: admin only, even though the
  // POST prefix row for /api/schedules is schedules:write. (The route additionally requires a
  // signed-in admin, not just the admin role, because the shared token also carries it.)
  { method: 'POST', regex: /^\/api\/schedules\/[^/]+\/activate$/, permission: 'admin:all' },
  // Which tenants may see a skill is the admin's decision: the access sub-resource stays admin-only
  // even though the skill itself (the skills:read/write rows above) is reachable by a fleet agent.
  { method: '*', regex: /^\/api\/skills\/sql\/[^/]+\/access(\/|$)/, permission: 'admin:all' },
]

/**
 * Resolve the required Permission for a given HTTP method + path.
 * Returns null if no entry matches (caller should treat as admin:all required).
 */
export function resolveRequiredPermission(
  method: string,
  path: string,
): Permission | null {
  for (const entry of ENDPOINT_PERMISSION_REGEX_TABLE) {
    if (entry.method !== '*' && entry.method !== method) continue
    if (entry.regex.test(path)) return entry.permission
  }
  for (const entry of ENDPOINT_PERMISSION_TABLE) {
    if (entry.method !== '*' && entry.method !== method) continue
    const matches = entry.prefix
      ? path.startsWith(entry.pathPattern)
      : path === entry.pathPattern
    if (matches) return entry.permission
  }
  return null
}

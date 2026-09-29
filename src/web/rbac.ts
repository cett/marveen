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

export type Role = 'admin' | 'agent' | 'read_only' | 'viewer'

export const ALL_ROLES: readonly Role[] = ['admin', 'agent', 'read_only', 'viewer']

// ── Permissions ────────────────────────────────────────────────────────────

// Each permission maps to one or more HTTP operations on a resource group.
// Naming: <resource>:<action>  -- kebab-case resource, colon separator.
export type Permission =
  | 'memories:read'
  | 'memories:write'
  | 'kanban:read'
  | 'kanban:write'
  | 'agents:read'
  | 'agents:write'
  | 'messages:write'
  | 'approvals:read'
  | 'approvals:write'
  | 'blackboard:read'
  | 'blackboard:write'
  | 'admin:all'
  | 'federation:read'
  | 'federation:write'

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
    'admin:all',
    'federation:read',
    'federation:write',
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
    'federation:read',
    'federation:write',
  ]),
  read_only: new Set<Permission>([
    'memories:read',
    'kanban:read',
    'agents:read',
    'blackboard:read',
    'approvals:read',
    'approvals:write',
  ]),
  viewer: new Set<Permission>([
    'memories:read',
    'kanban:read',
    'agents:read',
    'blackboard:read',
    'approvals:read',
    'approvals:write',
  ]),
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
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

  // Messages.
  { method: 'POST', pathPattern: '/api/messages', prefix: true, permission: 'messages:write' },
  { method: 'POST', pathPattern: '/api/v1/messages', prefix: true, permission: 'messages:write' },

  // Agents -- read-only for broad roles.
  { method: 'GET', pathPattern: '/api/agents', prefix: true, permission: 'agents:read' },
  { method: 'GET', pathPattern: '/api/v1/agents', prefix: true, permission: 'agents:read' },

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

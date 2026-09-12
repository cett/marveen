// Screen-access matrix data for the dashboard's Users-tab RBAC view ("Feluletek
// elerhetosege" section, second half of the permission matrix). Mirrors the
// backend RBAC enforce-truth mapped by hand from src/web/rbac.ts's
// ENDPOINT_PERMISSION_TABLE plus each screen's actual frontend nav/page guard --
// there is no single screen->role registry in the codebase to read this from
// programmatically (nav gating is spread across app.js and several
// web/modules/*.js files, several of it inconsistent with the backend truth --
// see SCREEN_ACCESS_GAPS below). Consistency for the small set of screens that
// DO have a real, checkable nav-hide condition is guarded by
// src/__tests__/rbac-screen-access-data.test.ts; the rest is a plain data
// mirror, string-contract-tested for wiring only.
//
// IMPORTANT (scope boundary): this is DISPLAY ONLY. It
// shows what the ENFORCE state already is (or would be once RBAC leaves shadow
// mode) -- it does not add the missing frontend nav-hide logic for the 'gap'
// rows below. That is separate, later work.

export const SCREEN_ACCESS_ROLES = ['admin', 'agent', 'read_only', 'viewer']

// access: 'full' (teljes hozzaferes) | 'ro' (nav lathato, olvasas OK, iras backend-tiltott)
//       | 'gap' (nav lathato, de enforce modban API 403 -- frontend gating hianyzik)
//       | 'none' (nem erheto el: nav rejtett / page guard atiranyit)
export const SCREEN_ACCESS_ROWS = [
  { key: 'overview', backend: 'memories:read (fleet fields filtered out)', roles: { admin: 'full', agent: 'full', read_only: 'ro', viewer: 'ro' } },
  { key: 'kanban', backend: 'kanban:read/write', roles: { admin: 'full', agent: 'full', read_only: 'ro', viewer: 'ro' } },
  { key: 'approvals', backend: 'approvals:read/write (agent has no write)', roles: { admin: 'full', agent: 'ro', read_only: 'full', viewer: 'full' } },
  { key: 'workspaceDocs', backend: 'memories:read/write', roles: { admin: 'full', agent: 'full', read_only: 'ro', viewer: 'ro' } },
  { key: 'agents', backend: 'GET: agents:read; write: admin:all', roles: { admin: 'full', agent: 'ro', read_only: 'ro', viewer: 'ro' } },
  { key: 'memories', backend: 'memories:read/write', roles: { admin: 'full', agent: 'full', read_only: 'ro', viewer: 'ro' } },
  { key: 'federation', backend: 'federation:read/write; read_only/viewer have neither', roles: { admin: 'full', agent: 'full', read_only: 'gap', viewer: 'gap' } },
  { key: 'docs', backend: 'static', roles: { admin: 'full', agent: 'full', read_only: 'full', viewer: 'full' } },
  { key: 'messages', backend: 'GET: admin:all; POST: messages:write (agent)', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'tasks', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'skills', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'ideas', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'artifacts', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'tokenUsage', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'status', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'updates', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'settings', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'backups', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'connectors', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'import', backend: 'admin:all', roles: { admin: 'full', agent: 'gap', read_only: 'gap', viewer: 'gap' } },
  { key: 'vault', backend: 'page guard (admin+global) + nav hidden', roles: { admin: 'full', agent: 'none', read_only: 'none', viewer: 'none' } },
  { key: 'auditLog', backend: 'page guard (admin+global) + nav hidden', roles: { admin: 'full', agent: 'none', read_only: 'none', viewer: 'none' } },
  { key: 'adminB2b', backend: 'nav hidden (admin+global)', roles: { admin: 'full', agent: 'none', read_only: 'none', viewer: 'none' } },
  { key: 'adminRbac', backend: "nav hidden (can(admin:all))", roles: { admin: 'full', agent: 'none', read_only: 'none', viewer: 'none' } },
  { key: 'profile', backend: 'nav hidden (session-only); /api/me -> memories:read', roles: { admin: 'full', agent: 'none', read_only: 'full', viewer: 'full' } },
]

// Screens whose frontend nav visibility does NOT yet match the backend enforce
// truth above (the 'gap' cells) -- tracked for the later RBAC-enforce nav-gate
// work, not implemented by this display-only matrix.
export const SCREEN_ACCESS_GAPS = [
  'messages', 'tasks', 'skills', 'ideas', 'artifacts', 'tokenUsage',
  'status', 'updates', 'settings', 'backups', 'connectors', 'import',
  'federation',
]

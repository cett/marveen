import type http from 'node:http'
import type { Role } from '../rbac.js'

// Shared shape every route handler in this folder consumes. The dispatcher in
// src/web.ts builds it once per request and walks each module's tryHandle*
// function. A handler returns true once it has written a response, false to
// let the next module try.
export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  path: string
  method: string
  url: URL
  /** Federation caller identity, set by the auth gate when a peer's inbound
   *  token authenticated this request. Absent/undefined and null both mean
   *  "not a federation-token caller" (e.g. dashboard token) -- handlers must
   *  treat the two identically. */
  fedPeer?: string | null
  /** Resolved auth principal for this request, set by the gate. Absent means
   *  the request carried no valid credential (only possible on ungated public
   *  paths, which are reached without a principal). `user` is set for the
   *  'session' kind; `peer` mirrors fedPeer for the 'federation' kind;
   *  `device` is the key name for the 'device' kind; `tokenName` is the
   *  api_tokens row's human label for the 'token' kind, set only when the
   *  bearer resolved through the registered-token DB lookup -- the legacy
   *  file-based dashboard token (store/.dashboard-token) has no api_tokens
   *  row, so it stays undefined there (honest "no named principal", not a
   *  fabricated one). Lets routes distinguish a human session from a
   *  token/fleet caller or an enrolled device. */
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?: string; peer?: string; device?: string; tokenName?: string }
  /**
   * API version the caller addressed. 'v1' when the request used /api/v1/*,
   * null for the legacy /api/* alias, undefined for non-API paths.
   * Set by the versioning normaliser in web.ts before dispatch.
   */
  apiVersion?: 'v1' | null
  /** Resolved RBAC role for this request. Set by the top-level gate in web.ts.
   *  Absent on ungated public paths (no principal required). */
  role?: Role
  /** Tenant scope for this request.
   *  string -- tenant-scoped (filter data to this tenant).
   *  null   -- global admin (bypass tenant filter; all tenants visible).
   *  undefined -- ungated public path (no principal).
   *  Routes MUST check role === 'admin' for the bypass, not tenantId === null,
   *  because null is also the initial default for viewer users before assignment. */
  tenantId?: string | null
  /** Optional self-reported caller identity from the `X-Agent-Id` request
   *  header (see auth-gate.ts's resolveAgentIdHeader). Never a source of
   *  auth/role/tenant truth -- a route may use it only to WARN (never block)
   *  when a write's claimed owner doesn't match who actually sent it. */
  agentId?: string
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>

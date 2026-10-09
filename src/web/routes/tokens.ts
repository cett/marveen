// Admin token management routes.
//
// Provides CRUD over the api_tokens table:
//   GET    /api/admin/tokens               -- list all tokens (hashes omitted)
//   POST   /api/admin/tokens               -- create a new token
//   POST   /api/admin/tokens/:id/rotate    -- rotate: new token, old one revoked
//   DELETE /api/admin/tokens/:id/revoke    -- revoke without rotation
//
// Callers address /api/v1/admin/tokens (canonical) or /api/admin/tokens (legacy).
// The versioning normaliser in web.ts strips the /v1 segment, so ctx.path always
// arrives here as /api/admin/tokens regardless of which form the caller used.
//
// All routes require admin:all permission (enforced by the RBAC layer via the
// /api/v1/admin/ prefix rule in rbac.ts). Token hashes are never returned in
// responses; raw token values are returned ONLY at creation/rotation time.

import { randomBytes, createHash } from 'node:crypto'
import {
  listApiTokenRows,
  getApiTokenRowById,
  insertApiToken,
  revokeApiToken,
  rotateApiToken,
  type ApiTokenRow,
} from '../../db.js'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { isKnownAgent } from '../agent-config.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// ── Schema types ─────────────────────────────────────────────────────────────

type TokenRow = ApiTokenRow

interface TokenPublic {
  id: number
  name: string
  role: string
  tenant_id: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  rotated_from: number | null
  agent_id: string | null
}

function toPublic(row: TokenRow): TokenPublic {
  const { token_hash: _hash, ...rest } = row
  return rest
}

function sha256hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

const VALID_ROLES = new Set(['admin', 'agent', 'read_only', 'viewer', 'fleet_agent'])
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** An agent the fleet knows: the main agent or one with an agents/<name>/ directory. */
function isFleetAgentId(agentId: string): boolean {
  return agentId === MAIN_AGENT_ID || isKnownAgent(agentId)
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function tryHandleAdminTokens(ctx: RouteContext): Promise<boolean> {
  const { path, method, res } = ctx

  // GET /api/admin/tokens
  if (method === 'GET' && path === '/api/admin/tokens') {
    json(res, listApiTokenRows().map(toPublic))
    return true
  }

  // POST /api/admin/tokens -- create
  if (method === 'POST' && path === '/api/admin/tokens') {
    let parsed: { name?: unknown; role?: unknown; tenant_id?: unknown; expires_in_days?: unknown; agent_id?: unknown }
    try {
      const buf = await readBody(ctx.req)
      parsed = JSON.parse(buf.toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'invalid body' }, 400)
      return true
    }

    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    const role = typeof parsed.role === 'string' ? parsed.role.trim() : ''
    let tenantId = typeof parsed.tenant_id === 'string' ? parsed.tenant_id.trim() : 'default'
    const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id.trim() : ''

    if (!name) { json(res, { error: 'required', field: 'name', hint: 'name is required' }, 400); return true }
    if (!VALID_ROLES.has(role)) {
      json(res, { error: 'invalid_value', field: 'role', hint: `role must be one of: ${[...VALID_ROLES].join(', ')}` }, 400)
      return true
    }
    if (parsed.agent_id !== undefined && parsed.agent_id !== null && (typeof parsed.agent_id !== 'string' || !AGENT_ID_RE.test(agentId))) {
      json(res, { error: 'invalid_value', field: 'agent_id', hint: 'agent_id must be a plain agent name' }, 400)
      return true
    }
    // The agent a token names: required for a fleet_agent token (the token IS that agent's identity),
    // allowed on an admin token as a label (the main agent's own named admin token), meaningless on
    // the tenant-user roles.
    if (role === 'fleet_agent' && !agentId) {
      json(res, { error: 'required', field: 'agent_id', hint: 'a fleet_agent token needs the agent_id it belongs to' }, 400)
      return true
    }
    if (agentId && role !== 'fleet_agent' && role !== 'admin') {
      json(res, { error: 'invalid_value', field: 'agent_id', hint: 'agent_id applies to fleet_agent and admin tokens only' }, 400)
      return true
    }
    if (agentId && !isFleetAgentId(agentId)) {
      json(res, { error: 'not_found', field: 'agent_id', hint: `unknown agent '${agentId}'` }, 404)
      return true
    }
    // A fleet_agent token carries no tenant of its own: the tenant of a request is derived from the
    // agent's serving context at request time, so the stored value is always the neutral default.
    if (role === 'fleet_agent') tenantId = 'default'

    const now = Math.floor(Date.now() / 1000)
    const expiresInDays = typeof parsed.expires_in_days === 'number' ? parsed.expires_in_days : null
    const expiresAt = expiresInDays !== null ? now + expiresInDays * 86400 : null

    const rawToken = generateToken()
    const hash = sha256hex(rawToken)

    try {
      const row = insertApiToken({ tokenHash: hash, name, role, tenantId, createdAt: now, expiresAt, agentId: agentId || null })
      logger.info({ tokenId: row.id, name, role, tenantId, agentId: agentId || null }, 'api_token created')
      // Return the raw token value ONCE -- it cannot be recovered after this response.
      json(res, { token: rawToken, ...toPublic(row) }, 201)
    } catch (e) {
      logger.error({ err: e }, 'api_token create failed')
      json(res, { error: 'internal_error', hint: 'failed to create token' }, 500)
    }
    return true
  }

  // POST /api/admin/tokens/:id/rotate
  const rotateMatch = /^\/api\/admin\/tokens\/(\d+)\/rotate$/.exec(path)
  if (method === 'POST' && rotateMatch) {
    const id = Number(rotateMatch[1])

    let parsed: { expires_in_days?: unknown } = {}
    try {
      const buf = await readBody(ctx.req)
      const str = buf.toString().trim()
      if (str) parsed = JSON.parse(str)
    } catch {
      json(res, { error: 'parse_error', hint: 'invalid body' }, 400)
      return true
    }

    const old = getApiTokenRowById(id)
    if (!old) { json(res, { error: 'not_found', hint: 'token not found' }, 404); return true }
    // deliberate: discriminating error response, admin-gated
    if (old.revoked_at !== null) { json(res, { error: 'conflict', hint: 'token already revoked' }, 409); return true }

    const now = Math.floor(Date.now() / 1000)
    const expiresInDays = typeof parsed.expires_in_days === 'number' ? parsed.expires_in_days : null
    const expiresAt = expiresInDays !== null ? now + expiresInDays * 86400 : old.expires_at

    const rawToken = generateToken()
    const hash = sha256hex(rawToken)

    try {
      // Revokes the old token atomically with creating the replacement.
      const newRow = rotateApiToken(old, hash, now, expiresAt)
      logger.info({ oldId: id, newId: newRow.id, name: old.name }, 'api_token rotated')
      json(res, { token: rawToken, ...toPublic(newRow) })
    } catch (e) {
      logger.error({ err: e }, 'api_token rotate failed')
      json(res, { error: 'internal_error', hint: 'failed to rotate token' }, 500)
    }
    return true
  }

  // DELETE /api/admin/tokens/:id/revoke
  const revokeMatch = /^\/api\/admin\/tokens\/(\d+)\/revoke$/.exec(path)
  if (method === 'DELETE' && revokeMatch) {
    const id = Number(revokeMatch[1])
    const row = getApiTokenRowById(id)
    if (!row) { json(res, { error: 'not_found', hint: 'token not found' }, 404); return true }
    // deliberate: discriminating error response, admin-gated
    if (row.revoked_at !== null) { json(res, { error: 'conflict', hint: 'token already revoked' }, 409); return true }

    const now = Math.floor(Date.now() / 1000)
    revokeApiToken(id, now)
    logger.info({ tokenId: id, name: row.name }, 'api_token revoked')
    json(res, { revoked: true, id })
    return true
  }

  return false
}

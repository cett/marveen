// Persistence for scoped API tokens (api_tokens table). Token generation,
// hashing and the HTTP surface live in web/routes/tokens.ts; the lookup that
// feeds the auth gate lives in web/auth-gate.ts.

import Database from 'better-sqlite3'
import { db } from './connection.js'

export interface ApiTokenRow {
  id: number
  token_hash: string
  name: string
  role: string
  tenant_id: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  rotated_from: number | null
  /** The agent the token belongs to; NULL for a token that names no agent (the dashboard token). */
  agent_id: string | null
}

export interface ValidApiTokenRow {
  role: string
  tenant_id: string
  name: string
  agent_id: string | null
}

/**
 * Enrolls the dashboard token as an admin token. Returns 1 when a row was inserted, 0 when it already existed.
 * Every other active `dashboard` row is revoked in the same transaction, on every call (not only when a row
 * was inserted): a rotated-away token stops working instead of lingering as a second valid admin credential,
 * and an install that already holds two active rows is cleaned up on its next boot. The row of the hash being
 * enrolled is never touched, so a row revoked on purpose stays revoked, and so does the old token of an
 * A -> B -> A restore of the token file (rotate by deleting the file, which draws a fresh token; recover a
 * locked-out file token with the rollback in web/token-bootstrap.ts).
 */
export function enrollDashboardApiToken(tokenHash: string, now: number): number {
  return db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO api_tokens
           (token_hash, name, role, created_at)
         VALUES (?, 'dashboard', 'admin', ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(tokenHash, now).changes
    db.prepare(
      `UPDATE api_tokens SET revoked_at = ?
       WHERE name = 'dashboard' AND token_hash != ? AND revoked_at IS NULL`,
    ).run(now, tokenHash)
    return inserted
  })()
}

/** The token row when it is neither revoked nor expired at `now`. */
export function getValidApiToken(tokenHash: string, now: number): ValidApiTokenRow | undefined {
  return db
    .prepare(
      `SELECT role, tenant_id, name, agent_id FROM api_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(tokenHash, now) as ValidApiTokenRow | undefined
}

/** True when the hash is registered at all (valid, expired or revoked). */
export function apiTokenHashExists(tokenHash: string): boolean {
  return !!db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(tokenHash)
}

/** When the active `dashboard` row (the shared token) was enrolled, epoch seconds; 0 when there is none. */
export function latestActiveDashboardTokenAt(): number {
  const row = db.prepare("SELECT MAX(created_at) AS t FROM api_tokens WHERE name = 'dashboard' AND revoked_at IS NULL").get() as { t: number | null }
  return row.t ?? 0
}

/** The row registered under this hash in any state (active, expired or revoked), or undefined. */
export function getApiTokenRowByHash(tokenHash: string): ApiTokenRow | undefined {
  return db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRow | undefined
}

export function listApiTokenRows(): ApiTokenRow[] {
  return db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all() as ApiTokenRow[]
}

export function getApiTokenRowById(id: number): ApiTokenRow | undefined {
  return db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as ApiTokenRow | undefined
}

export function insertApiToken(row: {
  tokenHash: string
  name: string
  role: string
  tenantId: string
  createdAt: number
  expiresAt: number | null
  agentId?: string | null
}): ApiTokenRow {
  return db
    .prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(row.tokenHash, row.name, row.role, row.tenantId, row.createdAt, row.expiresAt, row.agentId ?? null) as ApiTokenRow
}

/** The not-revoked, not-expired tokens carrying this name, newest first. */
export function listActiveApiTokensByName(name: string, now: number): ApiTokenRow[] {
  return db
    .prepare(
      `SELECT * FROM api_tokens
       WHERE name = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, id DESC`,
    )
    .all(name, now) as ApiTokenRow[]
}

/** Revokes every active token that belongs to the agent (an agent that is deleted keeps no credential). */
export function revokeApiTokensForAgent(agentId: string, now: number): number {
  return db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL').run(now, agentId).changes
}

export function revokeApiToken(id: number, now: number): void {
  db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, id)
}

/**
 * Revokes `old` and mints its replacement in one transaction, so there is never
 * a moment with zero or two valid tokens. Returns the new row.
 */
export function rotateApiToken(
  old: Pick<ApiTokenRow, 'id' | 'name' | 'role' | 'tenant_id' | 'agent_id'>,
  newTokenHash: string,
  now: number,
  expiresAt: number | null,
): ApiTokenRow {
  db.transaction(() => {
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, old.id)
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, rotated_from, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newTokenHash, old.name, old.role, old.tenant_id, now, expiresAt, old.id, old.agent_id)
  })()
  return db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(newTokenHash) as ApiTokenRow
}

/**
 * Mints the token for one name (agent-tokens issue()) in ONE transaction. `current` is the active row whose
 * file hash matched: it is rotated, and every other active row of the name is revoked. Without `current`
 * the file was missing or held nothing active, so whatever was active under the name is unreachable (nobody
 * holds its secret) and goes before the replacement comes.
 */
export function replaceActiveApiToken(input: {
  current: ApiTokenRow | undefined
  active: ApiTokenRow[]
  tokenHash: string
  name: string
  role: string
  agentId: string | null
  now: number
}): ApiTokenRow {
  return db.transaction(() => {
    if (input.current) {
      const next = rotateApiToken(input.current, input.tokenHash, input.now, null)
      for (const stale of input.active) if (stale.id !== input.current.id) revokeApiToken(stale.id, input.now)
      return next
    }
    for (const stale of input.active) revokeApiToken(stale.id, input.now)
    return insertApiToken({
      tokenHash: input.tokenHash, name: input.name, role: input.role, tenantId: 'default',
      createdAt: input.now, expiresAt: null, agentId: input.agentId,
    })
  })()
}

/**
 * Rotates the shared dashboard token (agent-tokens rotateSharedToken) in ONE transaction: the newest active
 * `dashboard` row is rotated (revoked WITH its hash kept), any older active one is revoked, and without an
 * active row a new one is inserted. `active` is listActiveApiTokensByName('dashboard', now), newest first.
 */
export function rotateSharedDashboardToken(active: ApiTokenRow[], tokenHash: string, now: number): ApiTokenRow {
  return db.transaction(() => {
    const [first, ...others] = active
    for (const stale of others) revokeApiToken(stale.id, now)
    if (first) return rotateApiToken(first, tokenHash, now, null)
    return insertApiToken({ tokenHash, name: 'dashboard', role: 'admin', tenantId: 'default', createdAt: now, expiresAt: null, agentId: null })
  })()
}

/**
 * The creation time of the newest active `dashboard` token in a BACKUP database (a throwaway copy: only a
 * SELECT runs, but a database in WAL mode may get sidecar files next to it, so never point this at a live
 * database file). null when the archive has no such row. Throws when the file cannot be opened or has no
 * api_tokens table; the caller decides what that means.
 */
export function archiveDashboardTokenCreatedAt(archiveDbPath: string): number | null {
  const archive = new Database(archiveDbPath, { fileMustExist: true })
  try {
    const row = archive.prepare("SELECT MAX(created_at) AS t FROM api_tokens WHERE name = 'dashboard' AND revoked_at IS NULL").get() as { t: number | null }
    return row.t
  } finally {
    archive.close()
  }
}

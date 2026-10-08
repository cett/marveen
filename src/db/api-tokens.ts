// Persistence for scoped API tokens (api_tokens table). Token generation,
// hashing and the HTTP surface live in web/routes/tokens.ts; the lookup that
// feeds the auth gate lives in web/auth-gate.ts.

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
}

export interface ValidApiTokenRow {
  role: string
  tenant_id: string
  name: string
}

/** Enrolls the dashboard token as an admin token. Returns 1 when a row was inserted, 0 when it already existed. */
export function enrollDashboardApiToken(tokenHash: string, now: number): number {
  return db
    .prepare(
      `INSERT INTO api_tokens
         (token_hash, name, role, created_at)
       VALUES (?, 'dashboard', 'admin', ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(tokenHash, now).changes
}

/** The token row when it is neither revoked nor expired at `now`. */
export function getValidApiToken(tokenHash: string, now: number): ValidApiTokenRow | undefined {
  return db
    .prepare(
      `SELECT role, tenant_id, name FROM api_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(tokenHash, now) as ValidApiTokenRow | undefined
}

/** True when the hash is registered at all (valid, expired or revoked). */
export function apiTokenHashExists(tokenHash: string): boolean {
  return !!db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(tokenHash)
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
}): ApiTokenRow {
  return db
    .prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(row.tokenHash, row.name, row.role, row.tenantId, row.createdAt, row.expiresAt) as ApiTokenRow
}

export function revokeApiToken(id: number, now: number): void {
  db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, id)
}

/**
 * Revokes `old` and mints its replacement in one transaction, so there is never
 * a moment with zero or two valid tokens. Returns the new row.
 */
export function rotateApiToken(
  old: Pick<ApiTokenRow, 'id' | 'name' | 'role' | 'tenant_id'>,
  newTokenHash: string,
  now: number,
  expiresAt: number | null,
): ApiTokenRow {
  db.transaction(() => {
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, old.id)
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, rotated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newTokenHash, old.name, old.role, old.tenant_id, now, expiresAt, old.id)
  })()
  return db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(newTokenHash) as ApiTokenRow
}

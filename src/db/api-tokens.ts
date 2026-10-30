// Persistence for scoped API tokens (api_tokens table). Token generation,
// hashing and the HTTP surface live in web/routes/tokens.ts; the lookup that
// feeds the auth gate lives in web/auth-gate.ts.

import Database from 'better-sqlite3'
import { dbx } from './facade.js'
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
export async function enrollDashboardApiToken(tokenHash: string, now: number): Promise<number> {
  return dbx.tx(async (tx) => {
    const inserted = (await tx.run(`INSERT INTO api_tokens
           (token_hash, name, role, created_at)
         VALUES (?, 'dashboard', 'admin', ?)
         ON CONFLICT DO NOTHING`, tokenHash, now)).changes
    await tx.run(`UPDATE api_tokens SET revoked_at = ?
       WHERE name = 'dashboard' AND token_hash != ? AND revoked_at IS NULL`, now, tokenHash)
    return inserted
  })
}

/**
 * The boot-synchronous twin of enrollDashboardApiToken, on the raw connection: startWebServer enrolls the file
 * token before it listens and returns an http.Server, so it cannot await. Same two statements, same rules, same
 * return value -- keep the two in step. Only web/token-bootstrap.ts calls it (db-boot-sync-twins.test.ts pins that).
 */
// @boot-sync-twin
export function enrollDashboardApiTokenSync(tokenHash: string, now: number): number {
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
export async function getValidApiToken(tokenHash: string, now: number): Promise<ValidApiTokenRow | undefined> {
  return dbx.get<ValidApiTokenRow>(`SELECT role, tenant_id, name, agent_id FROM api_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, tokenHash, now)
}

/** True when the hash is registered at all (valid, expired or revoked). */
export async function apiTokenHashExists(tokenHash: string): Promise<boolean> {
  return !!await dbx.get('SELECT id FROM api_tokens WHERE token_hash = ?', tokenHash)
}

/** When the active `dashboard` row (the shared token) was enrolled, epoch seconds; 0 when there is none. */
export async function latestActiveDashboardTokenAt(): Promise<number> {
  const row = (await dbx.get("SELECT MAX(created_at) AS t FROM api_tokens WHERE name = 'dashboard' AND revoked_at IS NULL")) as { t: number | null }
  return row.t ?? 0
}

/** The row registered under this hash in any state (active, expired or revoked), or undefined. */
export async function getApiTokenRowByHash(tokenHash: string): Promise<ApiTokenRow | undefined> {
  return dbx.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?', tokenHash)
}

export async function listApiTokenRows(): Promise<ApiTokenRow[]> {
  return dbx.all<ApiTokenRow>('SELECT * FROM api_tokens ORDER BY created_at DESC')
}

export async function getApiTokenRowById(id: number): Promise<ApiTokenRow | undefined> {
  return dbx.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?', id)
}

export async function insertApiToken(row: {
  tokenHash: string
  name: string
  role: string
  tenantId: string
  createdAt: number
  expiresAt: number | null
  agentId?: string | null
}): Promise<ApiTokenRow> {
  return (await dbx.get(`INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`, row.tokenHash, row.name, row.role, row.tenantId, row.createdAt, row.expiresAt, row.agentId ?? null)) as ApiTokenRow
}

/** The not-revoked, not-expired tokens carrying this name, newest first. */
export async function listActiveApiTokensByName(name: string, now: number): Promise<ApiTokenRow[]> {
  return dbx.all<ApiTokenRow>(`SELECT * FROM api_tokens
       WHERE name = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, id DESC`, name, now)
}

/** Revokes every active token that belongs to the agent (an agent that is deleted keeps no credential). */
export async function revokeApiTokensForAgent(agentId: string, now: number): Promise<number> {
  return (await dbx.run('UPDATE api_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL', now, agentId)).changes
}

export async function revokeApiToken(id: number, now: number): Promise<void> {
  await dbx.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', now, id)
}

/** Thrown by rotateApiToken when the token is no longer active: another caller revoked or rotated it first. */
export class ApiTokenAlreadyRevokedError extends Error {
  constructor(readonly tokenId: number) {
    super(`api token ${tokenId} is already revoked`)
    this.name = 'ApiTokenAlreadyRevokedError'
  }
}

/**
 * Revokes `old` and mints its replacement in one transaction, so there is never
 * a moment with zero or two valid tokens. Returns the new row. The revoke only
 * takes an ACTIVE row: when it finds none changed (a concurrent rotation or
 * revoke won), the transaction rolls back, no replacement is written, and the
 * call rejects with ApiTokenAlreadyRevokedError. Inside a larger transaction
 * this is a savepoint, and the error also rolls that larger transaction back.
 */
export async function rotateApiToken(
  old: Pick<ApiTokenRow, 'id' | 'name' | 'role' | 'tenant_id' | 'agent_id'>,
  newTokenHash: string,
  now: number,
  expiresAt: number | null,
): Promise<ApiTokenRow> {
  await dbx.tx(async (tx) => {
    const revoked = await tx.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, old.id)
    if (revoked.changes === 0) throw new ApiTokenAlreadyRevokedError(old.id)
    await tx.run(`INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, rotated_from, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newTokenHash, old.name, old.role, old.tenant_id, now, expiresAt, old.id, old.agent_id)
  })
  return (await dbx.get('SELECT * FROM api_tokens WHERE token_hash = ?', newTokenHash)) as ApiTokenRow
}

/**
 * Mints the token for one name (agent-tokens issue()) in ONE `immediate` transaction, and reads what is
 * active INSIDE it. `fileHash` is the hash of the token file as it stood: the active row carrying it is
 * rotated (revoked with its hash kept, the new row points back at it), and EVERY other active row of the
 * name is revoked. Without a match the file was missing or held nothing active, so whatever was active
 * under the name is unreachable (nobody holds its secret) and goes before the replacement comes.
 *
 * Reading inside the transaction is what makes two overlapping calls (also from two processes: the write
 * lock is taken at BEGIN) end with exactly one active row: the second one sees the first one's row and
 * revokes it. `rotated` tells whether a row was rotated (true) or the name got a fresh row (false).
 */
export async function replaceActiveApiToken(input: {
  fileHash: string | null
  tokenHash: string
  name: string
  role: string
  agentId: string | null
  now: number
}): Promise<{ row: ApiTokenRow; rotated: boolean }> {
  return dbx.tx(async () => {
    const active = await listActiveApiTokensByName(input.name, input.now)
    const current = input.fileHash ? active.find(r => r.token_hash === input.fileHash) : undefined
    for (const stale of active) if (stale.id !== current?.id) await revokeApiToken(stale.id, input.now)
    if (current) return { row: await rotateApiToken(current, input.tokenHash, input.now, null), rotated: true }
    const row = await insertApiToken({
      tokenHash: input.tokenHash, name: input.name, role: input.role, tenantId: 'default',
      createdAt: input.now, expiresAt: null, agentId: input.agentId,
    })
    return { row, rotated: false }
  }, { mode: 'immediate' })
}

/**
 * Rotates the shared dashboard token (agent-tokens rotateSharedToken) in ONE transaction: the newest active
 * `dashboard` row is rotated (revoked WITH its hash kept), any older active one is revoked, and without an
 * active row a new one is inserted. `active` is listActiveApiTokensByName('dashboard', now), newest first.
 */
export async function rotateSharedDashboardToken(active: ApiTokenRow[], tokenHash: string, now: number): Promise<ApiTokenRow> {
  return dbx.tx(async (tx) => {
    const [first, ...others] = active
    for (const stale of others) await revokeApiToken(stale.id, now)
    if (first) return rotateApiToken(first, tokenHash, now, null)
    return insertApiToken({ tokenHash, name: 'dashboard', role: 'admin', tenantId: 'default', createdAt: now, expiresAt: null, agentId: null })
  })
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

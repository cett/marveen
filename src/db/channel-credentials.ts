// Read/write access to channel_allowed_chats and channel_credential_baseline (migration 0086): the
// server-side record of which chats a channel's server-initiated sends may reach, and what the
// channel's files looked like when the owner adopted them. Written only by the admin adopt route
// (src/web/channel-credentials.ts); read by the voice route, the scheduled-task delivery prefix and
// the drift check.
import { db } from './connection.js'

export type ChannelDriftState = 'ok' | 'token' | 'access' | 'both' | 'unreadable'

export interface ChannelCredentialBaseline {
  agent_id: string
  provider: string
  token_sha256: string
  allow_sha256: string
  adopted_by: string
  adopted_at: number
  last_checked_at: number | null
  drift_state: ChannelDriftState
  drift_since: number | null
  tenant_id: string
}

const BASELINE_COLUMNS =
  'agent_id, provider, token_sha256, allow_sha256, adopted_by, adopted_at, last_checked_at, drift_state, drift_since, tenant_id'

const DEFAULT_TENANT = 'default'

/** The adopted chats of a channel, in adoption order. Empty when nothing is adopted. */
export function listAdoptedChats(agentId: string, provider: string, tenantId: string = DEFAULT_TENANT): string[] {
  const rows = db
    .prepare('SELECT chat_id FROM channel_allowed_chats WHERE tenant_id = ? AND agent_id = ? AND provider = ? ORDER BY position, chat_id')
    .all(tenantId, agentId, provider) as Array<{ chat_id: string }>
  return rows.map((r) => r.chat_id)
}

/** True iff `chatId` is on the adopted list of this channel. An agent with no adoption has no chats. */
export function isChatAdopted(agentId: string, provider: string, chatId: string, tenantId: string = DEFAULT_TENANT): boolean {
  return db
    .prepare('SELECT 1 FROM channel_allowed_chats WHERE tenant_id = ? AND agent_id = ? AND provider = ? AND chat_id = ?')
    .get(tenantId, agentId, provider, chatId) !== undefined
}

export function getChannelCredentialBaseline(agentId: string, provider: string, tenantId: string = DEFAULT_TENANT): ChannelCredentialBaseline | null {
  return (db
    .prepare(`SELECT ${BASELINE_COLUMNS} FROM channel_credential_baseline WHERE tenant_id = ? AND agent_id = ? AND provider = ?`)
    .get(tenantId, agentId, provider) as ChannelCredentialBaseline | undefined) ?? null
}

export function listChannelCredentialBaselines(tenantId: string = DEFAULT_TENANT): ChannelCredentialBaseline[] {
  return db
    .prepare(`SELECT ${BASELINE_COLUMNS} FROM channel_credential_baseline WHERE tenant_id = ? ORDER BY agent_id, provider`)
    .all(tenantId) as ChannelCredentialBaseline[]
}

/**
 * Records an adoption: replaces the channel's chat list and its baseline in one transaction, so the
 * list and the hashes that describe it can never disagree. Re-adopting resets the drift state.
 */
export function adoptChannelCredential(input: {
  agentId: string
  provider: string
  chatIds: readonly string[]
  tokenSha256: string
  allowSha256: string
  adoptedBy: string
  tenantId?: string
}): void {
  const tenantId = input.tenantId ?? DEFAULT_TENANT
  db.transaction(() => {
    db.prepare('DELETE FROM channel_allowed_chats WHERE tenant_id = ? AND agent_id = ? AND provider = ?').run(tenantId, input.agentId, input.provider)
    const insert = db.prepare(
      'INSERT INTO channel_allowed_chats (agent_id, provider, chat_id, position, adopted_by, adopted_at, tenant_id) VALUES (?, ?, ?, ?, ?, unixepoch(), ?)',
    )
    input.chatIds.forEach((chatId, i) => insert.run(input.agentId, input.provider, chatId, i, input.adoptedBy, tenantId))
    db.prepare(`
      INSERT INTO channel_credential_baseline (agent_id, provider, token_sha256, allow_sha256, adopted_by, adopted_at, last_checked_at, drift_state, drift_since, tenant_id)
      VALUES (?, ?, ?, ?, ?, unixepoch(), NULL, 'ok', NULL, ?)
      ON CONFLICT(tenant_id, agent_id, provider) DO UPDATE SET
        token_sha256    = excluded.token_sha256,
        allow_sha256    = excluded.allow_sha256,
        adopted_by      = excluded.adopted_by,
        adopted_at      = excluded.adopted_at,
        last_checked_at = NULL,
        drift_state     = 'ok',
        drift_since     = NULL
    `).run(input.agentId, input.provider, input.tokenSha256, input.allowSha256, input.adoptedBy, tenantId)
  })()
}

/**
 * Forgets an adoption (the channel was set up again: a new token, an empty access.json). Returns true
 * iff there was something to forget.
 */
export function clearChannelAdoption(agentId: string, provider: string, tenantId: string = DEFAULT_TENANT): boolean {
  return db.transaction(() => {
    const chats = db.prepare('DELETE FROM channel_allowed_chats WHERE tenant_id = ? AND agent_id = ? AND provider = ?').run(tenantId, agentId, provider).changes
    const base = db.prepare('DELETE FROM channel_credential_baseline WHERE tenant_id = ? AND agent_id = ? AND provider = ?').run(tenantId, agentId, provider).changes
    return chats + base > 0
  })()
}

/**
 * Stores the outcome of a drift check. Returns true iff this check STARTED a new drift episode
 * (the previous state was ok and the new one is not), which is when the alarm is raised; a state that
 * persists, or changes from one drift to another, is not a new episode.
 */
export function recordChannelDriftCheck(
  agentId: string,
  provider: string,
  state: ChannelDriftState,
  nowSec: number,
  tenantId: string = DEFAULT_TENANT,
): boolean {
  return db.transaction(() => {
    const row = db
      .prepare('SELECT drift_state FROM channel_credential_baseline WHERE tenant_id = ? AND agent_id = ? AND provider = ?')
      .get(tenantId, agentId, provider) as { drift_state: ChannelDriftState } | undefined
    if (!row) return false
    const startsEpisode = row.drift_state === 'ok' && state !== 'ok'
    db.prepare(`
      UPDATE channel_credential_baseline
         SET last_checked_at = ?,
             drift_state = ?,
             drift_since = CASE WHEN ? = 'ok' THEN NULL WHEN drift_state = 'ok' THEN ? ELSE drift_since END
       WHERE tenant_id = ? AND agent_id = ? AND provider = ?
    `).run(nowSec, state, state, nowSec, tenantId, agentId, provider)
    return startsEpisode
  })()
}

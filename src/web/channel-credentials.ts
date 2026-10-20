// Server-side source of a channel's credential, for the sends the SERVER makes (voice TTS/STT, the chat
// a scheduled task reports to).
//
// The bot token (<state_dir>/.env) and the pairing (<state_dir>/access.json) sit in a directory the
// agent's own OS user writes, so a server send that trusts them can be steered by the agent. This
// module is the replacement source and the check on the files:
//   * the bot token is the vault secret 'channel-token:<agent_id>' (getChannelBotToken);
//   * the allowed chats are the DB list written by adoptChannel (channel_allowed_chats);
//   * adoptChannel is the one place that reads the files: the owner calls it (admin route) and the
//     files, as they stand then, become the record;
//   * checkChannelDrift compares the files with the record. A difference is an alarm, never a change of
//     the server-side value.
// What this does not do: the plugin keeps reading .env / access.json on its own channel, so an agent can
// still send as itself on its own bot to any chat. That is the hard boundary (an OS user per agent, or
// the channel taken over by a coordinator) and a separate decision.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { channelStateDir } from '../channel-provider.js'
import {
  adoptChannelCredential,
  clearChannelAdoption,
  getChannelCredentialBaseline,
  isChatAdopted,
  listAdoptedChats,
  listChannelCredentialBaselines,
  recordChannelDriftCheck,
  type ChannelDriftState,
} from '../db.js'
import { deliverToChannel } from '../notify.js'
import { logger } from '../logger.js'
import { agentDir, listAgentNames } from './agent-config.js'
import { getSecret, setSecret, deleteSecret } from './vault.js'
import { recordTokenShadow } from './token-shadow.js'

/** The only provider the record covers today. */
export const CHANNEL_PROVIDER = 'telegram'

export const CHANNEL_DRIFT_CATEGORY = 'channel_credential_drift'

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/
const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/
const CHAT_ID_RE = /^-?\d{1,20}$/

export function isValidChannelAgentId(agentId: string): boolean {
  return AGENT_ID_RE.test(agentId)
}

/** The vault secret id of an agent's channel bot token. The main agent's is keyed by MAIN_AGENT_ID. */
export function channelTokenSecretId(agentId: string): string {
  return `channel-token:${agentId}`
}

/**
 * The agent's own channel directory, derived from the agent id alone: the main agent's is
 * ~/.claude/channels/telegram, a sub-agent's <agent dir>/.claude/channels/telegram. Unlike
 * resolveAgentChannelStateDir there is no fallback to another agent's directory.
 */
export function channelDirForAgent(agentId: string): string {
  return agentId === MAIN_AGENT_ID ? channelStateDir(CHANNEL_PROVIDER) : channelStateDir(CHANNEL_PROVIDER, agentDir(agentId))
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

// ── the files, as they are ──────────────────────────────────────────────────

/** TELEGRAM_BOT_TOKEN from the text of a channel .env, or null. */
export function parseEnvBotToken(envText: string): string | null {
  const m = /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(envText)
  if (!m) return null
  const token = m[1].trim().replace(/^["']|["']$/g, '')
  return TELEGRAM_TOKEN_RE.test(token) ? token : null
}

/**
 * Pure: the chats an access.json names, in file order. The DM allowlist first, then the groups, each
 * entry a Telegram chat id (digits, a group's with a leading '-'). Anything else is dropped, and a
 * duplicate counts once. The first entry is the one a scheduled task reports to.
 */
export function chatsFromAccessConfig(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const o = raw as Record<string, unknown>
  const out: string[] = []
  const add = (v: unknown): void => {
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
    if (CHAT_ID_RE.test(s) && !out.includes(s)) out.push(s)
  }
  if (Array.isArray(o.allowFrom)) o.allowFrom.forEach(add)
  if (o.groups && typeof o.groups === 'object' && !Array.isArray(o.groups)) Object.keys(o.groups as Record<string, unknown>).forEach(add)
  return out
}

/** Hash of the chat set. Order does not matter: the plugin may append or reorder without changing who is paired. */
export function chatsHash(chats: readonly string[]): string {
  return sha256(JSON.stringify([...chats].sort()))
}

export const tokenHash = sha256

interface ChannelFiles {
  token: string | null
  chats: string[]
}

/** Reads the channel's files. Throws when a file cannot be read or access.json is not JSON. */
function readChannelFiles(agentId: string): ChannelFiles {
  const dir = channelDirForAgent(agentId)
  const token = parseEnvBotToken(readFileSync(join(dir, '.env'), 'utf8'))
  const chats = chatsFromAccessConfig(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8')) as unknown)
  return { token, chats }
}

// ── what the server uses ────────────────────────────────────────────────────

/** The bot token the server sends with, from the vault only. Null when the channel is not adopted. */
export function getChannelBotToken(agentId: string): string | null {
  if (!isValidChannelAgentId(agentId)) return null
  try {
    return getSecret(channelTokenSecretId(agentId))
  } catch (err) {
    logger.warn({ err, agent: agentId }, 'channel-credentials: vault read failed')
    return null
  }
}

/** Is `chatId` on the adopted list of the agent's channel? No adoption means no chat. */
export function serverMaySendTo(agentId: string, chatId: string): boolean {
  return isValidChannelAgentId(agentId) && isChatAdopted(agentId, CHANNEL_PROVIDER, chatId)
}

/** The chat a scheduled task reports to: the first adopted chat, or null when nothing is adopted. */
export function adoptedDeliveryChat(agentId: string): string | null {
  return listAdoptedChats(agentId, CHANNEL_PROVIDER)[0] ?? null
}

export function hasAdoption(agentId: string): boolean {
  return getChannelCredentialBaseline(agentId, CHANNEL_PROVIDER) !== null
}

// ── adopt ───────────────────────────────────────────────────────────────────

export type AdoptResult =
  | { ok: true; agentId: string; chats: string[]; replacedToken: boolean }
  | { ok: false; reason: 'invalid_agent' | 'unreadable' | 'no_token' }

/**
 * The owner's act: record the channel as it stands now. The token goes into the vault, the chat list
 * and the hashes into the DB, in that order, so a failure half way leaves no list without a token.
 * An empty chat list is a valid adoption (a channel nobody paired yet); the server then sends nowhere.
 */
export function adoptChannel(agentId: string, adoptedBy: string): AdoptResult {
  if (!isValidChannelAgentId(agentId)) return { ok: false, reason: 'invalid_agent' }
  let files: ChannelFiles
  try {
    files = readChannelFiles(agentId)
  } catch (err) {
    logger.warn({ err, agent: agentId }, 'channel-credentials: adopt could not read the channel files')
    return { ok: false, reason: 'unreadable' }
  }
  if (!files.token) return { ok: false, reason: 'no_token' }
  const previous = getChannelBotToken(agentId)
  setSecret(channelTokenSecretId(agentId), `Channel bot token (${CHANNEL_PROVIDER}) of ${agentId}`, files.token)
  adoptChannelCredential({
    agentId,
    provider: CHANNEL_PROVIDER,
    chatIds: files.chats,
    tokenSha256: tokenHash(files.token),
    allowSha256: chatsHash(files.chats),
    adoptedBy,
  })
  return { ok: true, agentId, chats: files.chats, replacedToken: previous !== null && previous !== files.token }
}

/**
 * The channel was set up again (new token, access.json reset): the old record describes a channel
 * that no longer exists. Drops the list and the baseline and stores the new token, so the server
 * keeps sending on the right bot while the chat list stays empty until the owner adopts the new
 * pairing.
 */
export function resetChannelAfterSetup(agentId: string, botToken: string): void {
  if (!isValidChannelAgentId(agentId)) return
  clearChannelAdoption(agentId, CHANNEL_PROVIDER)
  try {
    setSecret(channelTokenSecretId(agentId), `Channel bot token (${CHANNEL_PROVIDER}) of ${agentId}`, botToken)
  } catch (err) {
    logger.warn({ err, agent: agentId }, 'channel-credentials: could not store the new bot token in the vault')
  }
}

/** The agent is gone: its record and its vault token go with it. */
export function forgetChannel(agentId: string): void {
  if (!isValidChannelAgentId(agentId)) return
  clearChannelAdoption(agentId, CHANNEL_PROVIDER)
  try { deleteSecret(channelTokenSecretId(agentId)) } catch { /* nothing stored */ }
}

// ── drift ───────────────────────────────────────────────────────────────────

/** Pure: which part of the files differs from the record. */
export function classifyDrift(
  baseline: { token_sha256: string; allow_sha256: string },
  files: { token: string | null; chats: readonly string[] },
): ChannelDriftState {
  const tokenDiffers = files.token === null || tokenHash(files.token) !== baseline.token_sha256
  const accessDiffers = chatsHash(files.chats) !== baseline.allow_sha256
  if (tokenDiffers && accessDiffers) return 'both'
  if (tokenDiffers) return 'token'
  if (accessDiffers) return 'access'
  return 'ok'
}

export function formatDriftAlarm(agentId: string, state: ChannelDriftState): string {
  const what = state === 'token' ? 'a bot token a .env-ben'
    : state === 'access' ? 'a párosított chatek listája az access.json-ban'
    : state === 'both' ? 'a bot token és a chatlista is'
    : 'a csatorna fájljai nem olvashatók'
  return [
    '⚠️ Csatorna-hitelesítő eltérés',
    `Ágens: \`${agentId}\``,
    `Eltérő: ${what}`,
    'A szerver a rögzített értéket használja tovább (hang, ütemezett kézbesítés). Ha az eltérés szándékos (új párosítás), rögzítsd újra: POST /api/v1/channel-credentials/adopt.',
  ].join('\n')
}

/**
 * Compares one agent's files with the record. Raises the alarm (shadow counter + owner message) only
 * when this check starts a new drift episode; the state is stored either way. Never throws.
 * Returns the state, or null when the agent has no record to compare with.
 */
export async function checkChannelDrift(
  agentId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  send: (text: string) => Promise<boolean> = deliverToChannel,
): Promise<ChannelDriftState | null> {
  try {
    const baseline = getChannelCredentialBaseline(agentId, CHANNEL_PROVIDER)
    if (!baseline) return null
    let state: ChannelDriftState
    try {
      state = classifyDrift(baseline, readChannelFiles(agentId))
    } catch {
      state = 'unreadable'
    }
    const started = recordChannelDriftCheck(agentId, CHANNEL_PROVIDER, state, nowSec)
    if (started) {
      logger.warn({ agent: agentId, state }, 'channel-credentials: drift between the channel files and the adopted record')
      recordTokenShadow(
        { method: 'SWEEP', route: '/channel-credentials/drift', client: 'none', caller: agentId, callerSource: 'none' },
        { category: CHANNEL_DRIFT_CATEGORY, target: state },
        nowSec,
      )
      try {
        await send(formatDriftAlarm(agentId, state))
      } catch (err) {
        logger.warn({ err, agent: agentId }, 'channel-credentials: drift alarm could not be delivered')
      }
    }
    return state
  } catch (err) {
    logger.warn({ err, agent: agentId }, 'channel-credentials: drift check failed')
    return null
  }
}

/** One pass over every recorded channel. */
export async function checkAllChannelDrift(nowSec?: number, send?: (text: string) => Promise<boolean>): Promise<void> {
  for (const b of listChannelCredentialBaselines()) {
    await checkChannelDrift(b.agent_id, nowSec, send)
  }
}

/** Agents that have a channel on disk but no adoption: the server cannot send for them yet. */
export function listUnadoptedChannelAgents(): string[] {
  const out: string[] = []
  for (const name of [MAIN_AGENT_ID, ...listAgentNames()]) {
    if (out.includes(name) || hasAdoption(name)) continue
    try {
      readFileSync(join(channelDirForAgent(name), '.env'), 'utf8')
      out.push(name)
    } catch { /* no channel */ }
  }
  return out
}

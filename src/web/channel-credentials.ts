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
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
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
  // Exactly one assignment: with two, which one the plugin ends up with depends on its parser, so
  // the file is not trusted as a source for either.
  if ((envText.match(/^TELEGRAM_BOT_TOKEN=/gm) ?? []).length !== 1) return null
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

/**
 * Pure: every entry an access.json names, valid or not, tagged by where it stands (DM list or
 * group). This is what the drift hash covers, so an entry that chatsFromAccessConfig drops (a malformed
 * id) still counts: adding or removing one is a change of the file even though it widens nothing.
 */
export function accessEntries(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const o = raw as Record<string, unknown>
  const out: string[] = []
  if (Array.isArray(o.allowFrom)) for (const v of o.allowFrom) out.push(`allow:${typeof v}:${String(v)}`)
  if (o.groups && typeof o.groups === 'object' && !Array.isArray(o.groups)) for (const k of Object.keys(o.groups as Record<string, unknown>)) out.push(`group:${k}`)
  return out
}

/** Hash of the access entries. Order does not matter: the plugin may append or reorder without changing who is paired. */
export function chatsHash(entries: readonly string[]): string {
  return sha256(JSON.stringify([...entries].sort()))
}

export const tokenHash = sha256

interface ChannelFiles {
  token: string | null
  /** The valid chat ids, in file order (what gets adopted). */
  chats: string[]
  /** Every entry of the file, valid or not (what the drift hash covers). */
  entries: string[]
}

const MAX_CHANNEL_FILE_BYTES = 64 * 1024

/**
 * Reads a small regular file the agent can write, without following a symlink and without trusting its
 * size: a link to another file, a device or a FIFO is refused instead of read (a FIFO would block the
 * server), and anything over MAX_CHANNEL_FILE_BYTES is refused.
 */
function readChannelFile(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    // a second name for the file is how another agent's .env is made to look like one's own
    if (st.nlink > 1) throw new Error('file has more than one link')
    if (st.size > MAX_CHANNEL_FILE_BYTES) throw new Error('file too large')
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n === 0) break
      off += n
    }
    return buf.toString('utf8', 0, off)
  } finally {
    closeSync(fd)
  }
}

/**
 * The channel directory must really be inside its owner's tree. A symlink anywhere on the way (the
 * channels dir, .claude, the agent dir itself) can point it into another agent's directory, and the
 * files read from there would be that agent's bot. The real path has to stay inside the real path of
 * the container (the agent's own directory; for the main agent the channels base), and a sub-agent's
 * directory has to be the one that carries its name. Throws when it does not.
 */
function assertDirBelongsToAgent(agentId: string, dir: string): void {
  const isMain = agentId === MAIN_AGENT_ID
  const container = realpathSync(isMain ? dirname(dir) : agentDir(agentId))
  const real = realpathSync(dir)
  if (!real.startsWith(container + sep)) throw new Error('channel directory leaves its owner')
  if (!isMain && basename(container) !== agentId) throw new Error('agent directory is not the agent\'s own')
}

/** Reads the channel's files. Throws when a file cannot be read or access.json is not JSON. */
function readChannelFiles(agentId: string): ChannelFiles {
  const dir = channelDirForAgent(agentId)
  assertDirBelongsToAgent(agentId, dir)
  const token = parseEnvBotToken(readChannelFile(join(dir, '.env')))
  const access = JSON.parse(readChannelFile(join(dir, 'access.json'))) as unknown
  return { token, chats: chatsFromAccessConfig(access), entries: accessEntries(access) }
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
  | { ok: true; agentId: string; chats: string[]; replacedToken: boolean; botId: string }
  | { ok: false; reason: 'invalid_agent' | 'unreadable' | 'no_token' | 'token_in_use' }

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
  // One bot, one agent: a token already recorded for another agent means this agent's .env points at
  // someone else's bot (a copied or linked file), and adopting it would let this agent's server sends
  // go out on that bot.
  const hash = tokenHash(files.token)
  if (listChannelCredentialBaselines().some((b) => b.agent_id !== agentId && b.token_sha256 === hash)) {
    return { ok: false, reason: 'token_in_use' }
  }
  const previous = getChannelBotToken(agentId)
  setSecret(channelTokenSecretId(agentId), `Channel bot token (${CHANNEL_PROVIDER}) of ${agentId}`, files.token)
  adoptChannelCredential({
    agentId,
    provider: CHANNEL_PROVIDER,
    chatIds: files.chats,
    tokenSha256: hash,
    allowSha256: chatsHash(files.entries),
    adoptedBy,
  })
  return { ok: true, agentId, chats: files.chats, replacedToken: previous !== null && previous !== files.token, botId: files.token.split(':')[0] }
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
  files: { token: string | null; entries: readonly string[] },
): ChannelDriftState {
  const tokenDiffers = files.token === null || tokenHash(files.token) !== baseline.token_sha256
  const accessDiffers = chatsHash(files.entries) !== baseline.allow_sha256
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
    if (existsSync(join(channelDirForAgent(name), '.env'))) out.push(name)
  }
  return out
}

// ── the periodic check ──────────────────────────────────────────────────────

/** Same cadence as the blackboard stale sweeper it runs beside. */
const DRIFT_SWEEP_INTERVAL_MS = 5 * 60_000
/** First check shortly after start, once the server is up, instead of waiting a whole interval. */
const DRIFT_FIRST_CHECK_DELAY_MS = 10_000

/**
 * Starts the drift check: once soon after boot and then every sweep interval. Also logs, once at
 * start, the agents that have a channel on disk but no adoption: the server cannot send for them
 * until the owner adopts. The returned timer is the interval (the caller clears it on shutdown).
 */
export function startChannelCredentialDriftSweeper(): NodeJS.Timeout {
  const run = (): void => {
    checkAllChannelDrift().catch((err) => logger.warn({ err }, 'channel-credentials: drift sweep failed'))
  }
  const first = setTimeout(() => {
    run()
    try {
      const unadopted = listUnadoptedChannelAgents()
      if (unadopted.length > 0) {
        logger.warn({ agents: unadopted }, 'channel-credentials: channels without an adopted record, server voice sends are refused for them until POST /api/channel-credentials/adopt')
      }
    } catch (err) {
      logger.warn({ err }, 'channel-credentials: unadopted listing failed')
    }
  }, DRIFT_FIRST_CHECK_DELAY_MS)
  first.unref()
  return setInterval(run, DRIFT_SWEEP_INTERVAL_MS)
}

// The sender gate of the channel coordinator: DEFAULT-DENY, with the same source of truth as the native Telegram plugin, its
// access.json (allowFrom, dmPolicy, groups). One list, not a second one in the database: a second list would drift.
//
// The coordinator polls with the same bot token while the native channel is down, so without a gate a stranger who messages the
// bot during an outage would reach the main agent in the same frame as the owner. An update that does not pass is DROPPED
// SILENTLY: nothing is stored, nothing is handed off, and nothing is sent back. In particular there is NO pairing reply (the
// plugin answers an unknown DM with a pairing code in `pairing` mode; the coordinator must not, or the backfill path becomes a
// reply oracle), and this module never writes the access file.
//
// The rule mirrors the plugin's gate, minus the pairing and the mention check:
//   - dmPolicy "disabled": nothing passes.
//   - no sender (a channel post, an update without `from`): dropped.
//   - a private chat (Telegram: a DM has a positive chat id, and the chat id equals the user id): passes when the sender is in
//     allowFrom.
//   - a group (a negative chat id): passes only when the group is configured in `groups`, and the sender is in the group's own
//     allowFrom when that list is not empty. The plugin additionally requires a mention in a group by default; the coordinator
//     cannot judge a mention from a stored row, so it passes a message of a CONFIGURED group (the body stays untrusted).
//   - anything else: dropped.
// FAIL CLOSED: a missing, unreadable or malformed file, or an allowFrom that is not a list, lets NOTHING pass, with one log line
// per distinct failure (not one per batch). The file is read on every call, so a change of the list applies without a restart.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'

export interface SenderAccess {
  dmPolicy: string
  allowFrom: string[]
  groups: Record<string, { allowFrom: string[] }>
}

/** The access file of the native plugin: its state directory (TELEGRAM_STATE_DIR, as the plugin reads it) or the default. */
export function accessFilePath(): string {
  const dir = process.env['TELEGRAM_STATE_DIR']?.trim() || join(homedir(), '.claude', 'channels', 'telegram')
  return join(dir, 'access.json')
}

function ids(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' && typeof v !== 'number') return null
    out.push(String(v))
  }
  return out
}

let lastFailure: string | null = null

/** One log line per distinct failure, and one line when the file is good again; never a value from the file. */
function failClosed(reason: string): null {
  if (lastFailure !== reason) {
    lastFailure = reason
    logger.error({ reason }, 'channel-coordinator: sender gate cannot read the access list, every update is dropped (fail closed)')
  }
  return null
}

/** The access list, or null when it cannot be trusted (the caller drops everything). Reads the file; never writes it. */
export function loadSenderAccess(path: string = accessFilePath()): SenderAccess | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return failClosed((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'access file missing' : 'access file unreadable')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failClosed('access file is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return failClosed('access file is not an object')
  const obj = parsed as Record<string, unknown>
  const allowFrom = ids(obj['allowFrom'])
  if (allowFrom === null) return failClosed('allowFrom is not a list of ids')
  const groups: SenderAccess['groups'] = {}
  const rawGroups = obj['groups']
  if (rawGroups !== undefined) {
    if (typeof rawGroups !== 'object' || rawGroups === null || Array.isArray(rawGroups)) return failClosed('groups is not an object')
    for (const [id, policy] of Object.entries(rawGroups as Record<string, unknown>)) {
      const own = typeof policy === 'object' && policy !== null ? (policy as Record<string, unknown>)['allowFrom'] : undefined
      const list = own === undefined ? [] : ids(own)
      if (list === null) return failClosed('a group allowFrom is not a list of ids')
      groups[id] = { allowFrom: list }
    }
  }
  if (lastFailure !== null) {
    lastFailure = null
    logger.info('channel-coordinator: sender gate reads the access list again')
  }
  return { dmPolicy: typeof obj['dmPolicy'] === 'string' ? obj['dmPolicy'] : 'pairing', allowFrom, groups }
}

/** Test-only: forgets the last failure, so the next failure logs again. */
export function resetSenderGateForTests(): void {
  lastFailure = null
}

/** Whether an update from this chat and user may be ingested. `access` null (unreadable list) is a drop. */
export function isSenderAllowed(access: SenderAccess | null, who: { chat_id: number | null; user_id: number | null }): boolean {
  if (access === null) return false
  if (access.dmPolicy === 'disabled') return false
  if (who.chat_id === null || who.user_id === null) return false
  const sender = String(who.user_id)
  if (who.chat_id > 0) return access.allowFrom.includes(sender)
  if (who.chat_id < 0) {
    const group = access.groups[String(who.chat_id)]
    if (group === undefined) return false
    return group.allowFrom.length === 0 || group.allowFrom.includes(sender)
  }
  return false
}

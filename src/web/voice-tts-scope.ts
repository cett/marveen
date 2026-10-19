// Which channel a fleet agent's token may speak on (POST /api/voice/tts).
//
// The route takes the channel's state dir and the chat id from the request body. For the admin
// principals that stays as it was; for a fleet_agent token it would let any agent speak through
// any other agent's bot, to any chat (a tenant-boundary crossing and an impersonation). So a
// fleet_agent may name only a state dir that is ITS OWN channel, and only a chat the owner paired on
// that channel (access.json allowFrom). Both checks fail closed.

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { AGENTS_BASE_DIR } from './agent-config.js'

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/

export interface ChannelBases {
  /** <install>/agents: a sub-agent's own channel lives at <agentsBase>/<id>/.claude/channels/<provider>. */
  agentsBase: string
  /** ~/.claude/channels: the main agent's is <channelsBase>/<provider>, the alternative naming <provider>-<id>. */
  channelsBase: string
  mainAgentId: string
}

function defaultBases(): ChannelBases {
  return { agentsBase: AGENTS_BASE_DIR, channelsBase: join(homedir(), '.claude', 'channels'), mainAgentId: MAIN_AGENT_ID }
}

/**
 * Pure: is `stateDir` a channel directory of `agentId`? The same three places
 * resolveAgentChannelStateDir looks in, and nothing else. Any '..' is a no.
 */
export function agentOwnsStateDir(agentId: string, stateDir: string, bases: ChannelBases = defaultBases()): boolean {
  if (!AGENT_ID_RE.test(agentId)) return false
  const dir = stateDir.replace(/\/+$/, '')
  if (dir.includes('..')) return false
  const agentsBase = bases.agentsBase.replace(/\/+$/, '')
  const channelsBase = bases.channelsBase.replace(/\/+$/, '')

  if (dir.startsWith(agentsBase + '/')) {
    const m = /^([a-zA-Z0-9_-]+)\/\.claude\/channels\/[a-zA-Z0-9_-]+$/.exec(dir.slice(agentsBase.length + 1))
    return m !== null && m[1] === agentId
  }
  if (dir.startsWith(channelsBase + '/')) {
    const rest = dir.slice(channelsBase.length + 1)
    // <provider>: the main agent's channel
    if (/^[A-Za-z0-9]+$/.test(rest)) return agentId === bases.mainAgentId
    // <provider>-<agentId>: the alternative naming of a sub-agent's channel
    const m = /^[A-Za-z0-9]+-([a-zA-Z0-9_-]+)$/.exec(rest)
    return m !== null && m[1] === agentId
  }
  return false
}

/**
 * The same question asked of the real filesystem: the directory as named AND where it really
 * points (a symlink from an agent's own channel path to another agent's directory is the one way
 * the name check alone is fooled). Fails closed when the path cannot be resolved.
 */
export function agentOwnsStateDirOnDisk(agentId: string, stateDir: string, bases: ChannelBases = defaultBases()): boolean {
  if (!agentOwnsStateDir(agentId, stateDir, bases)) return false
  try {
    const real = realpathSync(stateDir)
    const realBases: ChannelBases = {
      agentsBase: realpathSync(bases.agentsBase),
      channelsBase: realpathSync(bases.channelsBase),
      mainAgentId: bases.mainAgentId,
    }
    return agentOwnsStateDir(agentId, real, realBases)
  } catch {
    return false
  }
}

/**
 * Is `chatId` one the owner paired on this channel (<stateDir>/access.json, allowFrom)? An unreadable
 * or malformed file, or a missing allowFrom, is a no.
 */
export function chatIsPaired(stateDir: string, chatId: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) as { allowFrom?: unknown }
    if (!Array.isArray(parsed.allowFrom)) return false
    return parsed.allowFrom.some((v) => (typeof v === 'string' || typeof v === 'number') && String(v) === chatId)
  } catch {
    return false
  }
}

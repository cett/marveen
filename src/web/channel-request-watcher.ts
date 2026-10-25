import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import { upsertChannelRequest, listPendingChannelRequests, updateChannelRequestName } from '../db.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

interface AuditEntry {
  type?: string
  reason?: string
  channel?: string
  user?: string
  ts?: string
  botMentioned?: boolean
}

const fileOffsets = new Map<string, number>()

async function scanAuditLog(agent: string, auditPath: string): Promise<void> {
  if (!existsSync(auditPath)) return

  const buf = readFileSync(auditPath)
  const currentSize = buf.length
  const lastOffset = fileOffsets.get(auditPath) ?? 0
  if (currentSize <= lastOffset) return

  const newContent = buf.subarray(lastOffset).toString('utf-8')
  fileOffsets.set(auditPath, currentSize)

  for (const line of newContent.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as AuditEntry
      if (entry.type === 'gate.inbound.drop' && entry.reason === 'channel-not-allowed' && entry.botMentioned && entry.channel) {
        const inserted = await upsertChannelRequest(agent, entry.channel, entry.user)
        if (inserted) {
          logger.info({ agent, channel: entry.channel, user: entry.user }, 'New channel request from audit log')
          lookupChannelName(agent, entry.channel).catch(() => {})
        }
      }
    } catch {
      // malformed line
    }
  }
}

const channelNameCache = new Map<string, { name: string | null; ts: number }>()
const CHANNEL_CACHE_TTL = 300_000
const NEGATIVE_CACHE_TTL = 60_000

async function lookupChannelName(agent: string, channelId: string): Promise<void> {
  const cached = channelNameCache.get(channelId)
  if (cached) {
    const ttl = cached.name ? CHANNEL_CACHE_TTL : NEGATIVE_CACHE_TTL
    if (Date.now() - cached.ts < ttl) return
  }

  const provider = resolveAgentProvider(agent)
  if (provider !== 'slack') return
  const stateDir = channelStateDir(provider, agentDir(agent))
  const token = readChannelToken(provider, join(stateDir, '.env'))
  if (!token) return

  try {
    const resp = await fetch('https://slack.com/api/conversations.info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: `channel=${encodeURIComponent(channelId)}`,
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['slack']),
    })
    const data = await resp.json() as { ok: boolean; channel?: { name: string } }
    if (data.ok && data.channel?.name) {
      channelNameCache.set(channelId, { name: data.channel.name, ts: Date.now() })
      const pending = await listPendingChannelRequests(agent)
      const match = pending.find(r => r.channel_id === channelId && !r.channel_name)
      if (match) await updateChannelRequestName(match.id, data.channel.name)
    }
  } catch (err) {
    channelNameCache.set(channelId, { name: null, ts: Date.now() })
    logger.warn({ err, agent, channelId }, 'Failed to look up Slack channel name')
  }
}

async function runScanTick(): Promise<void> {
  const activeAgents = new Set<string>()
  for (const name of listAgentNames()) {
    const provider = resolveAgentProvider(name)
    if (provider !== 'slack') continue
    const stateDir = channelStateDir(provider, agentDir(name))
    const auditPath = join(stateDir, 'audit.jsonl')
    activeAgents.add(auditPath)
    await scanAuditLog(name, auditPath)
    for (const req of await listPendingChannelRequests(name)) {
      if (!req.channel_name) lookupChannelName(name, req.channel_id).catch(() => {})
    }
  }
  for (const key of fileOffsets.keys()) {
    if (!activeAgents.has(key)) fileOffsets.delete(key)
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null

// One tick at a time: scanAuditLog advances the file offset before its awaits, and an interval callback cannot
// be awaited, so the guarded tick owns the try/catch (a rejection would be an unhandled rejection) and a slow
// tick makes the next one skip instead of overlapping it.
let tickRunning = false
async function guardedScanTick(): Promise<void> {
  if (tickRunning) return
  tickRunning = true
  try {
    await runScanTick()
  } catch (err) {
    logger.error({ err }, 'Channel request scan tick failed')
  } finally {
    tickRunning = false
  }
}

export async function startChannelRequestWatcher(intervalMs = 10_000): Promise<void> {
  if (intervalId) return
  // Claim the interval before the first await: a second start() during the first tick must see it and return.
  intervalId = setInterval(() => { void guardedScanTick() }, intervalMs)
  await guardedScanTick()
  logger.info({ intervalMs }, 'Channel request watcher started')
}

export function stopChannelRequestWatcher(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}

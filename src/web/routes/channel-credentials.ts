// /api/channel-credentials -- the server-side record of a channel's bot token and paired chats.
//
// GET  /api/channel-credentials          what is adopted per agent (chat ids, drift state; never a token),
//                                        and the agents that have a channel but no adoption yet
// POST /api/channel-credentials/adopt    { agent_id } record the channel's files as they stand now
// POST /api/channel-credentials/check    { agent_id? } run the drift check now (one agent, or all)
//
// Admin only (the RBAC table leaves the route unlisted, which resolves to admin:all; the handlers check
// the role again). A fleet_agent token must not reach any of it: adopting is the owner vouching for the
// files, which is exactly what an agent that can write them must not be able to do for itself.

import { readBody, json } from '../http-helpers.js'
import { getChannelCredentialBaseline, listAdoptedChats, listChannelCredentialBaselines } from '../../db.js'
import {
  CHANNEL_PROVIDER,
  adoptChannel,
  checkAllChannelDrift,
  checkChannelDrift,
  isValidChannelAgentId,
  listUnadoptedChannelAgents,
} from '../channel-credentials.js'
import type { RouteContext } from './types.js'

const BASE = '/api/channel-credentials'

function summary(agentId: string): Record<string, unknown> | null {
  const b = getChannelCredentialBaseline(agentId, CHANNEL_PROVIDER)
  if (!b) return null
  return {
    agent_id: agentId,
    provider: b.provider,
    chats: listAdoptedChats(agentId, CHANNEL_PROVIDER),
    adopted_by: b.adopted_by,
    adopted_at: b.adopted_at,
    last_checked_at: b.last_checked_at,
    drift_state: b.drift_state,
    drift_since: b.drift_since,
  }
}

async function readJsonBody(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  const body = await readBody(ctx.req)
  if (body.length === 0) return {}
  try {
    const parsed = JSON.parse(body.toString()) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function tryHandleChannelCredentials(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== BASE && !path.startsWith(BASE + '/')) return false

  if (ctx.role !== 'admin') {
    json(res, { error: 'forbidden', hint: 'Channel credentials are admin only' }, 403)
    return true
  }

  if (path === BASE && method === 'GET') {
    const adopted = listChannelCredentialBaselines().map((b) => summary(b.agent_id)).filter((s) => s !== null)
    json(res, { adopted, unadopted: listUnadoptedChannelAgents() })
    return true
  }

  if (path === BASE + '/adopt' && method === 'POST') {
    const data = await readJsonBody(ctx)
    if (!data) { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const agentId = typeof data.agent_id === 'string' ? data.agent_id.trim() : ''
    if (!agentId) { json(res, { error: 'required', field: 'agent_id', hint: 'agent_id required' }, 400); return true }
    if (!isValidChannelAgentId(agentId)) { json(res, { error: 'invalid_value', field: 'agent_id', hint: 'Invalid agent_id' }, 400); return true }
    const adoptedBy = ctx.auth?.user ?? ctx.auth?.tokenName ?? 'admin'
    const result = adoptChannel(agentId, adoptedBy)
    if (!result.ok) {
      const hint = result.reason === 'no_token'
        ? 'No bot token in the agent\'s channel .env'
        : 'The agent\'s channel files (.env, access.json) could not be read'
      json(res, { error: 'not_found', field: 'agent_id', hint }, 404)
      return true
    }
    json(res, { ok: true, agent_id: agentId, chats: result.chats, replaced_token: result.replacedToken })
    return true
  }

  if (path === BASE + '/check' && method === 'POST') {
    const data = await readJsonBody(ctx)
    if (!data) { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const agentId = typeof data.agent_id === 'string' ? data.agent_id.trim() : ''
    if (agentId) {
      if (!isValidChannelAgentId(agentId)) { json(res, { error: 'invalid_value', field: 'agent_id', hint: 'Invalid agent_id' }, 400); return true }
      const state = await checkChannelDrift(agentId)
      if (state === null) { json(res, { error: 'not_found', field: 'agent_id', hint: 'Channel not adopted' }, 404); return true }
      json(res, { ok: true, agent_id: agentId, drift_state: state })
      return true
    }
    await checkAllChannelDrift()
    json(res, { ok: true, adopted: listChannelCredentialBaselines().map((b) => summary(b.agent_id)).filter((s) => s !== null) })
    return true
  }

  return false
}

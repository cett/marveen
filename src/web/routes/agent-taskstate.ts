import { readBody, json } from '../http-helpers.js'
import { denyForeignAgent } from '../fleet-agent-identity.js'
import {
  readTaskState,
  writeTaskState,
  markConsumed,
  clearTaskState,
  shouldReplayTaskState,
  isTrustedTaskStateWriter,
  buildTaskStateInjection,
  buildNoTaskStateNote,
} from '../agent-taskstate.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// Who is writing, from the authenticated context only: the agent the token belongs to (the
// main agent's own token names the main agent), else the dashboard session user, else the
// shared token. Never the body, never X-Agent-Id (the caller's own claim).
function taskStateWriter(ctx: RouteContext): string {
  if (ctx.tokenAgentId) return ctx.tokenAgentId
  if (ctx.auth?.kind === 'session' && ctx.auth.user) return `session:${ctx.auth.user}`
  return 'shared'
}

// Endpoints for the compact task-state re-injection feature (#4).
//  POST   /api/agent-taskstate/:agent          <- PreCompact agent-hook writes the record
//  GET    /api/agent-taskstate/:agent/replay   <- SessionStart hook: returns inject text (does NOT consume)
//  POST   /api/agent-taskstate/:agent/consume  <- SessionStart hook: mark consumed AFTER a successful inject
//  DELETE /api/agent-taskstate/:agent          <- explicit task-done clear
//
// All gated by the dashboard token in web.ts. The read->inject->consume split
// is deliberate (Marveen): if the hook reads but dies before printing, the
// record stays consumed=false so the next start still catches it.

export async function tryHandleAgentTaskState(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Every variant names the agent in its first path segment; a fleet_agent token reaches only its own.
  const anyMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)/)
  if (anyMatch) {
    let named: string
    try { named = decodeURIComponent(anyMatch[1]) } catch { json(res, { error: 'invalid_value', field: 'agent', hint: 'Malformed percent-encoding in path' }, 400); return true }
    if (denyForeignAgent(ctx, named)) return true
  }

  const replayMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/replay$/)
  if (replayMatch && method === 'GET') {
    const agent = decodeURIComponent(replayMatch[1])
    const source = url.searchParams.get('source') || ''
    const record = readTaskState(agent)
    const now = Date.now()
    // A live record from a writer we do not trust is refused AND marked used: left
    // unconsumed, a forged fresh record would keep the context-restart gate blocked
    // for its whole freshness window. The log line carries no record content.
    if (record && !record.consumed && !isTrustedTaskStateWriter(record)) {
      logger.warn({ agent: record.agent, writer: record.writer }, 'agent-taskstate: record from an untrusted writer refused')
      markConsumed(agent)
    }
    const inject = shouldReplayTaskState(record, source, now)
      ? buildTaskStateInjection(record!, now)
      : buildNoTaskStateNote(source)
    json(res, { additionalContext: inject })
    return true
  }

  const consumeMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    markConsumed(decodeURIComponent(consumeMatch[1]))
    json(res, { ok: true })
    return true
  }

  const baseMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)$/)
  if (baseMatch && method === 'POST') {
    const agent = decodeURIComponent(baseMatch[1])
    const body = await readBody(req)
    let fields: Record<string, unknown>
    try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400); return true }
    const record = writeTaskState(agent, {
      doneSteps: fields.doneSteps as string[] | undefined,
      alreadyDelegated: fields.alreadyDelegated as string[] | undefined,
      nextAction: fields.nextAction as string | undefined,
      pendingDecision: fields.pendingDecision as string | undefined,
      summary: fields.summary as string | undefined,
    }, Date.now(), taskStateWriter(ctx))
    json(res, { ok: true, record })
    return true
  }

  if (baseMatch && method === 'GET') {
    json(res, readTaskState(decodeURIComponent(baseMatch[1])))
    return true
  }

  if (baseMatch && method === 'DELETE') {
    clearTaskState(decodeURIComponent(baseMatch[1]))
    json(res, { ok: true })
    return true
  }

  return false
}

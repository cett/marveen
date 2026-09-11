import { logToolCall, analyzeWorkflowCandidates, getRecentToolCalls } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleToolLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/tool-log -- log a tool call (from PostToolUse hook). logToolCall
  // is the sole writer of the resulting `tool.call` OTel span (trace_id =
  // session_id, span_id = the CC-native tool_use_id) -- see src/db/audit.ts.
  if (path === '/api/tool-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      session_id: string
      tool_name: string
      input_summary?: string
      success?: boolean
      agent_id?: string
      trace_id?: string
      duration_ms?: number
    }
    if (!data.session_id || !data.tool_name) { json(res, { error: 'required', hint: 'session_id and tool_name required' }, 400); return true }
    const success = data.success !== false
    logToolCall(data.session_id, data.tool_name, data.input_summary ?? null, success, data.agent_id ?? null, data.trace_id ?? null, data.duration_ms ?? null)
    json(res, { ok: true })
    return true
  }

  // GET /api/tool-log -- recent tool calls
  if (path === '/api/tool-log' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '3600')
    json(res, getRecentToolCalls(since))
    return true
  }

  // GET /api/tool-log/analyze -- workflow candidates
  if (path === '/api/tool-log/analyze' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '3600')
    const minCalls = parseInt(url.searchParams.get('min_calls') || '5')
    const gapSecs = parseInt(url.searchParams.get('gap') || '300')
    const candidates = analyzeWorkflowCandidates(since, minCalls, gapSecs)
    // Return summarized form (without full tool_calls array to keep response small)
    const summary = candidates.map(c => ({
      session_id: c.session_id,
      tool_count: c.tool_calls.length,
      duration_minutes: c.duration_minutes,
      start_ts: c.start_ts,
      end_ts: c.end_ts,
      tools: [...new Set(c.tool_calls.map(t => t.tool_name))],
      steps_preview: c.tool_calls.slice(0, 10).map(t => ({
        tool: t.tool_name,
        description: t.input_summary || t.tool_name,
      })),
    }))
    json(res, summary)
    return true
  }

  return false
}

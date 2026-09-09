import { logToolCall, analyzeWorkflowCandidates, getRecentToolCalls, pruneToolCallLog, upsertOtelSpan } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// mcp__<server>__<tool> -- split into (server, tool) for the OTel span
// attributes. mcp_server alone shipped in F2; F4 (#800) adds mcp_tool
// alongside it -- the "realistic MCP correlation" scope from Rick's plan
// (full W3C trace propagation into STDIO MCP servers isn't possible; a
// tool.call span attribute an operator can grep an MCP server's own logs
// against is what's actually achievable). Non-MCP tool names (Bash, Read,
// ...) don't match and get neither attribute. Server names with their own
// underscores (e.g. mcp__plugin_telegram_telegram__reply) are handled
// correctly because the split is on the FIRST "__" -- same behavior F2
// already had, just also captures what follows it.
function mcpServerAndToolFromToolName(toolName: string): { server: string; tool: string } | undefined {
  const m = toolName.match(/^mcp__([^_].*?)__(.+)$/)
  return m ? { server: m[1], tool: m[2] } : undefined
}

export async function tryHandleToolLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/tool-log -- log a tool call (from PostToolUse hook)
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

    // OTel F2 (#800/#803): one tool.call span per logged call. The hook only
    // fires once, after the tool already finished, so this is an
    // upsert-and-close in one shot rather than a separate open+close pair.
    // trace_id = session_id groups every tool call (and, from F3 onward,
    // model-call/agent-turn spans) from one Claude Code session under one
    // trace; span_id = the CC-native tool_use_id (already unique per call,
    // same value tool_call_log stores as its own `trace_id` column).
    if (data.trace_id && data.agent_id) {
      const endMs = Date.now()
      const startMs = typeof data.duration_ms === 'number' ? endMs - data.duration_ms : endMs
      const mcp = mcpServerAndToolFromToolName(data.tool_name)
      upsertOtelSpan({
        trace_id: data.session_id,
        span_id: data.trace_id,
        parent_span_id: null,
        agent_id: data.agent_id,
        operation: `tool.${data.tool_name}`,
        start_ms: startMs,
        end_ms: endMs,
        status: success ? 'ok' : 'error',
        attributes: JSON.stringify({
          tool_name: data.tool_name,
          ...(mcp ? { mcp_server: mcp.server, mcp_tool: mcp.tool } : {}),
        }),
      })
    }

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

  // POST /api/tool-log/prune -- cleanup old entries
  if (path === '/api/tool-log/prune' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { older_than_secs?: number }
    pruneToolCallLog(data.older_than_secs ?? 86400)
    json(res, { ok: true })
    return true
  }

  return false
}

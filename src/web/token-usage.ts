import { statSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolveAgentTenant, getTokenUsageCursor, setTokenUsageCursor, recordTokenUsageCalls } from '../db.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Claude Code encodes a project's absolute path into a directory name by
// replacing every non-alphanumeric/non-dash character with `-`. The main
// agent's transcripts live under that exact directory, regardless of what
// the agent calls itself.
function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, '-')
}

interface AgentTranscriptSource {
  agent: string
  projectDir: string
}

function discoverAgentSources(): AgentTranscriptSource[] {
  const sources: AgentTranscriptSource[] = []
  if (!existsSync(PROJECTS_DIR)) return sources
  const mainDirName = encodeProjectPath(PROJECT_ROOT)
  for (const entry of readdirSync(PROJECTS_DIR)) {
    const full = join(PROJECTS_DIR, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isDirectory()) continue

    const agentMatch = entry.match(/-agents-([a-z0-9-]+)$/)
    if (agentMatch) {
      sources.push({ agent: agentMatch[1], projectDir: full })
    } else if (entry === mainDirName) {
      sources.push({ agent: MAIN_AGENT_ID, projectDir: full })
    }
  }
  return sources
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  function scanDir(d: string) {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry)
      if (entry.endsWith('.jsonl')) {
        files.push(full)
      } else {
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) {
          scanDir(full)
        }
      }
    }
  }

  scanDir(dir)
  return files
}

interface ParsedCall {
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Tokens in thinking content blocks (estimated from char length / 4). */
  thinkingTokens: number
  /** Model identifier from the API response, e.g. "claude-sonnet-5". */
  model: string | null
  contentPreview: string
  toolName: string | null
  /** The API message id (msg_...). One assistant turn that calls a tool is
   *  written to the transcript as SEVERAL `assistant` lines sharing this id --
   *  a text block (tool_name=null) plus one line per tool_use block -- and EACH
   *  carries the SAME cumulative `usage`. Counting each line would double (or
   *  triple) the turn's tokens, which is exactly the dashboard-inflation bug.
   *  Used only to collapse those lines back into one row; not persisted. */
  messageId?: string | null
}

/**
 * Collapse transcript rows that belong to the same assistant turn (same
 * message id) into a single row, so a tool-calling turn is counted ONCE.
 *
 * Usage is identical across a turn's lines, so we take the max per field
 * (defensive against a partial/streaming line) rather than summing. The tool
 * name and preview are filled from whichever line carries them. Rows without a
 * message id (older transcripts) pass through untouched. Pure + order-stable
 * for unit testing.
 */
export function collapseByMessageId(calls: ParsedCall[]): ParsedCall[] {
  const byId = new Map<string, ParsedCall>()
  const out: ParsedCall[] = []
  for (const c of calls) {
    if (!c.messageId) { out.push(c); continue }
    const ex = byId.get(c.messageId)
    if (!ex) {
      const copy = { ...c }
      byId.set(c.messageId, copy)
      out.push(copy)
      continue
    }
    ex.inputTokens = Math.max(ex.inputTokens, c.inputTokens)
    ex.outputTokens = Math.max(ex.outputTokens, c.outputTokens)
    ex.cacheReadTokens = Math.max(ex.cacheReadTokens, c.cacheReadTokens)
    ex.cacheCreationTokens = Math.max(ex.cacheCreationTokens, c.cacheCreationTokens)
    ex.thinkingTokens = Math.max(ex.thinkingTokens, c.thinkingTokens)
    if (!ex.model && c.model) ex.model = c.model
    if (!ex.toolName && c.toolName) ex.toolName = c.toolName
    if (!ex.contentPreview && c.contentPreview) ex.contentPreview = c.contentPreview
  }
  return out
}

async function parseJsonlFile(
  filePath: string,
  agent: string,
  fromLine: number,
): Promise<{ calls: ParsedCall[]; linesRead: number }> {
  const calls: ParsedCall[] = []
  let lineNum = 0
  let sessionId = ''

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    lineNum++
    if (lineNum <= fromLine) continue
    if (!line.trim()) continue

    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.sessionId) {
      sessionId = obj.sessionId
    }

    if (obj.type !== 'assistant' || !obj.message?.usage) continue

    const u = obj.message.usage
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
    if (!ts) continue

    let preview = ''
    const content = obj.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          preview = block.text.slice(0, 200)
          break
        }
      }
    } else if (typeof content === 'string') {
      preview = content.slice(0, 200)
    }

    let toolName: string | null = null
    let thinkingTokens = 0
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && !toolName) {
          toolName = block.name
        }
        // Estimate thinking tokens from char length (no per-block count in API)
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          thinkingTokens += Math.ceil(block.thinking.length / 4)
        }
      }
    }

    calls.push({
      agent,
      sessionId: sessionId || basename(filePath, '.jsonl'),
      timestamp: Math.floor(ts / 1000),
      inputTokens: (u.input_tokens || 0),
      outputTokens: (u.output_tokens || 0),
      cacheReadTokens: (u.cache_read_input_tokens || 0),
      cacheCreationTokens: (u.cache_creation_input_tokens || 0),
      thinkingTokens,
      model: obj.message?.model || null,
      contentPreview: preview,
      toolName,
      messageId: obj.message?.id || null,
    })
  }

  // Collapse the multi-line tool-turn rows (same message id, repeated usage)
  // before they reach the DB -- this is the fix for the ~2x token inflation.
  return { calls: collapseByMessageId(calls), linesRead: lineNum }
}

export async function collectTokenUsage(): Promise<{ inserted: number; files: number }> {
  const sources = discoverAgentSources()
  let totalInserted = 0
  let totalFiles = 0

  for (const source of sources) {
    // Resolved once per source (constant for every call parsed from this
    // agent's transcripts) so a later tenant_agent_availability change is
    // picked up on the agent's next collection run, not just at first insert.
    const tenantId = resolveAgentTenant(source.agent)
    const files = findJsonlFiles(source.projectDir)
    for (const file of files) {
      let fileSize: number
      try { fileSize = statSync(file).size } catch { continue }

      const cursor = getTokenUsageCursor(file)
      if (cursor && cursor.last_size === fileSize) continue

      const fromLine = (cursor && cursor.last_size <= fileSize) ? cursor.last_line : 0

      try {
        const { calls, linesRead } = await parseJsonlFile(file, source.agent, fromLine)

        if (calls.length > 0) {
          recordTokenUsageCalls(calls, tenantId, file, linesRead, fileSize)
          totalInserted += calls.length
        } else {
          setTokenUsageCursor(file, linesRead, fileSize)
        }
        totalFiles++
      } catch (err) {
        logger.warn({ err, file }, 'Token usage parse failed')
      }
    }
  }

  return { inserted: totalInserted, files: totalFiles }
}

export {
  getTokenSummary,
  getModelDistribution,
  getToolStats,
  getTokenTimeline,
  getTokenDetails,
  correlateWithKanban,
} from '../db.js'
export type {
  TokenSummaryModelRow,
  TokenSummary,
  ModelDistEntry,
  ToolStatEntry,
  TimelineBucket,
  TokenDetail,
} from '../db.js'

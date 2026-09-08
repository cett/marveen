/**
 * "Fleet-only agents" tenant-isolation policy.
 *
 * The Marveen HTTP API enforces `WHERE tenant_id = ...` on its own data (see
 * the tenant-scoping work across src/web/routes/*.ts), but an EXTERNAL MCP
 * server (GitHub, GitLab, Hetzner, a filesystem server, GA4...) has no
 * tenant_id concept at all -- there is no query to filter. Handing an agent
 * that carries one of these to a B2B tenant is a structural cross-tenant
 * exposure that cannot be closed at the data layer, only prevented by policy:
 * this module classifies which of an agent's configured MCP servers carry
 * that risk, so a tenant-assignment endpoint can gate on it (see
 * PUT /api/admin/agent-availability in admin-b2b.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentConfigRoot } from './agent-config.js'

/**
 * MCP servers whose credential exposes data/infrastructure with no tenant
 * boundary of its own. Exact server names as they appear as keys under
 * mcpServers in an agent's .mcp.json.
 */
const HIGH_RISK_MCP_SERVERS = new Set(['hetzner', 'github', 'gitlab', 'filesystem'])

/**
 * True for any GA4 server instance (`ga4`, `ga4-aimit`, a future per-tenant
 * `ga4-<property>`...) -- GA4 credentials are property-scoped per agent
 * already, but the risk classification applies to the whole family, not one
 * hardcoded name (see the Phase 1 [B] per-tenant-GA4-agent policy note).
 */
function isGa4Server(serverName: string): boolean {
  return serverName === 'ga4' || serverName.startsWith('ga4-')
}

export function isHighRiskMcpServer(serverName: string): boolean {
  return HIGH_RISK_MCP_SERVERS.has(serverName) || isGa4Server(serverName)
}

/**
 * The mcpServers keys configured for an agent's project-scoped .mcp.json
 * (agentConfigRoot() already resolves the main agent's special case: its
 * config lives at PROJECT_ROOT, not agents/<name>/). Best-effort: a missing
 * file, unreadable file, or malformed JSON all resolve to [] rather than
 * throwing -- this is a policy CHECK, not a config loader, and must never be
 * the reason a tenant-availability write fails outright.
 */
export function getAgentMcpServers(agentName: string): string[] {
  let mcpPath: string
  try {
    mcpPath = join(agentConfigRoot(agentName), '.mcp.json')
  } catch {
    return []
  }
  if (!existsSync(mcpPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') return []
    return Object.keys(parsed.mcpServers)
  } catch {
    return []
  }
}

/** The subset of an agent's configured MCP servers considered high-risk. */
export function getHighRiskMcpServersForAgent(agentName: string): string[] {
  return getAgentMcpServers(agentName).filter(isHighRiskMcpServer)
}

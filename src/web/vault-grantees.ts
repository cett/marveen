// Grantee names of the per-secret allowlist (vault_secret_acl, migration 0090) and the
// validation of an allowlist a caller sends.
//
// A grantee is `agent:<id>` or one of the three reserved scopes. The prefix keeps an agent
// name and a scope from ever colliding: an agent called "user" is `agent:user`, never
// `scope:user`. Which MCP file belongs to which grantee is decided in vault-bindings.ts
// (granteeOfMcpFile); this module only knows the names and the shape rules.
//
// Pure: no I/O, no config. The known agent ids come in as an argument so the route can pass
// the live list (the sub-agents plus the main agent) and a test can pass its own.

export const SCOPE_GRANTEES = ['scope:project', 'scope:user', 'scope:external'] as const

/** More than this many entries is a malformed request, not a big team. */
export const MAX_ACL_ENTRIES = 50

// Same charset the agent ids have everywhere else; a path segment that does not match is never an agent.
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function agentGrantee(agentId: string): string {
  return `agent:${agentId}`
}

export type AllowListResult =
  | { ok: true, allow: string[] }
  | { ok: false, hint: string }

/**
 * Checks the `allow` array of a PUT: an array of at most 50 entries, each `agent:<id>` of a
 * KNOWN agent or one of the three scopes. Returns the entries de-duplicated in the order sent.
 * An empty array is valid (it opens the secret). The hint never echoes the offending entry.
 */
export function parseAllowList(raw: unknown, knownAgentIds: readonly string[]): AllowListResult {
  if (!Array.isArray(raw)) return { ok: false, hint: 'allow must be an array of grantees' }
  if (raw.length > MAX_ACL_ENTRIES) return { ok: false, hint: `allow holds at most ${MAX_ACL_ENTRIES} entries` }
  const known = new Set(knownAgentIds)
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, hint: 'every allow entry must be a string' }
    if ((SCOPE_GRANTEES as readonly string[]).includes(entry)) {
      if (!out.includes(entry)) out.push(entry)
      continue
    }
    if (!entry.startsWith('agent:')) {
      return { ok: false, hint: 'every allow entry must be agent:<id> or one of scope:project, scope:user, scope:external' }
    }
    const id = entry.slice('agent:'.length)
    if (!AGENT_ID_PATTERN.test(id) || !known.has(id)) {
      return { ok: false, hint: 'allow names an agent that does not exist' }
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return { ok: true, allow: out }
}

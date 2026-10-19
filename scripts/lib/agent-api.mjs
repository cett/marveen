// Which bearer token an .mjs consumer presents to the dashboard API, and a small client on top.
// Same contract as scripts/agent-api.sh and scripts/hooks/agent_token.py (the three are held in
// step by their tests): the agent's own token, or nothing. There is NO fallback to the shared
// dashboard token: a missing own token resolves to source 'none' with an `error` naming the fix.
// A present-but-refused token (401) is the server's business and is never retried on another one.
// Nothing here throws on a missing file, logs, or puts the token anywhere but the Authorization header.
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE_AGENT = 'agent'
export const SOURCE_OPERATOR = 'operator'
export const SOURCE_NONE = 'none'

function readTrim(path) {
  try { return readFileSync(path, 'utf-8').trim() } catch { return '' }
}

export function installDir() {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

function mainAgentId(install, env) {
  const v = (env.MAIN_AGENT_ID || '').trim()
  if (v) return v
  for (const line of readTrim(join(install, '.env')).split('\n')) {
    if (line.startsWith('MAIN_AGENT_ID=')) return line.slice('MAIN_AGENT_ID='.length).trim().replace(/^["']|["']$/g, '') || null
  }
  return null
}

/** <install>/agents/<id>[/...] -> id; the install root -> the main agent; anything else -> null. */
export function agentIdFromCwd(cwd, install = installDir(), env = process.env) {
  const root = install.replace(/\/+$/, '')
  const c = (cwd ?? process.cwd()).replace(/\/+$/, '')
  const agents = join(root, 'agents') + '/'
  if (c.startsWith(agents)) return c.slice(agents.length).split('/')[0] || null
  if (c === root) return mainAgentId(root, env)
  return null
}

/**
 * The identity the spawner gave this process, for a working directory that names nobody (a
 * worktree, a scratch directory): MARVEEN_AGENT_ID, else CLAUDE_CONFIG_DIR -- <install>/agents/<id>/.claude-config
 * is that agent's, <install>/.channels-config the main agent's. Set at launch, not by a later `cd`.
 */
export function agentIdFromEnv(install = installDir(), env = process.env) {
  const v = (env.MARVEEN_AGENT_ID || '').trim()
  if (v) return v
  const cfg = (env.CLAUDE_CONFIG_DIR || '').trim()
  if (!cfg) return null
  const root = install.replace(/\/+$/, '')
  const c = normalize(cfg).replace(/\/+$/, '')
  const agents = join(root, 'agents') + '/'
  if (c.startsWith(agents)) {
    const parts = c.slice(agents.length).split('/')
    return parts.length >= 2 && parts[0] && parts[1] === '.claude-config' ? parts[0] : null
  }
  const main = join(root, '.channels-config')
  return c === main || c.startsWith(main + '/') ? mainAgentId(root, env) : null
}

export function agentTokenPath(agentId, install = installDir(), env = process.env) {
  return agentId === mainAgentId(install, env)
    ? join(install, '.agent-token')
    : join(install, 'agents', agentId, '.agent-token')
}

export const ADMIN_ONLY_MESSAGE = 'this call needs admin rights and only the main agent holds them: ask the main agent to make it (an inter-agent message through /api/messages)'

export function missingTokenMessage(agentId, install = installDir(), env = process.env) {
  if (!agentId) {
    return 'cannot tell which agent this is (no agent id from the arguments, the working directory or MARVEEN_AGENT_ID / CLAUDE_CONFIG_DIR) and so which token file to read; set MARVEEN_AGENT_ID or run it as the agent'
  }
  return `no readable own token for agent '${agentId}' (${agentTokenPath(agentId, install, env)}); the operator issues it with: npm run agent-tokens -- issue ${agentId}`
}

/**
 * kind: 'agent' (own token) | 'operator' (store/.operator-token) | 'main' (act as the main agent
 * whoever runs it: system scripts) | 'admin' (an admin:all call whoever makes it: the main agent's own
 * token; every other agent gets source 'none' and ADMIN_ONLY_MESSAGE). There is no fallback to the
 * shared dashboard token and no 'shared' kind: a missing own token is source 'none' plus `error`.
 * Returns { token, source, agentId, error, headers(base) }.
 */
export function resolveToken({ agentId, cwd, kind = 'agent', installDir: install = installDir(), storeDir, env = process.env } = {}) {
  const store = storeDir ?? join(install, 'store')
  let id = agentId || agentIdFromCwd(cwd, install, env) || agentIdFromEnv(install, env)
  if (id && (id.includes('/') || id.startsWith('.'))) id = null
  const make = (token, source, error = null) => ({
    token, source, agentId: id ?? null, error,
    headers(base = {}) {
      const h = { ...base }
      if (token) h.Authorization = `Bearer ${token}`
      if (id) h['X-Agent-Id'] = id
      return h
    },
    toString() { return `Resolved(source=${source}, agentId=${id ?? null})` },
    toJSON() { return { source, agentId: id ?? null } },
  })

  if (kind === 'main') { id = mainAgentId(install, env) ?? id; kind = 'agent' }
  if (kind === 'admin') {
    if (!(id && id === mainAgentId(install, env))) return make('', SOURCE_NONE, ADMIN_ONLY_MESSAGE)
    kind = 'agent'
  }
  if (kind === 'operator') {
    const path = join(store, '.operator-token')
    const t = readTrim(path)
    return t ? make(t, SOURCE_OPERATOR)
      : make('', SOURCE_NONE, `no readable operator token (${path}); the operator issues it with: npm run agent-tokens -- issue-operator`)
  }
  if (kind !== 'agent') return make('', SOURCE_NONE, `unsupported token kind '${kind}' (agent, operator, admin or main)`)

  const explicit = (env.MARVEEN_AGENT_TOKEN_FILE || '').trim()
  const own = explicit ? readTrim(explicit) : (id ? readTrim(agentTokenPath(id, install, env)) : '')
  return own ? make(own, SOURCE_AGENT) : make('', SOURCE_NONE, missingTokenMessage(id, install, env))
}

function baseUrl(install, env) {
  if (env.DASHBOARD_BASE_URL) return env.DASHBOARD_BASE_URL.replace(/\/+$/, '')
  let port = env.MARVEEN_WEB_PORT || env.WEB_PORT
  if (!port) {
    for (const line of readTrim(join(install, '.env')).split('\n')) {
      if (line.startsWith('WEB_PORT=')) { port = line.slice('WEB_PORT='.length).trim().replace(/^["']|["']$/g, ''); break }
    }
  }
  return `http://localhost:${port || 3420}`
}

/**
 * agentApi(method, path, body?, opts?) -> { status, ok, body }. body is parsed JSON when the
 * response is JSON, the text otherwise. Rejects only when the request got no answer at all.
 * opts: agentId, cwd, kind, timeoutMs (default 2000), plus the resolveToken test seams.
 */
export async function agentApi(method, path, body, opts = {}) {
  const env = opts.env ?? process.env
  const install = opts.installDir ?? installDir()
  const auth = resolveToken({ ...opts, installDir: install, env })
  const res = await fetch(baseUrl(install, env) + path, {
    method,
    headers: auth.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
  })
  const text = await res.text()
  let parsed = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* keep the text */ }
  return { status: res.status, ok: res.ok, body: parsed }
}

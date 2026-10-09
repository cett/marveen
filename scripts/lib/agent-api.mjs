// Which bearer token an .mjs consumer presents to the dashboard API, and a small client on top.
// Same contract as scripts/agent-api.sh and scripts/hooks/agent_token.py (the three are held in
// step by their tests): the agent's own token first, then the shared dashboard token as an
// explicit, visible fallback (the request carries X-Agent-Id), then nothing. A present-but-refused
// token (401) is never retried on the shared one. Nothing here throws on a missing file, logs, or
// puts the token anywhere but the Authorization header.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE_AGENT = 'agent'
export const SOURCE_FALLBACK = 'shared-fallback'
export const SOURCE_SHARED = 'shared'
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

export function agentTokenPath(agentId, install = installDir(), env = process.env) {
  return agentId === mainAgentId(install, env)
    ? join(install, '.agent-token')
    : join(install, 'agents', agentId, '.agent-token')
}

/**
 * kind: 'agent' (own token, shared fallback) | 'operator' (store/.operator-token, same fallback) |
 * 'shared' (the shared token on purpose, for endpoints that are still admin:all), 'main' (act as the
 * main agent whoever runs it: system scripts), 'admin' (an
 * admin:all call whoever makes it: the main agent's own token, everybody else the shared one).
 * Returns { token, source, agentId, headers(base) }.
 */
export function resolveToken({ agentId, cwd, kind = 'agent', installDir: install = installDir(), storeDir, env = process.env } = {}) {
  const store = storeDir ?? join(install, 'store')
  let id = agentId || agentIdFromCwd(cwd, install, env)
  if (id && (id.includes('/') || id.startsWith('.'))) id = null
  if (kind === 'main') { id = mainAgentId(install, env) ?? id; kind = 'agent' }
  if (kind === 'admin') kind = id && id === mainAgentId(install, env) ? 'agent' : 'shared'
  const shared = () => readTrim(join(store, '.dashboard-token'))
  const make = (token, source) => ({
    token, source, agentId: id ?? null,
    headers(base = {}) {
      const h = { ...base }
      if (token) h.Authorization = `Bearer ${token}`
      if (id) h['X-Agent-Id'] = id
      return h
    },
    toString() { return `Resolved(source=${source}, agentId=${id ?? null})` },
    toJSON() { return { source, agentId: id ?? null } },
  })

  if (kind === 'shared') { const t = shared(); return make(t, t ? SOURCE_SHARED : SOURCE_NONE) }

  let own, ownSource
  if (kind === 'operator') {
    own = readTrim(join(store, '.operator-token')); ownSource = SOURCE_OPERATOR
  } else {
    const explicit = (env.MARVEEN_AGENT_TOKEN_FILE || '').trim()
    own = explicit ? readTrim(explicit) : (id ? readTrim(agentTokenPath(id, install, env)) : '')
    ownSource = SOURCE_AGENT
  }
  if (own) return make(own, ownSource)
  const t = shared()
  return t ? make(t, SOURCE_FALLBACK) : make('', SOURCE_NONE)
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

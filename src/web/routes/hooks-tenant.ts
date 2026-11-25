import { readBody, json } from '../http-helpers.js'
import { tenantSkillDirName } from '../skill-regen.js'
import {
  getHookContext, getHookTenantFacts, listHookTenantSkills, recordHookContext,
  type HookSource,
} from '../../db/hook-tenant-reads.js'
import type { RouteContext } from './types.js'

// /api/v1/hooks/* - what the tenant gates of the hooks (stdlib Python, no database driver) ask the dashboard in PG mode.
//   POST /api/hooks/tenant-facts   <- tenant-context.py   {sources:[{kind:'channel',channel,external_id}|{kind:'message',msg_id}]}
//   PUT  /api/hooks/tenant-context <- tenant-context.py   {status, tenant_id, source, session_id}   (the caller's own row)
//   POST /api/hooks/skill-gate     <- tenant-skill-gate.py {targets:[{kind:'skill'|'dir', value, folded}]}
// The route returns FACTS, never a verdict: the policy stays in the hook (tenant_context_lib.py).
// WHO: the agent is the one the TOKEN names (ctx.tokenAgentId), never a query or body parameter: an `agent_id` in the body is
// ignored. A caller whose token names no agent (a dashboard session, the operator token, a tenant user) gets a 403.
// RBAC: hook-gate:read / hook-gate:write (admin and fleet_agent only); the table row is pinned by hooks-tenant-route.test.ts.

const MAX_SOURCES = 20
const MAX_TARGETS = 50
const MAX_STR = 256
const MAX_FOLDED = 1024
const MAX_SOURCE_DESC = 500
const MAX_SESSION = 200
const STATUSES = new Set(['bound', 'default', 'unknown', 'conflict'])
// What a skill's owner reads as when it is not the caller's own tenant: not a tenant id, so it equals no context tenant.
const OTHER_TENANT = '*'

function bad(ctx: RouteContext, field: string, hint: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint }, 400)
  return true
}

function callerAgent(ctx: RouteContext): string | null {
  const id = ctx.tokenAgentId
  if (!id) {
    json(ctx.res, { error: 'forbidden', hint: 'The hook routes need a token that names an agent' }, 403)
    return null
  }
  return id
}

async function readObject(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readBody(ctx.req)).toString())
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    json(ctx.res, { error: 'parse_error', hint: 'Body must be a JSON object' }, 400)
    return null
  }
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !v.includes('\u0000')

function parseSources(raw: unknown): HookSource[] | string {
  if (!Array.isArray(raw) || raw.length > MAX_SOURCES) return `sources must be a list of at most ${MAX_SOURCES}`
  const out: HookSource[] = []
  for (const s of raw as unknown[]) {
    if (s === null || typeof s !== 'object') return 'a source must be an object'
    const o = s as Record<string, unknown>
    if (o['kind'] === 'channel' && str(o['channel'], MAX_STR) && str(o['external_id'], MAX_STR)) {
      out.push({ kind: 'channel', channel: o['channel'], external_id: o['external_id'] })
    } else if (o['kind'] === 'message' && Number.isSafeInteger(o['msg_id']) && (o['msg_id'] as number) > 0) {
      out.push({ kind: 'message', msg_id: o['msg_id'] as number })
    } else if (o['kind'] === 'scheduled' && str(o['name'], MAX_STR)) {
      out.push({ kind: 'scheduled', name: o['name'] })
    } else {
      return 'a source must be a channel, message or scheduled source with valid fields'
    }
  }
  return out
}

// The same two reads as tenant_context_lib._frontmatter_name / skill_dir_name.
const FRONTMATTER_RX = /^---\s*\n([\s\S]*?)\n---/
function frontmatterName(content: string | null): string | null {
  const m = FRONTMATTER_RX.exec(content ?? '')
  if (!m) return null
  const nm = /^name:\s*(.+?)\s*$/m.exec(m[1]!)
  return nm ? nm[1]!.trim().replace(/^["']+|["']+$/g, '') : null
}

interface Target { kind: 'skill' | 'dir'; value: string; folded: string }

function parseTargets(raw: unknown): Target[] | string {
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS) return `targets must be a list of at most ${MAX_TARGETS}`
  const out: Target[] = []
  for (const t of raw as unknown[]) {
    if (t === null || typeof t !== 'object') return 'a target must be an object'
    const o = t as Record<string, unknown>
    if ((o['kind'] !== 'skill' && o['kind'] !== 'dir') || !str(o['value'], MAX_STR)) return 'a target needs kind skill|dir and a value'
    // `folded` is value.casefold() computed by the hook (Python's casefold is not JavaScript's toLowerCase: sharp s, long s,
    // ligatures). A skill directory is ASCII, so the lower-case of the directory equals its casefold.
    if (!str(o['folded'], MAX_FOLDED)) return 'a target needs the casefolded value'
    out.push({ kind: o['kind'], value: o['value'], folded: o['folded'] })
  }
  return out
}

export async function tryHandleHooksTenant(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/hooks/tenant-facts' && path !== '/api/hooks/tenant-context' && path !== '/api/hooks/skill-gate') return false

  if (path === '/api/hooks/tenant-facts' && method === 'POST') {
    const agentId = callerAgent(ctx)
    if (!agentId) return true
    const data = await readObject(ctx)
    if (!data) return true
    const sources = parseSources(data['sources'])
    if (typeof sources === 'string') return bad(ctx, 'sources', sources)
    json(res, await getHookTenantFacts(agentId, sources))
    return true
  }

  if (path === '/api/hooks/tenant-context' && method === 'PUT') {
    const agentId = callerAgent(ctx)
    if (!agentId) return true
    const data = await readObject(ctx)
    if (!data) return true
    const status = data['status']
    const tenant = data['tenant_id']
    const source = data['source']
    const session = data['session_id']
    if (typeof status !== 'string' || !STATUSES.has(status)) return bad(ctx, 'status', 'status must be bound, default, unknown or conflict')
    if (typeof tenant !== 'string' || tenant.length > MAX_STR || tenant.includes('\u0000')) return bad(ctx, 'tenant_id', 'tenant_id must be a string')
    // a bound or default context names its tenant; an unknown or conflict one has none (the gate reads an empty tenant as "no tenant")
    if ((status === 'bound' || status === 'default') !== (tenant !== '')) return bad(ctx, 'tenant_id', 'bound and default need a tenant, unknown and conflict carry none')
    if (typeof source !== 'string' || source.length > MAX_SOURCE_DESC || source.includes('\u0000')) return bad(ctx, 'source', `source must be a string of at most ${MAX_SOURCE_DESC} characters`)
    if (session !== undefined && (typeof session !== 'string' || session.length > MAX_SESSION || session.includes('\u0000'))) return bad(ctx, 'session_id', `session_id must be a string of at most ${MAX_SESSION} characters`)
    if (!(await recordHookContext(agentId, status, tenant, source, typeof session === 'string' ? session : ''))) {
      json(res, { error: 'forbidden', hint: 'A context can only name the default tenant (status default) or a tenant this agent serves (status bound)' }, 403)
      return true
    }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/hooks/skill-gate' && method === 'POST') {
    const agentId = callerAgent(ctx)
    if (!agentId) return true
    const data = await readObject(ctx)
    if (!data) return true
    const targets = parseTargets(data['targets'])
    if (typeof targets === 'string') return bad(ctx, 'targets', targets)
    const { context, serves } = await getHookContext(agentId)
    // Only the skills a target names: the hook never receives the catalog, and never a skill's content.
    const skills = []
    for (const s of await listHookTenantSkills()) {
      const dir = tenantSkillDirName(s.id)
      const names = [s.name, frontmatterName(s.content), dir].filter((n): n is string => Boolean(n))
      const hit = targets.some((t) => t.kind === 'skill'
        ? names.includes(t.value)
        : dir !== null && (dir === t.value || dir.toLowerCase() === t.folded))
      if (!hit) continue
      // Data minimisation: the gate only ever compares a skill's owner and grants with the caller's CURRENT tenant, so the answer
      // names that tenant or nothing. Another tenant's id (as owner or as a grantee) never leaves the server.
      const mine = context && context.tenant_id ? context.tenant_id : null
      skills.push({
        id: s.id,
        tenant_id: mine !== null && s.tenant_id === mine ? mine : OTHER_TENANT,
        dir,
        names: [...new Set(names)],
        granted: mine !== null && s.granted.includes(mine) ? [mine] : [],
      })
    }
    json(res, { context, serves, skills })
    return true
  }

  return false
}

// Guard for the agent-identity coverage of the routes (T4-7 inventory). A route a fleet_agent token can
// reach and that takes an agent identifier (a query / body field naming an agent, or an agent in the
// path) must either be watched by the token counter and the enforce gate (WATCHED in token-shadow.ts)
// or hold the caller to its own agent itself (denyForeignAgent / callerMayActAs / actingAgentId /
// tokenAgentId). A new route file of that kind that does neither fails here, with no exception list to
// add it to: watch it, or hold it.
//
// The inventory is derived from the route sources and the RBAC table (checkPermission with a fleet_agent
// token), not written by hand. Set IDENTITY_INVENTORY_OUT=<file> to write it as a markdown table.
//
// Privacy: neutral fixtures only.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPermission } from '../web/authz.js'
import { watchedPrefixes } from '../web/token-shadow.js'
import type { AuthResult } from '../web/auth-gate.js'

const ROUTES_DIR = join(__dirname, '..', 'web', 'routes')
const FLEET: AuthResult = { kind: 'token', role: 'fleet_agent', tenantId: 'default', tokenName: 'fleet_agent:agent-a', agentId: 'agent-a' }
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const HELD_BY_ROUTE = /\b(denyForeignAgent|callerMayActAs|actingAgentId|tokenAgentId)\b/
const QUERY_INPUT = /searchParams\.get\(\s*['"](agent|agent_id|agentId|assignee|from|owner)['"]/g
const BODY_INPUT = /\b(?:data|body|parsed|payload|b|input)\??\.(agent_id|agent|agentId|from|assignee|parent_id)\b/g
// An agent addressed in the path: a capture group right after /api/agents/ (regex route) or the helper that builds those routes.
const PATH_AGENT = /\^\\\/api\\\/agents\\\/\(|matchChannelRoute\(/

/**
 * The /api/agents/:name/* family: a fleet_agent token reaches other agents' profile, channel access list,
 * pairing codes and conversation by name (agents:read), and none of the recorded decisions covers it.
 * Waiting for the coordinator's decision (watch the whole family / only its sensitive sub-routes / leave it
 * out of this change). When it is decided, WATCHED gets the row and this list becomes empty: delete it
 * and the test then asserts [] like any other route.
 */
const PENDING_DECISION: string[] = ['agent-conversation.ts', 'agent-terminal.ts', 'agents-channels.ts', 'agents-crud.ts', 'agents-process.ts', 'agents-skills.ts']

interface Entry { file: string; reachable: string[]; inputs: string[]; watched: boolean; held: boolean }

interface PathHit { path: string; methods: Set<string> | null }

const methodsOn = (text: string): Set<string> => new Set([...text.matchAll(/\bmethod\s*===\s*'([A-Z]+)'/g)].map((m) => m[1]!))

/**
 * The /api paths a route file mentions, each with the methods its own condition names: a literal path on a
 * line with `method === 'X'` is that method; a regex path bound to a name (`const nameMatch = path.match(...)`)
 * takes the methods of every line that uses `nameMatch`. null = the file's methods are all it says.
 */
function literalPaths(src: string): PathHit[] {
  const lines = src.split('\n')
  const out = new Map<string, Set<string> | null>()
  const add = (path: string, methods: Set<string> | null): void => {
    const prev = out.get(path)
    if (prev === undefined) out.set(path, methods)
    else out.set(path, prev === null || methods === null ? null : new Set([...prev, ...methods]))
  }
  for (const line of lines) {
    for (const m of line.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/:.]*)['"`]/g)) {
      const on = methodsOn(line)
      add(m[1]!, on.size > 0 ? on : null)
    }
    for (const m of line.matchAll(/\^\\\/api(?:\\\/(?:[A-Za-z0-9_-]+|\([^)]*\)))*/g)) {
      const path = m[0].replace(/^\^/, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, 'x').replace(/\(\\d\+\)/g, '1').replace(/\([^)]*\)/g, 'x')
      const name = /\bconst\s+(\w+)\s*=/.exec(line)?.[1]
      let methods: Set<string> | null = null
      if (name) {
        const used = new Set<string>()
        for (const other of lines) if (new RegExp(`\\b${name}\\b`).test(other)) methodsOn(other).forEach((x) => used.add(x))
        if (used.size > 0) methods = used
      } else {
        const on = methodsOn(line)
        if (on.size > 0) methods = on
      }
      add(path, methods)
    }
  }
  return [...out].map(([path, methods]) => ({ path, methods }))
}

function prefixOf(path: string): string {
  return path.split('/').slice(0, 3).join('/')
}

function inventory(): Entry[] {
  const watched = new Set(watchedPrefixes())
  const entries: Entry[] = []
  for (const file of readdirSync(ROUTES_DIR).filter((n) => n.endsWith('.ts')).sort()) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf-8')
    if (!src.includes('export async function tryHandle')) continue // a helper module, not a route handler
    // Only the methods the file actually handles: a path a token may GET is not reachable through a PUT-only route.
    const handled = new Set([...src.matchAll(/\bmethod\s*(?:===|!==)\s*'([A-Z]+)'/g)].map((m) => m[1]!))
    const reachable = new Set<string>()
    for (const { path, methods } of literalPaths(src)) {
      for (const method of METHODS) {
        if (methods ? !methods.has(method) : handled.size > 0 && !handled.has(method)) continue
        if (checkPermission(FLEET, method, path).allowed) reachable.add(`${method} ${path}`)
      }
    }
    if (reachable.size === 0) continue
    const inputs = new Set<string>()
    for (const m of src.matchAll(QUERY_INPUT)) inputs.add(`query:${m[1]}`)
    for (const m of src.matchAll(BODY_INPUT)) inputs.add(`body:${m[1]}`)
    if (PATH_AGENT.test(src)) inputs.add('path:agent')
    if (inputs.size === 0) continue
    const prefixes = new Set([...reachable].map((r) => prefixOf(r.split(' ')[1]!)))
    entries.push({
      file,
      reachable: [...reachable].sort(),
      inputs: [...inputs].sort(),
      watched: [...prefixes].every((p) => watched.has(p)),
      held: HELD_BY_ROUTE.test(src),
    })
  }
  return entries
}

describe('route inventory: agent identity inputs reachable by a fleet_agent token', () => {
  const entries = inventory()

  it('finds the routes the counter is known to watch (the scan itself is alive)', () => {
    const files = entries.map((e) => e.file)
    for (const f of ['memories.ts', 'workspace.ts', 'kanban.ts', 'blackboard.ts', 'schedules.ts', 'messages.ts', 'recall.ts', 'daily-log.ts']) {
      expect(files, f).toContain(f)
    }
  })

  it('every such route file is watched by the counter or holds the caller to its own agent', () => {
    const uncovered = entries.filter((e) => !e.watched && !e.held).map((e) => e.file)
    expect(uncovered).toEqual(PENDING_DECISION)
  })

  it('writes the inventory table when asked', () => {
    const out = process.env['IDENTITY_INVENTORY_OUT']
    if (!out) return
    const rows = entries.map((e) => `| ${e.file} | ${e.reachable.length} | ${e.inputs.join(', ')} | ${e.watched ? 'WATCHED' : '-'} | ${e.held ? 'route' : '-'} |`)
    writeFileSync(out, ['| route file | fleet-reachable | identity inputs | counter/gate | held in route |', '|---|---|---|---|---|', ...rows].join('\n') + '\n')
  })
})

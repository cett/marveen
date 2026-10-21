// Under TOKEN_IDENTITY_MODE=enforce a fleet_agent that names no agent reads its own memories
// plus the shared tier (filtered and counted in SQL), not every agent of the tenant. Shadow (the
// default) and every other principal keep the old behaviour. Real in-memory DB, no mocks.
//
// Privacy: neutral fixtures only (agent-a / agent-b are test-local labels).

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, saveAgentMemory } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { tryHandleRecall } from '../web/routes/recall.js'
import { enforcedSelfScope } from '../web/fleet-agent-identity.js'
import type { RouteContext } from '../web/routes/types.js'

interface Ctx { role: NonNullable<RouteContext['role']>; tokenAgentId?: string; identityEnforced?: boolean }

async function call(handler: (c: RouteContext) => Promise<boolean>, path: string, as: Ctx): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as any
  req.method = 'GET'
  req.headers = {}
  setImmediate(() => { req.emit('data', Buffer.alloc(0)); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req, res, path: url.pathname, method: 'GET', url, role: as.role, tenantId: 'default',
    tokenAgentId: as.tokenAgentId, agentId: as.tokenAgentId, identityEnforced: as.identityEnforced,
  } as RouteContext
  await handler(ctx)
  return out
}

const fleetA = (identityEnforced: boolean): Ctx => ({ role: 'fleet_agent', tokenAgentId: 'agent-a', identityEnforced })
const contents = (body: any): string[] => (Array.isArray(body) ? body : body.memories).map((m: any) => m.content).sort()

beforeEach(() => {
  initDatabase(':memory:')
  saveAgentMemory('agent-a', 'a warm', 'warm')
  saveAgentMemory('agent-a', 'a cold', 'cold')
  saveAgentMemory('agent-b', 'b warm', 'warm')
  saveAgentMemory('agent-b', 'b hot', 'hot')
  saveAgentMemory('agent-b', 'b shared', 'shared')
  saveAgentMemory('agent-c', 'c shared', 'shared')
  saveAgentMemory('agent-c', 'c warm', 'warm')
})

describe('enforcedSelfScope', () => {
  it('is the token agent for a fleet_agent in enforce mode, and nothing otherwise', () => {
    expect(enforcedSelfScope(fleetA(true))).toBe('agent-a')
    expect(enforcedSelfScope(fleetA(false))).toBeNull()
    expect(enforcedSelfScope({ role: 'fleet_agent', identityEnforced: true })).toBeNull()
    expect(enforcedSelfScope({ role: 'admin', tokenAgentId: 'agent-a', identityEnforced: true })).toBeNull()
  })
})

describe('GET /api/memories with no agent filter', () => {
  it('shadow mode: the fleet_agent still lists every agent of the tenant (no behaviour change)', async () => {
    const r = await call(tryHandleMemories, '/api/memories?limit=50', fleetA(false))
    expect(contents(r.body)).toEqual(['a cold', 'a warm', 'b hot', 'b shared', 'b warm', 'c shared', 'c warm'])
  })

  it('enforce mode: the fleet_agent gets its own rows plus the shared tier, and the total agrees', async () => {
    const r = await call(tryHandleMemories, '/api/memories?limit=50', fleetA(true))
    expect(contents(r.body)).toEqual(['a cold', 'a warm', 'b shared', 'c shared'])
    expect(r.body.total).toBe(4)
  })

  it('enforce mode: paging is stable and the total never counts another agent\'s private rows', async () => {
    const p1 = await call(tryHandleMemories, '/api/memories?limit=3&offset=0', fleetA(true))
    const p2 = await call(tryHandleMemories, '/api/memories?limit=3&offset=3', fleetA(true))
    expect(p1.body.total).toBe(4)
    expect(p2.body.total).toBe(4)
    expect(p1.body.memories).toHaveLength(3)
    expect(p2.body.memories).toHaveLength(1)
    expect(contents([...p1.body.memories, ...p2.body.memories].map((m: any) => ({ content: m.content })))).toEqual(
      ['a cold', 'a warm', 'b shared', 'c shared'],
    )
  })

  it('enforce mode: a category filter is applied inside the scope', async () => {
    const warm = await call(tryHandleMemories, '/api/memories?category=warm', fleetA(true))
    expect(contents(warm.body)).toEqual(['a warm'])
    const shared = await call(tryHandleMemories, '/api/memories?category=shared', fleetA(true))
    expect(contents(shared.body)).toEqual(['b shared', 'c shared'])
  })

  it('enforce mode: a search with no agent filter is scoped the same way', async () => {
    const r = await call(tryHandleMemories, '/api/memories?q=warm&mode=keyword&limit=50', fleetA(true))
    expect(contents(r.body)).toEqual(['a warm'])
    const shared = await call(tryHandleMemories, '/api/memories?q=shared&mode=keyword&limit=50', fleetA(true))
    expect(contents(shared.body)).toEqual(['b shared', 'c shared'])
  })

  it('the admin principal keeps the whole tenant, enforce or not', async () => {
    for (const identityEnforced of [true, false]) {
      const r = await call(tryHandleMemories, '/api/memories?limit=50', { role: 'admin', tokenAgentId: 'agent-a', identityEnforced })
      expect(contents(r.body)).toHaveLength(7)
    }
  })

  it('naming its own agent changes nothing', async () => {
    const r = await call(tryHandleMemories, '/api/memories?agent=agent-a&limit=50', fleetA(true))
    expect(contents(r.body)).toEqual(['a cold', 'a warm', 'b shared', 'c shared'])
  })
})

describe('GET /api/memories/graph with no agent filter', () => {
  it('enforce mode lists only the caller\'s nodes; shadow and admin keep the tenant', async () => {
    const enforced = await call(tryHandleMemories, '/api/memories/graph', fleetA(true))
    expect(enforced.body.nodes.every((n: any) => n.agent === 'agent-a')).toBe(true)
    expect(enforced.body.nodes.length).toBeGreaterThan(0)
    const shadow = await call(tryHandleMemories, '/api/memories/graph', fleetA(false))
    expect(new Set(shadow.body.nodes.map((n: any) => n.agent))).toEqual(new Set(['agent-a', 'agent-b', 'agent-c']))
    const admin = await call(tryHandleMemories, '/api/memories/graph', { role: 'admin', identityEnforced: true })
    expect(new Set(admin.body.nodes.map((n: any) => n.agent))).toEqual(new Set(['agent-a', 'agent-b', 'agent-c']))
  })
})

describe('GET /api/recall with no agent filter', () => {
  it('enforce mode recalls the caller\'s memories plus the shared tier; shadow recalls every agent', async () => {
    const enforced = await call(tryHandleRecall, '/api/recall?limit=50', fleetA(true))
    const shadow = await call(tryHandleRecall, '/api/recall?limit=50', fleetA(false))
    const names = (body: any): string[] => (body.memories ?? []).map((m: any) => m.content).sort()
    expect(names(enforced.body)).toEqual(['a cold', 'a warm', 'b shared', 'c shared'])
    expect(names(shadow.body)).toHaveLength(7)
  })
})

// The workspace_docs fold-in of GET /api/memories?q=... filters the docs by agent as well as by tenant
// under TOKEN_IDENTITY_MODE=enforce: a fleet_agent only ever gets its own docs back, even when the
// search itself (hybridSearchDocs, mocked here to hand back another agent's doc) does not scope them.
// Admin, session and shadow mode keep every doc the search returned.
//
// Privacy: neutral fixtures only (agent-a / agent-b are test-local labels).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, hybridSearchDocs: vi.fn() }
})

import { initDatabase, hybridSearchDocs, type WorkspaceDocSearchResult } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

const doc = (id: string, agent: string, tenant = 'default'): WorkspaceDocSearchResult =>
  ({ id, title: id, agent_id: agent, tenant_id: tenant, type: 'notes', task_ref: null } as unknown as WorkspaceDocSearchResult)

async function get(path: string, as: { role: NonNullable<RouteContext['role']>; tokenAgentId?: string; identityEnforced?: boolean }) {
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
  await tryHandleMemories(ctx)
  return out
}

const ids = (body: any): string[] => (body.workspace_docs ?? []).map((d: any) => d.id).sort()
const Q = '/api/memories?q=sentinel&include_docs=1'

beforeEach(() => {
  initDatabase(':memory:')
  vi.mocked(hybridSearchDocs).mockReset()
  // An unscoped search: the caller's own doc, another agent's doc, and another tenant's doc of the caller.
  vi.mocked(hybridSearchDocs).mockResolvedValue([doc('own', 'agent-a'), doc('foreign', 'agent-b'), doc('other-tenant', 'agent-a', 'tenant-x')])
})

describe('workspace_docs fold-in agent filter', () => {
  it('under enforce a fleet agent gets only its own docs, whatever the search returned', async () => {
    const r = await get(Q, { role: 'fleet_agent', tokenAgentId: 'agent-a', identityEnforced: true })
    expect(r.status).toBe(200)
    expect(ids(r.body)).toEqual(['own'])
  })

  it('also when the request names another agent (the shared-tier spelling)', async () => {
    const r = await get(`${Q}&agent=agent-b&category=shared`, { role: 'fleet_agent', tokenAgentId: 'agent-a', identityEnforced: true })
    expect(ids(r.body)).toEqual(['own'])
  })

  it('shadow mode does not filter by agent (the tenant filter still applies)', async () => {
    const r = await get(Q, { role: 'fleet_agent', tokenAgentId: 'agent-a', identityEnforced: false })
    expect(ids(r.body)).toEqual(['foreign', 'own'])
  })

  it('an admin keeps every doc the search returned', async () => {
    const r = await get(Q, { role: 'admin' })
    expect(ids(r.body)).toEqual(['foreign', 'other-tenant', 'own'])
  })

  it('a session role without an agent token is not narrowed to one agent', async () => {
    const r = await get(Q, { role: 'viewer', identityEnforced: true })
    expect(ids(r.body)).toEqual(expect.arrayContaining(['own', 'foreign']))
  })
})

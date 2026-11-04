// The main agent's own token names its agent (api_tokens.agent_id is filled in), so the self-approval
// guard of PATCH /api/approvals/:id holds for the main agent too: it cannot resolve the request it
// opened itself under its own token, whatever the body claims. It still resolves other agents' requests.
// Real in-memory database; the route is driven directly.
//
// Mutation proof: delete the `effectiveResolvedBy === target.agent_id` guard in approvals.ts and the
// first test fails (200 instead of 403, and the approval is resolved).

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, createApproval, getApproval } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

const MAIN_TOKEN: Pick<RouteContext, 'role' | 'auth' | 'tokenAgentId'> = {
  role: 'admin', auth: { kind: 'token', tokenName: 'main-agent:main-x' }, tokenAgentId: 'main-x',
}

async function patch(as: Pick<RouteContext, 'role' | 'auth' | 'tokenAgentId'>, id: string, body: object): Promise<{ status: number; body: any }> {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = 'PATCH'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420/api/approvals/${id}`)
  const ctx = { req, res, path: url.pathname, method: 'PATCH', url, ...as, agentId: as.tokenAgentId } as unknown as RouteContext
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('PATCH /api/approvals/:id by the main agent token', () => {
  it('refuses to resolve the main agent\'s own request, even when the body names someone else', async () => {
    await createApproval({ id: 'own-1', agent_id: 'main-x', category: 'file_write', action_description: 'x' })
    for (const body of [{ status: 'approved' }, { status: 'approved', resolved_by: 'someone-else' }, { status: 'rejected', resolved_by: 'dashboard' }]) {
      const r = await patch(MAIN_TOKEN, 'own-1', body)
      expect(r.status, JSON.stringify(body)).toBe(403)
    }
    expect((await getApproval('own-1'))?.status).toBe('pending')
  })

  it('still resolves another agent\'s request, recorded under the agent the token names', async () => {
    await createApproval({ id: 'other-1', agent_id: 'agent-d', category: 'file_write', action_description: 'x' })
    const r = await patch(MAIN_TOKEN, 'other-1', { status: 'approved' })
    expect(r.status).toBe(200)
    expect(await getApproval('other-1')).toMatchObject({ status: 'approved', resolved_by: 'main-x' })
  })
})

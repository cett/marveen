// T4-5: shared_token_refused. After the shared dashboard token is rotated (rotate-shared, or the file
// deleted so the next start draws a fresh one), a process that still holds the old value is refused
// 401 as before; the counter now makes that straggler visible. It counts ONLY the shared token's
// revoked `dashboard` row, never an unknown bearer, never another revoked token, never a valid one.
// Real DB (migrations on :memory:), real recorder, real enrolment/rotation, neutral fixtures.

import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { initDatabase, getDb, enrollDashboardApiToken, insertApiToken, revokeApiToken, getApiTokenRowByHash } from '../db.js'
import {
  TOKEN_SHADOW_CATEGORIES, observeRefusedSharedToken, resetTokenShadowForTests,
} from '../web/token-shadow.js'

const sha = (v: string): string => createHash('sha256').update(v).digest('hex')
const NOW = Math.floor(Date.now() / 1000)

function reqWith(headers: Record<string, string>): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.headers = headers
  return req
}

interface Row { category: string; method: string; route: string; caller: string; caller_source: string; client: string; target: string; count: number }
const refusedRows = (): Row[] =>
  getDb().prepare("SELECT * FROM token_usage_shadow WHERE category = 'shared_token_refused' ORDER BY route, caller").all() as Row[]
const refusedTotal = (): number => refusedRows().reduce((n, r) => n + r.count, 0)

beforeEach(() => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
})

describe('shared_token_refused', () => {
  it('is a category the route accepts', () => {
    expect(TOKEN_SHADOW_CATEGORIES).toContain('shared_token_refused')
  })

  it('counts the shared token once it is rotated away, with the declared caller', async () => {
    await enrollDashboardApiToken(sha('old-shared'), NOW - 100)
    await enrollDashboardApiToken(sha('new-shared'), NOW) // the rotation: the old row is revoked
    expect((await getApiTokenRowByHash(sha('old-shared')))?.revoked_at).not.toBeNull()

    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer old-shared', 'x-agent-id': 'agent-a', 'user-agent': 'curl/8' }), 'POST', '/api/v1/memories')
    expect(refusedRows()).toEqual([
      { day: expect.any(String), category: 'shared_token_refused', method: 'POST', route: '/api/memories', caller: 'agent-a', caller_source: 'self_declared', client: 'curl', target: '', count: 1, last_ts: expect.any(Number) },
    ])
  })

  it('counts a straggler with no X-Agent-Id as nobody', async () => {
    await enrollDashboardApiToken(sha('old-shared'), NOW - 100)
    await enrollDashboardApiToken(sha('new-shared'), NOW)
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer old-shared' }), 'GET', '/api/agents')
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer old-shared' }), 'GET', '/api/agents')
    const rows = refusedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ caller: '', caller_source: 'none', count: 2 })
  })

  it('does not count the CURRENT shared token (it is not refused)', async () => {
    await enrollDashboardApiToken(sha('current'), NOW)
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer current' }), 'GET', '/api/agents')
    expect(refusedTotal()).toBe(0)
  })

  it('does not count an unknown bearer, a missing bearer or a malformed header', async () => {
    await enrollDashboardApiToken(sha('current'), NOW)
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer never-seen' }), 'GET', '/api/agents')
    await observeRefusedSharedToken(reqWith({}), 'GET', '/api/agents')
    await observeRefusedSharedToken(reqWith({ authorization: 'Basic abc' }), 'GET', '/api/agents')
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer ' }), 'GET', '/api/agents')
    expect(refusedTotal()).toBe(0)
  })

  it('does not count another revoked token (only the shared one is the straggler we look for)', async () => {
    await insertApiToken({ tokenHash: sha('agent-token'), name: 'fleet_agent:agent-a', role: 'fleet_agent', tenantId: 'default', createdAt: NOW - 50, expiresAt: null, agentId: 'agent-a' })
    const row = (await getApiTokenRowByHash(sha('agent-token')))!
    await revokeApiToken(row.id, NOW)
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer agent-token', 'x-agent-id': 'agent-a' }), 'GET', '/api/agents')
    expect(refusedTotal()).toBe(0)
  })

  it('never counts its own reading route', async () => {
    await enrollDashboardApiToken(sha('old-shared'), NOW - 100)
    await enrollDashboardApiToken(sha('new-shared'), NOW)
    await observeRefusedSharedToken(reqWith({ authorization: 'Bearer old-shared' }), 'GET', '/api/v1/token-shadow')
    expect(refusedTotal()).toBe(0)
  })

  it('never throws: a counter fault must not become a different answer than the 401', async () => {
    await enrollDashboardApiToken(sha('old-shared'), NOW - 100)
    await enrollDashboardApiToken(sha('new-shared'), NOW)
    getDb().exec('DROP TABLE token_usage_shadow')
    await expect(observeRefusedSharedToken(reqWith({ authorization: 'Bearer old-shared' }), 'GET', '/api/agents')).resolves.toBeUndefined()
  })
})

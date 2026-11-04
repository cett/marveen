// X-Caller-Config: the agent a session was launched as, sent by scripts/agent-api.sh. The shadow counter counts the
// main agent's own token on a call that names ANOTHER agent there (`main_token_from_subagent`, target = that agent).
// It is a measurement signal from the client and never a credential: it changes nothing about a request or a
// response, and a fault in the counting must not reach the request.
//
// Privacy: neutral fixtures only (agent-a, agent-b, agent-main).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { initDatabase, getDb } from '../db.js'
import type { AuthResult } from '../web/auth-gate.js'
import { TOKEN_SHADOW_CATEGORIES, observeTokenUsage, resetTokenShadowForTests } from '../web/token-shadow.js'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'agent-main' }))

const MAIN = 'agent-main'
const mainAdminAuth: AuthResult = { kind: 'token', role: 'admin', tokenName: `admin:${MAIN}`, agentId: MAIN }
const fleetAuth = (agent: string): AuthResult => ({ kind: 'token', role: 'fleet_agent', tenantId: 'default', tokenName: `fleet_agent:${agent}`, agentId: agent })
const operatorAuth: AuthResult = { kind: 'token', role: 'admin', tokenName: 'operator' }
const sessionAuth: AuthResult = { kind: 'session', user: 'user-a', role: 'admin' }

async function observe(auth: AuthResult, headers: Record<string, string | string[]> = {}, path = '/api/kanban'): Promise<void> {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.headers = headers as http.IncomingHttpHeaders
  await observeTokenUsage(req, auth, 'GET', path, new URL(`http://localhost:3420${path}`))
}

interface Row { category: string; caller: string; caller_source: string; target: string; count: number }
const rows = (): Row[] => getDb().prepare("SELECT * FROM token_usage_shadow WHERE category = 'main_token_from_subagent'").all() as Row[]

beforeEach(() => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
})

describe('main_token_from_subagent', () => {
  it('is a counter category', () => {
    expect(TOKEN_SHADOW_CATEGORIES).toContain('main_token_from_subagent')
  })

  it('counts the main agent token on a call launched as another agent, per launched agent', async () => {
    await observe(mainAdminAuth, { 'x-caller-config': 'agent-a' })
    await observe(mainAdminAuth, { 'x-caller-config': 'agent-a' })
    await observe(mainAdminAuth, { 'x-caller-config': 'agent-b' })
    expect(rows().map((r) => [r.caller, r.caller_source, r.target, r.count])).toEqual([
      [MAIN, 'token', 'agent-a', 2],
      [MAIN, 'token', 'agent-b', 1],
    ])
  })

  it('takes the first value of a repeated header and tolerates case and padding', async () => {
    await observe(mainAdminAuth, { 'x-caller-config': [' Agent-A ', 'agent-b'] })
    expect(rows().map((r) => [r.target, r.count])).toEqual([['agent-a', 1]])
  })

  it.each([
    ['the main agent launched as itself', mainAdminAuth, { 'x-caller-config': MAIN }],
    ['no header (an older wrapper, a curl call)', mainAdminAuth, {}],
    ['an empty header', mainAdminAuth, { 'x-caller-config': '  ' }],
    ['a header that is not an agent id', mainAdminAuth, { 'x-caller-config': '../etc' }],
    ['a sub-agent on its own token', fleetAuth('agent-a'), { 'x-caller-config': 'agent-a' }],
    ['a sub-agent token with a different launch agent (not the main token)', fleetAuth('agent-a'), { 'x-caller-config': 'agent-b' }],
    ['the operator token', operatorAuth, { 'x-caller-config': 'agent-a' }],
    ['a session', sessionAuth, { 'x-caller-config': 'agent-a' }],
  ])('counts nothing for %s', async (_label, auth, headers) => {
    await observe(auth, headers)
    expect(rows()).toEqual([])
  })

  it('changes nothing about the request: the headers and the auth result are untouched', async () => {
    const headers = { 'x-caller-config': 'agent-a', 'x-agent-id': MAIN }
    const auth = { ...mainAdminAuth }
    await observe(auth, headers)
    expect(headers).toEqual({ 'x-caller-config': 'agent-a', 'x-agent-id': MAIN })
    expect(auth).toEqual(mainAdminAuth)
  })

  it('a counting fault never reaches the request', () => {
    getDb().exec('DROP TABLE token_usage_shadow')
    expect(() => observe(mainAdminAuth, { 'x-caller-config': 'agent-a' })).not.toThrow()
  })
})

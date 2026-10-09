// Contract tests for scripts/lib/agent-api.mjs (Phase T3 .mjs token resolution + client). The same
// cases as scripts/__tests__/agent-token.test.py and agent-api.test.sh: the three bindings must
// choose the same token. Neutral fixtures only (agent ids a / m, made-up token strings).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error plain .mjs, no declaration file
import * as api from '../lib/agent-api.mjs'

let install: string
const env = (extra: Record<string, string> = {}) => ({ MAIN_AGENT_ID: 'm', ...extra })
const put = (rel: string, text: string) => {
  const p = join(install, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}
const res = (o: Record<string, unknown> = {}) => api.resolveToken({ installDir: install, env: env(), ...o })

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 't3-mjs-'))
  mkdirSync(join(install, 'store'), { recursive: true })
  mkdirSync(join(install, 'agents', 'a'), { recursive: true })
})
afterEach(() => rmSync(install, { recursive: true, force: true }))

describe('resolveToken', () => {
  it('prefers the agent own token over the shared one', () => {
    put('agents/a/.agent-token', 'own-a\n'); put('store/.dashboard-token', 'shared')
    const r = res({ agentId: 'a' })
    expect([r.token, r.source]).toEqual(['own-a', 'agent'])
  })
  it('reads the main agent token from the install root', () => {
    put('.agent-token', 'own-m'); put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'm' }).token).toBe('own-m')
  })
  it('falls back to the shared token when the own file is missing, and names the caller', () => {
    put('store/.dashboard-token', 'shared')
    const r = res({ agentId: 'a' })
    expect([r.token, r.source]).toEqual(['shared', 'shared-fallback'])
    expect(r.headers()['X-Agent-Id']).toBe('a')
  })
  it('treats an empty own file as a miss, not an empty bearer', () => {
    put('agents/a/.agent-token', '  \n'); put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'a' }).source).toBe('shared-fallback')
  })
  it('does not throw when a directory sits where the token file should be', () => {
    mkdirSync(join(install, 'agents', 'a', '.agent-token'))
    put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'a' }).source).toBe('shared-fallback')
  })
  it('sends no Authorization header when nothing is readable', () => {
    const r = res({ agentId: 'a' })
    expect([r.token, r.source]).toEqual(['', 'none'])
    expect(r.headers().Authorization).toBeUndefined()
  })
  it('lets MARVEEN_AGENT_TOKEN_FILE override the agent file, and a missing one still falls back', () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    const p = put('elsewhere/tok', 'explicit')
    expect(api.resolveToken({ installDir: install, agentId: 'a', env: env({ MARVEEN_AGENT_TOKEN_FILE: p }) }).token).toBe('explicit')
    expect(api.resolveToken({ installDir: install, agentId: 'a', env: env({ MARVEEN_AGENT_TOKEN_FILE: join(install, 'nope') }) }).source).toBe('shared-fallback')
  })
  it('kind shared uses the shared token on purpose, kind operator its own file with the same fallback', () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'a', kind: 'shared' }).source).toBe('shared')
    expect(res({ agentId: 'a', kind: 'operator' }).source).toBe('shared-fallback')
    put('store/.operator-token', 'op')
    expect(res({ agentId: 'a', kind: 'operator' }).token).toBe('op')
  })
  it('derives the identity from the cwd, and an unknown cwd is not an identity', () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    expect(res({ cwd: join(install, 'agents', 'a', 'sub') }).token).toBe('own-a')
    expect(api.agentIdFromCwd(install, install, env())).toBe('m')
    const r = res({ cwd: '/some/scratch' })
    expect(r.source).toBe('shared-fallback')
    expect(r.headers()['X-Agent-Id']).toBeUndefined()
  })
  it('refuses path-like agent ids', () => {
    put('store/.dashboard-token', 'shared')
    for (const bad of ['../x', 'a/b', '.hidden']) {
      const r = res({ agentId: bad })
      expect(r.agentId).toBeNull()
      expect(r.source).toBe('shared-fallback')
    }
  })
  it('keeps the token out of String() and JSON', () => {
    put('agents/a/.agent-token', 'super-secret-token')
    const r = res({ agentId: 'a' })
    expect(String(r)).not.toContain('super-secret-token')
    expect(JSON.stringify(r)).not.toContain('super-secret-token')
  })
})

describe('agentApi', () => {
  let server: Server
  let seen: { auth?: string, agent?: string, body: string }[]
  let port: number
  let status = 200
  beforeEach(async () => {
    seen = []; status = 200
    server = createServer((req, rsp) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, agent: req.headers['x-agent-id'] as string | undefined, body: b })
        rsp.writeHead(status, { 'Content-Type': 'application/json' }); rsp.end('{"ok":true}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))
  const call = (method: string, path: string, body?: unknown, o: Record<string, unknown> = {}) =>
    api.agentApi(method, path, body, { installDir: install, env: env({ DASHBOARD_BASE_URL: `http://127.0.0.1:${port}` }), ...o })

  it('sends the own token and parses the JSON body', async () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    const r = await call('POST', '/api/memories', { x: 1 }, { agentId: 'a' })
    expect(r).toEqual({ status: 200, ok: true, body: { ok: true } })
    expect(seen[0]).toEqual({ auth: 'Bearer own-a', agent: 'a', body: '{"x":1}' })
  })
  it('does not retry a refused own token on the shared one', async () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    status = 401
    const r = await call('GET', '/api/agents', undefined, { agentId: 'a' })
    expect(r.status).toBe(401)
    expect(seen).toHaveLength(1)
    expect(seen[0].auth).toBe('Bearer own-a')
  })
  it('marks a fallback request with X-Agent-Id', async () => {
    put('store/.dashboard-token', 'shared')
    await call('GET', '/api/agents', undefined, { agentId: 'a' })
    expect(seen[0]).toMatchObject({ auth: 'Bearer shared', agent: 'a' })
  })
})

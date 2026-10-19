// Contract tests for scripts/lib/agent-api.mjs (Phase T3/T4-5 .mjs token resolution + client). The same
// cases as scripts/__tests__/agent-token.test.py and agent-api.test.sh: the three bindings must
// choose the same token, and none of them ever reads the shared dashboard token. Neutral fixtures only (agent ids a / m, made-up token strings).
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

describe('identity from the launch (a cwd that names nobody)', () => {
  let scratch: string
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 't3-mjs-scratch-'))
    put('agents/a/.agent-token', 'own-a'); put('.agent-token', 'own-m'); put('store/.dashboard-token', 'shared')
  })
  afterEach(() => rmSync(scratch, { recursive: true, force: true }))

  it('a scratch cwd alone is anonymous: no token, an error naming the fix, never the shared token', () => {
    const r = res({ cwd: scratch })
    expect([r.token, r.source, r.agentId]).toEqual(['', 'none', null])
    expect(r.error).toContain('MARVEEN_AGENT_ID')
    expect(r.headers()['X-Agent-Id']).toBeUndefined()
    expect(r.headers().Authorization).toBeUndefined()
  })
  it('the config dir of an agent names it, also below it and with a trailing slash', () => {
    for (const dir of [join(install, 'agents', 'a', '.claude-config'), join(install, 'agents', 'a', '.claude-config', 'projects') + '/']) {
      const r = res({ cwd: scratch, env: env({ CLAUDE_CONFIG_DIR: dir }) })
      expect([r.token, r.source, r.agentId]).toEqual(['own-a', 'agent', 'a'])
    }
  })
  it('the main agent channels config dir names the main agent', () => {
    const r = res({ cwd: scratch, env: env({ CLAUDE_CONFIG_DIR: join(install, '.channels-config') }) })
    expect([r.token, r.agentId]).toEqual(['own-m', 'm'])
  })
  it('names nobody for an agent dir that is no config dir, or another install', () => {
    for (const dir of [join(install, 'agents', 'a', 'notes'), join(install, 'agents', 'a'), join(tmpdir(), 'elsewhere', 'agents', 'a', '.claude-config')]) {
      expect(res({ cwd: scratch, env: env({ CLAUDE_CONFIG_DIR: dir }) }).agentId).toBeNull()
    }
  })
  it('MARVEEN_AGENT_ID wins over the config dir; the working directory and an explicit id win over both', () => {
    const e = env({ MARVEEN_AGENT_ID: 'm', CLAUDE_CONFIG_DIR: join(install, 'agents', 'a', '.claude-config') })
    expect(res({ cwd: scratch, env: e }).agentId).toBe('m')
    expect(res({ cwd: join(install, 'agents', 'a'), env: e }).agentId).toBe('a')
    expect(res({ agentId: 'a', cwd: scratch, env: e }).agentId).toBe('a')
  })
  it('ignores a path-like MARVEEN_AGENT_ID', () => {
    expect(res({ cwd: scratch, env: env({ MARVEEN_AGENT_ID: '../x' }) }).agentId).toBeNull()
  })
})

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
  it('does not fall back to the shared token when the own file is missing: none plus the named fix', () => {
    put('store/.dashboard-token', 'shared')
    const r = res({ agentId: 'a' })
    expect([r.token, r.source]).toEqual(['', 'none'])
    expect(r.error).toContain('agent-tokens -- issue a')
    expect(r.headers().Authorization).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('shared')
  })
  it('treats an empty own file as a miss, not an empty bearer and not the shared token', () => {
    put('agents/a/.agent-token', '  \n'); put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'a' }).source).toBe('none')
  })
  it('does not throw when a directory sits where the token file should be', () => {
    mkdirSync(join(install, 'agents', 'a', '.agent-token'))
    put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'a' }).source).toBe('none')
  })
  it('sends no Authorization header when nothing is readable', () => {
    const r = res({ agentId: 'a' })
    expect([r.token, r.source]).toEqual(['', 'none'])
    expect(r.headers().Authorization).toBeUndefined()
  })
  it('lets MARVEEN_AGENT_TOKEN_FILE override the agent file, and a missing one is none, not the agent file or the shared token', () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    const p = put('elsewhere/tok', 'explicit')
    expect(api.resolveToken({ installDir: install, agentId: 'a', env: env({ MARVEEN_AGENT_TOKEN_FILE: p }) }).token).toBe('explicit')
    expect(api.resolveToken({ installDir: install, agentId: 'a', env: env({ MARVEEN_AGENT_TOKEN_FILE: join(install, 'nope') }) }).source).toBe('none')
  })
  it('there is no shared kind any more, and kind operator has no fallback', () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    const s = res({ agentId: 'a', kind: 'shared' })
    expect([s.token, s.source]).toEqual(['', 'none'])
    expect(s.error).toContain("unsupported token kind 'shared'")
    const o = res({ agentId: 'a', kind: 'operator' })
    expect([o.token, o.source]).toEqual(['', 'none'])
    expect(o.error).toContain('issue-operator')
    put('store/.operator-token', 'op')
    expect(res({ agentId: 'a', kind: 'operator' }).token).toBe('op')
  })
  it('kind admin is the main agent own token; every other agent gets none and the way to ask the main agent', () => {
    put('.agent-token', 'own-m'); put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    expect(res({ agentId: 'm', kind: 'admin' }).token).toBe('own-m')
    const r = res({ agentId: 'a', kind: 'admin' })
    expect([r.token, r.source]).toEqual(['', 'none'])
    expect(r.error).toBe(api.ADMIN_ONLY_MESSAGE)
  })
  it('kind main acts as the main agent whoever runs it', () => {
    put('.agent-token', 'own-m'); put('agents/a/.agent-token', 'own-a')
    const r = res({ agentId: 'a', kind: 'main' })
    expect([r.token, r.agentId]).toEqual(['own-m', 'm'])
  })
  it('derives the identity from the cwd, and an unknown cwd is not an identity', () => {
    put('agents/a/.agent-token', 'own-a'); put('store/.dashboard-token', 'shared')
    expect(res({ cwd: join(install, 'agents', 'a', 'sub') }).token).toBe('own-a')
    expect(api.agentIdFromCwd(install, install, env())).toBe('m')
    const r = res({ cwd: '/some/scratch' })
    expect(r.source).toBe('none')
    expect(r.headers()['X-Agent-Id']).toBeUndefined()
  })
  it('refuses path-like agent ids', () => {
    put('store/.dashboard-token', 'shared')
    for (const bad of ['../x', 'a/b', '.hidden']) {
      const r = res({ agentId: bad })
      expect(r.agentId).toBeNull()
      expect(r.source).toBe('none')
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
  it('sends the request without Authorization, never the shared token, when the own file is missing', async () => {
    put('store/.dashboard-token', 'shared')
    await call('GET', '/api/agents', undefined, { agentId: 'a' })
    expect(seen[0].auth).toBeUndefined()
    expect(seen[0].agent).toBe('a')
  })
})

// `agent-tokens rotate-shared` (T4-5): the shared dashboard token is replaced for good. The old row is
// revoked WITH its hash (so the auth gate can tell "the rotated shared token" from "a stranger"), the new
// value lands in store/.dashboard-token at 0600, and the command refuses while DASHBOARD_TOKEN overrides
// the file. A token value never appears in a result. Real DB and real files in a temp dir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get STORE_DIR() { return join(state.root, 'store') },
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  agentConfigRoot: (name: string) => (name === 'main-agent' ? state.root : join(state.root, 'agents', name)),
}))

import { initDatabase, enrollDashboardApiToken, getApiTokenRowByHash, getDb } from '../db.js'
import { checkAgentTokens, rotateSharedToken, SharedTokenInEnvError } from '../agent-tokens.js'
import { resolveAuth } from '../web/auth-gate.js'
import type http from 'node:http'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sharedFile = () => join(state.root, 'store', '.dashboard-token')
const readShared = () => readFileSync(sharedFile(), 'utf-8').trim()
const NOW = () => Math.floor(Date.now() / 1000)
const activeDashboardRows = () =>
  getDb().prepare("SELECT token_hash FROM api_tokens WHERE name = 'dashboard' AND revoked_at IS NULL").all() as Array<{ token_hash: string }>

let savedEnvDir: string | undefined
let savedEnvToken: string | undefined

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'agent-tokens-rotate-shared-'))
  mkdirSync(join(state.root, 'store'), { recursive: true })
  savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
  savedEnvToken = process.env.DASHBOARD_TOKEN
  process.env.CLAUDECLAW_ENV_DIR = state.root
  delete process.env.DASHBOARD_TOKEN
  initDatabase(':memory:')
})
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR; else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  if (savedEnvToken === undefined) delete process.env.DASHBOARD_TOKEN; else process.env.DASHBOARD_TOKEN = savedEnvToken
})

describe('rotateSharedToken', () => {
  it('replaces the active dashboard row: new file at 0600, old row revoked but kept with its hash', async () => {
    writeFileSync(sharedFile(), 'old-shared-value', { mode: 0o600 })
    await enrollDashboardApiToken(sha('old-shared-value'), NOW() - 500)

    const r = await rotateSharedToken()

    expect(r).toMatchObject({ status: 'rotated', path: sharedFile() })
    const fresh = readShared()
    expect(fresh).not.toBe('old-shared-value')
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
    expect((statSync(sharedFile()).mode & 0o777).toString(8)).toBe('600')
    expect((await getApiTokenRowByHash(sha('old-shared-value')))?.revoked_at).not.toBeNull() // kept, revoked, hash intact
    expect(activeDashboardRows()).toEqual([{ token_hash: sha(fresh) }])
    expect(await getApiTokenRowByHash(sha(fresh))).toMatchObject({ name: 'dashboard', role: 'admin', rotated_from: expect.any(Number) })
  })

  it('never reports a token value', async () => {
    await enrollDashboardApiToken(sha('old'), NOW() - 5)
    const r = await rotateSharedToken()
    expect(JSON.stringify(r)).not.toContain(readShared())
    expect(Object.keys(r).sort()).toEqual(['path', 'status', 'tokenId'])
  })

  it('is unconditional: a second call mints another token, never "kept"', async () => {
    await enrollDashboardApiToken(sha('old'), NOW() - 5)
    await rotateSharedToken()
    const first = readShared()
    expect((await rotateSharedToken()).status).toBe('rotated')
    expect(readShared()).not.toBe(first)
    expect(activeDashboardRows()).toHaveLength(1)
  })

  it('issues one when no dashboard row was active (fresh DB, file missing)', async () => {
    const r = await rotateSharedToken()
    expect(r.status).toBe('issued')
    expect(activeDashboardRows()).toEqual([{ token_hash: sha(readShared()) }])
  })

  it('revokes every other active dashboard row too, so exactly one stays valid', async () => {
    getDb().prepare("INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, 'dashboard', 'admin', 'default', ?)").run(sha('a'), NOW() - 20)
    getDb().prepare("INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, 'dashboard', 'admin', 'default', ?)").run(sha('b'), NOW() - 10)
    await rotateSharedToken()
    expect(activeDashboardRows()).toHaveLength(1)
    expect((await getApiTokenRowByHash(sha('a')))?.revoked_at).not.toBeNull()
    expect((await getApiTokenRowByHash(sha('b')))?.revoked_at).not.toBeNull()
  })

  it('refuses, changing nothing, when DASHBOARD_TOKEN is in the environment', async () => {
    writeFileSync(sharedFile(), 'old-shared-value', { mode: 0o600 })
    await enrollDashboardApiToken(sha('old-shared-value'), NOW() - 5)
    process.env.DASHBOARD_TOKEN = 'from-env'
    await expect(rotateSharedToken()).rejects.toThrow(SharedTokenInEnvError)
    expect(readShared()).toBe('old-shared-value')
    expect(activeDashboardRows()).toEqual([{ token_hash: sha('old-shared-value') }])
  })

  it('refuses when DASHBOARD_TOKEN is in .env', async () => {
    writeFileSync(join(state.root, '.env'), 'DASHBOARD_TOKEN=from-dotenv\n')
    await expect(rotateSharedToken()).rejects.toThrow(SharedTokenInEnvError)
  })

  it('leaves `check` green for the shared token afterwards (file hash = the one active row)', async () => {
    await enrollDashboardApiToken(sha('old'), NOW() - 5)
    await rotateSharedToken()
    expect((await checkAgentTokens([], { includeOperator: false })).rows).toEqual([
      { subject: 'shared', status: 'ok', role: '-', path: sharedFile() },
    ])
  })
})

describe('after the rotation the auth gate refuses the old value everywhere', () => {
  const req = (headers: Record<string, string>) => ({ headers } as unknown as http.IncomingMessage)
  const url = (p: string) => new URL(`http://localhost:3420${p}`)

  it('bearer: the old value is none, the new one is a token', async () => {
    writeFileSync(sharedFile(), 'old-shared-value', { mode: 0o600 })
    await enrollDashboardApiToken(sha('old-shared-value'), NOW() - 5)
    await rotateSharedToken()
    const fresh = readShared()
    const path = '/api/agents'
    expect((await resolveAuth(req({ authorization: 'Bearer old-shared-value' }), url(path), path, 'GET', 'old-shared-value', true)).kind).toBe('none')
    expect((await resolveAuth(req({ authorization: `Bearer ${fresh}` }), url(path), path, 'GET', 'old-shared-value', true)).kind).toBe('token')
  })

  it('SSE ?token=: the old value is refused even while the in-memory copy still holds it', async () => {
    await enrollDashboardApiToken(sha('old-shared-value'), NOW() - 5)
    await rotateSharedToken()
    const path = '/api/agents/alpha/pane/stream'
    const sse = await resolveAuth(req({}), url(`${path}?token=old-shared-value`), path, 'GET', 'old-shared-value', true)
    expect(sse.kind).toBe('none')
    // a padded variant hashes differently but the Bearer comparison trims it: it must not slip past either
    const padded = await resolveAuth(req({}), url(`${path}?token=%20old-shared-value%20`), path, 'GET', 'old-shared-value', true)
    expect(padded.kind).toBe('none')
  })

  it('SSE ?token=: a shared token that was NOT rotated still opens the stream', async () => {
    await enrollDashboardApiToken(sha('current-shared'), NOW() - 5)
    const path = '/api/agents/alpha/pane/stream'
    expect((await resolveAuth(req({}), url(`${path}?token=current-shared`), path, 'GET', 'current-shared', true)).kind).toBe('token')
  })
})

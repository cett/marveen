// Issuing the per-agent token files: 0600, idempotent, rotation, a lost file, the main agent and the
// operator as named admin tokens, and that no token ever shows up in a result.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
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

import { initDatabase, getDb, dbx, ApiTokenAlreadyRevokedError, listApiTokenRows, revokeApiTokensForAgent } from '../db.js'
import { agentTokenPath, issueAgentToken, issueOperatorToken } from '../agent-tokens.js'
import { resolveApiToken } from '../web/auth-gate.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const read = (p: string) => readFileSync(p, 'utf-8').trim()
const mode = (p: string) => statSync(p).mode & 0o777

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'agent-tokens-'))

  mkdirSync(join(state.root, 'agents', 'alpha'), { recursive: true })
  mkdirSync(join(state.root, 'agents', 'beta'), { recursive: true })
  mkdirSync(join(state.root, 'store'), { recursive: true })
  initDatabase(':memory:')
})
afterEach(() => { rmSync(state.root, { recursive: true, force: true }) })

describe('issueAgentToken', () => {
  it('writes a 0600 token file for a fleet agent and registers a fleet_agent row for it', async () => {
    const r = await issueAgentToken('alpha')
    expect(r).toMatchObject({ subject: 'alpha', role: 'fleet_agent', status: 'issued', path: join(state.root, 'agents', 'alpha', '.agent-token') })
    expect(mode(r.path)).toBe(0o600)
    const raw = read(r.path)
    expect(raw).toMatch(/^[0-9a-f]{64}$/)
    expect(await resolveApiToken(raw)).toMatchObject({ found: true, role: 'fleet_agent', agentId: 'alpha' })
    expect(JSON.stringify(r)).not.toContain(raw)
  })

  it('gives each agent its own token', async () => {
    const a = read((await issueAgentToken('alpha')).path)
    const b = read((await issueAgentToken('beta')).path)
    expect(a).not.toBe(b)
    expect(await resolveApiToken(b)).toMatchObject({ found: true, agentId: 'beta' })
  })

  it('is idempotent: a second run keeps the token, makes no row, and tightens a loosened mode', async () => {
    const first = await issueAgentToken('alpha')
    const raw = read(first.path)
    chmodSync(first.path, 0o644)
    const again = await issueAgentToken('alpha')
    expect(again.status).toBe('kept')
    expect(again.tokenId).toBe(first.tokenId)
    expect(read(first.path)).toBe(raw)
    expect(mode(first.path)).toBe(0o600)
    expect((await listApiTokenRows()).filter(r => r.agent_id === 'alpha')).toHaveLength(1)
  })

  it('rotates on request: the new token works, the old one is revoked and the chain is recorded', async () => {
    const first = await issueAgentToken('alpha')
    const old = read(first.path)
    const next = await issueAgentToken('alpha', { rotate: true })
    expect(next.status).toBe('rotated')
    expect(await resolveApiToken(old)).toEqual({ found: false, registeredButInvalid: true })
    expect(await resolveApiToken(read(next.path))).toMatchObject({ found: true, agentId: 'alpha', role: 'fleet_agent' })
    expect((await listApiTokenRows()).find(r => r.id === next.tokenId)?.rotated_from).toBe(first.tokenId)
    expect(mode(next.path)).toBe(0o600)
  })

  it('a lost file is replaced and the unreachable token is revoked, never left valid', async () => {
    const first = await issueAgentToken('alpha')
    const lost = read(first.path)
    writeFileSync(first.path, 'not-a-registered-token\n', { mode: 0o600 })
    const again = await issueAgentToken('alpha')
    expect(again.status).toBe('issued')
    expect(await resolveApiToken(lost)).toEqual({ found: false, registeredButInvalid: true })
    expect((await listApiTokenRows()).filter(r => r.agent_id === 'alpha' && r.revoked_at === null)).toHaveLength(1)
    expect(await resolveApiToken(read(first.path))).toMatchObject({ found: true, agentId: 'alpha' })
  })

  it('a missing agent directory is an error, and no row is left behind', async () => {
    await expect(issueAgentToken('ghost')).rejects.toThrow(/no directory/)
    expect(await listApiTokenRows()).toHaveLength(0)
  })

  it('the main agent gets a NAMED admin token that carries its id, in the project root', async () => {
    const r = await issueAgentToken('main-agent')
    expect(r).toMatchObject({ role: 'admin', status: 'issued', path: join(state.root, '.agent-token') })
    expect(await resolveApiToken(read(r.path))).toMatchObject({ found: true, role: 'admin', agentId: 'main-agent' })
    expect((await listApiTokenRows())[0]?.name).toBe('main-agent:main-agent')
  })

  it('the operator gets its own admin token under store/, naming no agent', async () => {
    const r = await issueOperatorToken()
    expect(r).toMatchObject({ subject: 'operator', role: 'admin', path: join(state.root, 'store', '.operator-token') })
    expect(mode(r.path)).toBe(0o600)
    expect(await resolveApiToken(read(r.path))).toMatchObject({ found: true, role: 'admin', agentId: null })
  })

  it('revoking an agent kills its token at once (what deleting the agent does)', async () => {
    const raw = read((await issueAgentToken('beta')).path)
    expect(await revokeApiTokensForAgent('beta', Math.floor(Date.now() / 1000))).toBe(1)
    expect(await resolveApiToken(raw)).toEqual({ found: false, registeredButInvalid: true })
  })

  it('leaves no temp file next to the token and knows its path without issuing', async () => {
    await issueAgentToken('alpha')
    expect(readdirSync(join(state.root, 'agents', 'alpha')).filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(agentTokenPath('alpha')).toBe(join(state.root, 'agents', 'alpha', '.agent-token'))
    expect(existsSync(agentTokenPath('beta'))).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM api_tokens').get()).toEqual({ n: 1 })
    expect(sha('x')).toHaveLength(64)
  })
})

// issue() reads the active rows, writes the token file, then rotates in one transaction. Another caller can
// revoke the matching row between the read and the transaction; the rotation then finds it revoked, and the
// whole call must fail (the CLI prints FAILED, agent creation logs a warning) instead of minting a second
// active token next to the winner's.
describe('issueAgentToken: a rotation that loses to a concurrent revoke', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('rejects with the typed error and leaves no new active token', async () => {
    const first = await issueAgentToken('alpha')
    const before = (await listApiTokenRows()).length
    const original = dbx.tx.bind(dbx)
    vi.spyOn(dbx, 'tx').mockImplementationOnce((fn, opts) => {
      // The concurrent caller wins: it revokes the row this call is about to rotate.
      getDb().prepare('UPDATE api_tokens SET revoked_at = 1 WHERE id = ?').run(first.tokenId)
      return original(fn, opts)
    })

    await expect(issueAgentToken('alpha', { rotate: true })).rejects.toBeInstanceOf(ApiTokenAlreadyRevokedError)

    expect(await listApiTokenRows()).toHaveLength(before)
    expect((await listApiTokenRows()).filter(r => r.agent_id === 'alpha' && r.revoked_at === null)).toHaveLength(0)
  })
})

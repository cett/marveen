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

import { initDatabase, getDb, dbx, listApiTokenRows, revokeApiTokensForAgent } from '../db.js'
import { agentTokenPath, checkAgentTokens, issueAgentToken, issueOperatorToken } from '../agent-tokens.js'
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

const activeRows = async (agentId: string) =>
  (await listApiTokenRows()).filter(r => r.agent_id === agentId && r.revoked_at === null)

// issue() reads the token file, writes a new one, then rotates / mints in one `immediate` transaction that
// reads the active rows itself. Two overlapping calls used to leave two active rows, one of
// them with a secret nobody held. After the fix: one issue() at a time per name in this process (the file
// write and the row change are one unit), and the transaction revokes every other active row of the name.
describe('issueAgentToken: overlapping calls', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('two parallel rotations of an existing token leave one active row, and the file holds its token', async () => {
    await issueAgentToken('alpha')

    const results = await Promise.all([issueAgentToken('alpha', { rotate: true }), issueAgentToken('alpha', { rotate: true })])

    const active = await activeRows('alpha')
    expect(active).toHaveLength(1)
    expect(sha(read(agentTokenPath('alpha')))).toBe(active[0].token_hash)
    expect(results.map(r => r.status)).toEqual(['rotated', 'rotated'])
    expect(results.map(r => r.tokenId)).toContain(active[0].id)
  })

  it('two parallel plain issues without a file: one mints, the other keeps it', async () => {
    const results = await Promise.all([issueAgentToken('alpha'), issueAgentToken('alpha')])

    const active = await activeRows('alpha')
    expect(active).toHaveLength(1)
    expect(sha(read(agentTokenPath('alpha')))).toBe(active[0].token_hash)
    expect(results.map(r => r.status).sort()).toEqual(['issued', 'kept'])
  })

  it('two parallel rotations without a file (the lost-file case) leave one active row too', async () => {
    const results = await Promise.all([issueAgentToken('alpha', { rotate: true }), issueAgentToken('alpha', { rotate: true })])

    const active = await activeRows('alpha')
    expect(active).toHaveLength(1)
    expect(sha(read(agentTokenPath('alpha')))).toBe(active[0].token_hash)
    expect(results.map(r => r.status)).toEqual(['issued', 'rotated'])
  })

  it('the loser of a delayed transaction does not leave its file behind: file and active row stay the same token', async () => {
    await issueAgentToken('alpha')
    const original = dbx.tx.bind(dbx)
    // The first transaction is held back, so without the in-process lock the second call would write its file
    // and commit first, and the first call's late commit would revoke it: file = second token, active = first.
    vi.spyOn(dbx, 'tx').mockImplementationOnce(async (fn, opts) => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return original(fn, opts)
    })

    await Promise.all([issueAgentToken('alpha', { rotate: true }), issueAgentToken('alpha', { rotate: true })])

    const active = await activeRows('alpha')
    expect(active).toHaveLength(1)
    expect(sha(read(agentTokenPath('alpha')))).toBe(active[0].token_hash)
  })

  it('the lock is per name: another agent is not held up by a slow transaction', async () => {
    const original = dbx.tx.bind(dbx)
    let reachedAlpha!: () => void
    const alphaReachedTx = new Promise<void>(resolve => { reachedAlpha = resolve })
    let releaseAlpha!: () => void
    const alphaGate = new Promise<void>(resolve => { releaseAlpha = resolve })
    // The first transaction (alpha's) is held open until the test lets it go.
    vi.spyOn(dbx, 'tx').mockImplementationOnce(async (fn, opts) => {
      reachedAlpha()
      await alphaGate
      return original(fn, opts)
    })

    const alpha = issueAgentToken('alpha', { rotate: true })
    await alphaReachedTx
    const beta = issueAgentToken('beta', { rotate: true })
    // A lock shared by all names would keep beta queued behind alpha, which is still held.
    const raced = await Promise.race([beta, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500))])
    releaseAlpha()
    await alpha

    expect(raced).not.toBe('blocked')
    expect(await activeRows('alpha')).toHaveLength(1)
    expect(await activeRows('beta')).toHaveLength(1)
  })

  it('a row revoked between the file read and the transaction is not rotated again: a fresh token, one active', async () => {
    const first = await issueAgentToken('alpha')
    const original = dbx.tx.bind(dbx)
    vi.spyOn(dbx, 'tx').mockImplementationOnce((fn, opts) => {
      // A concurrent caller revokes the row this call is about to rotate.
      getDb().prepare('UPDATE api_tokens SET revoked_at = 1 WHERE id = ?').run(first.tokenId)
      return original(fn, opts)
    })

    const r = await issueAgentToken('alpha', { rotate: true })

    expect(r.status).toBe('issued')
    const active = await activeRows('alpha')
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(r.tokenId)
    expect(sha(read(agentTokenPath('alpha')))).toBe(active[0].token_hash)
  })

  const addStrayRow = () => getDb().prepare(`INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, agent_id)
    VALUES (?, 'fleet-agent:alpha', 'fleet_agent', 'default', ?, 'alpha')`).run(sha('stray-secret'), Math.floor(Date.now() / 1000))
  const checkAlpha = async () => (await checkAgentTokens(['alpha'], { includeOperator: false, includeShared: false })).rows

  it('a stray second active row under the name is revoked by the next rotate', async () => {
    const first = await issueAgentToken('alpha')
    addStrayRow()

    await issueAgentToken('alpha', { rotate: true })

    const active = await activeRows('alpha')
    expect(active).toHaveLength(1)
    expect(active[0].id).not.toBe(first.tokenId)
    expect(sha(read(agentTokenPath('alpha')))).toBe(active[0].token_hash)
  })

  it('a plain issue that keeps the file is an idempotent no-op: the stray row stays, check reports it', async () => {
    const first = await issueAgentToken('alpha')
    addStrayRow()

    const r = await issueAgentToken('alpha')

    expect(r).toMatchObject({ status: 'kept', tokenId: first.tokenId })
    expect(await activeRows('alpha')).toHaveLength(2)
    expect(await checkAlpha()).toEqual([expect.objectContaining({
      subject: 'alpha', status: 'multiple_active', detail: 'fleet-agent:alpha: 2 active rows',
    })])
  })

  it('after a rotate there is one active row and check reports nothing', async () => {
    await issueAgentToken('alpha')
    addStrayRow()
    expect((await checkAlpha())[0].status).toBe('multiple_active')

    await issueAgentToken('alpha', { rotate: true })

    expect(await checkAlpha()).toEqual([expect.objectContaining({ subject: 'alpha', status: 'ok' })])
    expect((await checkAlpha())[0].detail).toBeUndefined()
  })
})

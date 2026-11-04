// `agent-tokens check`: the read-only audit of the token files after a restore. Every status is pinned
// with the exact rows it returns (not "does not throw"), a token value never shows up in a result, and
// the shared dashboard token is judged against the active `dashboard` row.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import { initDatabase, enrollDashboardApiToken, revokeApiTokensForAgent, getDb } from '../db.js'
import Database from 'better-sqlite3'
import { archiveSharedTokenAge, checkAgentTokens, issueAgentToken, issueOperatorToken, agentTokenPath, operatorTokenPath } from '../agent-tokens.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const AGENTS = ['main-agent', 'alpha', 'beta']
const sharedFile = () => join(state.root, 'store', '.dashboard-token')
const NOW = () => Math.floor(Date.now() / 1000)
const statusOf = (rows: Array<{ subject: string; status: string }>) => Object.fromEntries(rows.map(r => [r.subject, r.status]))

let savedEnvDir: string | undefined
let savedEnvToken: string | undefined

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'agent-tokens-check-'))
  for (const a of ['alpha', 'beta']) mkdirSync(join(state.root, 'agents', a), { recursive: true })
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

async function issueAll() {
  for (const a of AGENTS) await issueAgentToken(a)
  await issueOperatorToken()
}

describe('checkAgentTokens', () => {
  it('reports every file as ok after a full issue, with the role and path of each', async () => {
    await issueAll()
    const r = await checkAgentTokens(AGENTS)
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([
      { subject: 'main-agent', status: 'ok', role: 'admin', path: join(state.root, '.agent-token') },
      { subject: 'alpha', status: 'ok', role: 'fleet_agent', path: join(state.root, 'agents', 'alpha', '.agent-token') },
      { subject: 'beta', status: 'ok', role: 'fleet_agent', path: join(state.root, 'agents', 'beta', '.agent-token') },
      { subject: 'operator', status: 'ok', role: 'admin', path: join(state.root, 'store', '.operator-token') },
    ])
  })

  it('a restored install with no token files: every subject is `missing`, ok is false', async () => {
    const r = await checkAgentTokens(AGENTS)
    expect(r.ok).toBe(false)
    expect(statusOf(r.rows)).toEqual({ 'main-agent': 'missing', alpha: 'missing', beta: 'missing', operator: 'missing' })
  })

  it('an empty file is `missing`, not a token', async () => {
    await issueAll()
    writeFileSync(agentTokenPath('alpha'), '\n')
    expect(statusOf((await checkAgentTokens(AGENTS)).rows).alpha).toBe('missing')
  })

  it('a file whose hash the database never saw (an older DB under newer files, or the reverse) is `unknown_hash`', async () => {
    await issueAll()
    writeFileSync(agentTokenPath('alpha'), `${randomBytes(32).toString('hex')}\n`)
    const s = statusOf((await checkAgentTokens(AGENTS)).rows)
    expect(s.alpha).toBe('unknown_hash')
    expect(s.beta).toBe('ok')
  })

  it('a file whose row was revoked is `revoked`', async () => {
    await issueAll()
    await revokeApiTokensForAgent('alpha', NOW())
    expect(statusOf((await checkAgentTokens(AGENTS)).rows).alpha).toBe('revoked')
  })

  it('a file whose row has expired is `revoked`', async () => {
    await issueAll()
    getDb().prepare("UPDATE api_tokens SET expires_at = ? WHERE agent_id = 'beta'").run(NOW() - 5)
    expect(statusOf((await checkAgentTokens(AGENTS)).rows).beta).toBe('revoked')
  })

  // The expiry branch of the row check, at the boundary: `now` is an option of the check, so the instant is exact.
  // A row is expired AT its expires_at (`<=`), and still good one second before it; a `<` would keep it `ok`
  // for the one second the database already refuses it, and a missing branch would never report it.
  it('a row is `revoked` at its expiry instant and `ok` one second before it', async () => {
    await issueAgentToken('beta')
    const expiresAt = NOW() + 1000
    getDb().prepare("UPDATE api_tokens SET expires_at = ? WHERE agent_id = 'beta'").run(expiresAt)
    const beta = async (now: number) =>
      (await checkAgentTokens(['beta'], { includeOperator: false, includeShared: false, now })).rows[0]
    expect(await beta(expiresAt - 1)).toMatchObject({ subject: 'beta', status: 'ok' })
    expect(await beta(expiresAt)).toMatchObject({ subject: 'beta', status: 'revoked' })
    expect(await beta(expiresAt + 1)).toMatchObject({ subject: 'beta', status: 'revoked' })
  })

  it('a valid token of ANOTHER subject in the file is `wrong_role`', async () => {
    await issueAll()
    // beta's path holds alpha's token; the operator's path holds a fleet agent's token
    writeFileSync(agentTokenPath('beta'), readFileSync(agentTokenPath('alpha')))
    writeFileSync(operatorTokenPath(), readFileSync(agentTokenPath('alpha')))
    const s = statusOf((await checkAgentTokens(AGENTS)).rows)
    expect(s.beta).toBe('wrong_role')
    expect(s.operator).toBe('wrong_role')
    expect(s.alpha).toBe('ok')
  })

  it('a fleet agent token under the main agent\'s path is `wrong_role` (a lower role must not pass as admin)', async () => {
    await issueAll()
    writeFileSync(agentTokenPath('main-agent'), readFileSync(agentTokenPath('alpha')))
    expect(statusOf((await checkAgentTokens(AGENTS)).rows)['main-agent']).toBe('wrong_role')
  })

  it('narrows to the agents asked for (the operator row always comes along)', async () => {
    await issueAll()
    expect((await checkAgentTokens(['alpha'])).rows.map(r => r.subject)).toEqual(['alpha', 'operator'])
  })

  it('no result row carries a token value', async () => {
    await issueAll()
    const raw = readFileSync(agentTokenPath('alpha'), 'utf-8').trim()
    expect(JSON.stringify(await checkAgentTokens(AGENTS))).not.toContain(raw)
  })
})

describe('archiveSharedTokenAge: a backup against the live shared token', () => {
  // an "archive database": a file with just the api_tokens columns the comparison reads
  function archiveDb(rows: Array<{ createdAt: number; revokedAt?: number }>, withTable = true): string {
    const file = join(state.root, `archive-${Math.random().toString(36).slice(2)}.db`)
    const d = new Database(file)
    if (withTable) {
      d.exec('CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, name TEXT, created_at INTEGER, revoked_at INTEGER)')
      for (const r of rows) d.prepare("INSERT INTO api_tokens (name, created_at, revoked_at) VALUES ('dashboard', ?, ?)").run(r.createdAt, r.revokedAt ?? null)
    }
    d.close()
    return file
  }

  it('the live shared token is newer than the archive\'s: `predates` (restoring would resurrect the old one)', async () => {
    await enrollDashboardApiToken(sha('live-token'), 5000)
    expect(await archiveSharedTokenAge(archiveDb([{ createdAt: 1000 }]))).toBe('predates')
  })

  it('the same age or an older live token: `current`', async () => {
    await enrollDashboardApiToken(sha('live-token'), 5000)
    expect(await archiveSharedTokenAge(archiveDb([{ createdAt: 5000 }]))).toBe('current')
    expect(await archiveSharedTokenAge(archiveDb([{ createdAt: 9000 }]))).toBe('current')
  })

  it('a revoked row in the archive does not count: the newest ACTIVE one decides', async () => {
    await enrollDashboardApiToken(sha('live-token'), 5000)
    expect(await archiveSharedTokenAge(archiveDb([{ createdAt: 1000 }, { createdAt: 9000, revokedAt: 9500 }]))).toBe('predates')
  })

  it('`unknown` when the archive has no table, no active row, or is not a database; or the live side has no row', async () => {
    await enrollDashboardApiToken(sha('live-token'), 5000)
    expect(await archiveSharedTokenAge(archiveDb([], false))).toBe('unknown')
    expect(await archiveSharedTokenAge(archiveDb([]))).toBe('unknown')
    expect(await archiveSharedTokenAge(join(state.root, 'no-such.db'))).toBe('unknown')
    getDb().prepare("UPDATE api_tokens SET revoked_at = 1 WHERE name = 'dashboard'").run()
    expect(await archiveSharedTokenAge(archiveDb([{ createdAt: 1000 }]))).toBe('unknown')
  })
})

describe('checkAgentTokens: the shared dashboard token', () => {
  it('a token file that hashes to the active `dashboard` row is ok', async () => {
    await issueAll()
    writeFileSync(sharedFile(), 'shared-token-A')
    await enrollDashboardApiToken(sha('shared-token-A'), NOW())
    expect((await checkAgentTokens(AGENTS)).rows.filter(r => r.subject === 'shared')).toEqual([
      { subject: 'shared', status: 'ok', role: '-', path: sharedFile() },
    ])
  })

  it('a file that does not exist is no finding (the dashboard draws a fresh one at its next start)', async () => {
    await issueAll()
    const r = await checkAgentTokens(AGENTS)
    expect(r.rows.some(x => x.subject === 'shared')).toBe(false)
    expect(r.ok).toBe(true)
  })

  it('the resurrected old shared token (an archive from before a rotation) is `shared_mismatch`', async () => {
    await issueAll()
    writeFileSync(sharedFile(), 'shared-token-A')
    await enrollDashboardApiToken(sha('shared-token-A'), NOW() - 100)
    // the rotation: a new token is enrolled, the old row is revoked
    writeFileSync(sharedFile(), 'shared-token-B')
    await enrollDashboardApiToken(sha('shared-token-B'), NOW() - 50)
    expect(statusOf((await checkAgentTokens(AGENTS)).rows).shared).toBe('ok')
    // the restore brings the old file back
    writeFileSync(sharedFile(), 'shared-token-A')
    const r = await checkAgentTokens(AGENTS)
    expect(statusOf(r.rows).shared).toBe('shared_mismatch')
    expect(r.ok).toBe(false)
  })

  it('a DASHBOARD_TOKEN in .env is `shared_in_env` (and the value stays out of the result)', async () => {
    await issueAll()
    writeFileSync(join(state.root, '.env'), 'WEB_PORT=3420\nDASHBOARD_TOKEN=super-secret-shared-value\n')
    const r = await checkAgentTokens(AGENTS)
    expect(r.rows.filter(x => x.status === 'shared_in_env')).toEqual([{ subject: 'shared', status: 'shared_in_env', role: '-', path: '.env' }])
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('super-secret-shared-value')
  })

  it('a DASHBOARD_TOKEN set in the environment is `shared_in_env`; an empty one is not', async () => {
    await issueAll()
    process.env.DASHBOARD_TOKEN = '  '
    expect((await checkAgentTokens(AGENTS)).ok).toBe(true)
    process.env.DASHBOARD_TOKEN = 'from-the-environment'
    expect(statusOf((await checkAgentTokens(AGENTS)).rows).shared).toBe('shared_in_env')
  })

  it('a commented-out DASHBOARD_TOKEN line in .env is not a finding', async () => {
    await issueAll()
    writeFileSync(join(state.root, '.env'), '# DASHBOARD_TOKEN=abc\n')
    expect((await checkAgentTokens(AGENTS)).ok).toBe(true)
  })
})

// multiple_active counts the rows that are ACTIVE at `now` (not revoked, not expired): an expired or a
// revoked second row under the name is no finding. `now` is an option of the check, so the boundary is exact.
describe('checkAgentTokens: multiple_active looks at the active rows only', () => {
  const addRow = (name: string, secret: string, extra: { expiresAt?: number | null; revokedAt?: number | null } = {}) =>
    getDb().prepare(`INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, revoked_at, agent_id)
      VALUES (?, ?, 'fleet_agent', 'default', ?, ?, ?, 'alpha')`)
      .run(sha(secret), name, NOW() - 100, extra.expiresAt ?? null, extra.revokedAt ?? null)
  const alpha = async (now?: number) =>
    (await checkAgentTokens(['alpha'], { includeOperator: false, includeShared: false, now })).rows[0]

  it('a second row that has expired does not count', async () => {
    await issueAgentToken('alpha')
    addRow('fleet-agent:alpha', 'expired-secret', { expiresAt: NOW() - 10 })

    expect(await alpha()).toMatchObject({ subject: 'alpha', status: 'ok' })
  })

  it('a second row that is still valid does: the same row counts before its expiry and not at it', async () => {
    await issueAgentToken('alpha')
    const expiresAt = NOW() + 1000
    addRow('fleet-agent:alpha', 'later-secret', { expiresAt })

    expect(await alpha(expiresAt - 1)).toMatchObject({ status: 'multiple_active', detail: 'fleet-agent:alpha: 2 active rows' })
    expect(await alpha(expiresAt)).toMatchObject({ status: 'ok' })
  })

  it('a second row that was revoked does not count', async () => {
    await issueAgentToken('alpha')
    addRow('fleet-agent:alpha', 'revoked-secret', { revokedAt: NOW() - 5 })

    expect(await alpha()).toMatchObject({ status: 'ok' })
  })

  it('an active row under another name does not count', async () => {
    await issueAgentToken('alpha')
    addRow('fleet-agent:beta', 'other-name-secret')

    expect(await alpha()).toMatchObject({ status: 'ok' })
  })
})

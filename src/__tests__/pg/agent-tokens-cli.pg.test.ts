// The agent-tokens CLI on PostgreSQL as the APPLICATION role (scripts/agent-tokens.ts -> src/agent-tokens/cli.ts).
//
// The CLI runs the whole command inside the system job `agent-tokens-cli`. api_tokens is row-level-security class A, so an
// empty context sees ZERO rows and its inserts are refused. For `issue` that is destructive, not just misleading: the token
// FILE is written first, the row second. A blind `issue` overwrites a valid file and then the insert is refused: the old row
// stays active, the file holds a token nothing recognises, the agent is locked out. The "blind" cells below show that
// outcome with the job removed (the same calls outside the job), the CLI cells show the same data handled correctly.
//
// Also pinned: every check status on PostgreSQL, the token never in stdout / stderr / the log, the file mode, the refusal of
// rotate-shared with DASHBOARD_TOKEN set, the exit codes (0 ok, 1 failed, 2 usage) with the pool ended on each path, the
// info line (backend, verb, active rows seen, no name and no hash), archive-shared-age against a SQLite archive fixture,
// and that the boot never migrates.
//
// Neutral fixtures only (alpha, beta, main-agent). The store and the agent directories are throwaway directories.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createPgTestDb, PG_TEST_APP_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get STORE_DIR() { return join(state.root, 'store') },
}))
vi.mock('../../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/agent-config.js')>()),
  agentConfigRoot: (name: string) => (name === 'main-agent' ? state.root : join(state.root, 'agents', name)),
  listAgentNames: () => ['alpha', 'beta'],
}))
vi.mock('../../db-migrations-pg.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db-migrations-pg.js')>()
  return { ...real, applyPgMigrations: vi.fn(real.applyPgMigrations) }
})

import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { resetPgCredentialCaptureForTests } from '../../db/pg/url.js'
import { runAgentTokensCli, type CliIo } from '../../agent-tokens/cli.js'
import { issueAgentToken } from '../../agent-tokens.js'
import { applyPgMigrations } from '../../db-migrations-pg.js'
import { logger } from '../../logger.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)
const alphaFile = () => join(state.root, 'agents', 'alpha', '.agent-token')
const betaFile = () => join(state.root, 'agents', 'beta', '.agent-token')
const operatorFile = () => join(state.root, 'store', '.operator-token')
const sharedFile = () => join(state.root, 'store', '.dashboard-token')
const readTok = (p: string) => readFileSync(p, 'utf-8').trim()
const mode = (p: string) => statSync(p).mode & 0o777

const made: PgTestDb[] = []

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'agent-tokens-pg-'))
  for (const a of ['alpha', 'beta']) mkdirSync(join(state.root, 'agents', a), { recursive: true })
  mkdirSync(join(state.root, 'store'), { recursive: true })
  // no .env of this checkout, and no DASHBOARD_TOKEN in the environment (the refusal cells set their own)
  vi.stubEnv('CLAUDECLAW_ENV_DIR', state.root)
  vi.stubEnv('DASHBOARD_TOKEN', '')
})
afterAll(async () => {
  for (const d of made) await d.close()
})
afterEach(async () => {
  await closePgBackend()
  vi.unstubAllEnvs()
  resetPgCredentialCaptureForTests()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})

/** A database with the application URL in the environment (what the CLI boots on). */
async function freshDb(): Promise<PgTestDb> {
  const db = await createPgTestDb()
  made.push(db)
  vi.stubEnv('MARVEEN_PG_URL', db.appUrl)
  return db
}

/** The streams of one run, collected. */
function capture() {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { stdout: (t) => { out.push(t) }, stderr: (t) => { err.push(t) } }
  return { io, stdout: () => out.join(''), stderr: () => err.join('') }
}

/** One run of the CLI: its exit code and both streams. */
async function run(...argv: string[]) {
  const c = capture()
  const code = await runAgentTokensCli(argv, c.io)
  return { code, stdout: c.stdout(), stderr: c.stderr() }
}

/** Every log call of the run (all levels), as one string. */
function spyLog() {
  const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((l) => vi.spyOn(logger, l))
  return () => JSON.stringify(spies.flatMap((s) => s.mock.calls))
}

const countOf = async (db: PgTestDb, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.pool.query(sql, params)).rows[0].n)

const activeRows = async (db: PgTestDb, name: string) =>
  (await db.pool.query('SELECT id, token_hash FROM api_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY id', [name])).rows as Array<{ id: number; token_hash: string }>

/** A row written by the owner of the test server (the superuser pool bypasses row-level security): the cells test the CLI. */
async function seedRow(db: PgTestDb, r: { hash: string; name: string; role: string; agentId?: string | null; createdAt?: number; expiresAt?: number | null; revokedAt?: number | null; tenant?: string }): Promise<void> {
  await db.pool.query(
    'INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, revoked_at, agent_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [r.hash, r.name, r.role, r.tenant ?? 'default', r.createdAt ?? 1, r.expiresAt ?? null, r.revokedAt ?? null, r.agentId ?? null],
  )
}

/** The number of connections the application role holds, polled until it settles (the pool ends asynchronously). */
async function appConnections(db: PgTestDb): Promise<number> {
  let n = -1
  for (let i = 0; i < 40; i++) {
    n = await countOf(db, 'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [PG_TEST_APP_ROLE])
    if (n === 0) return 0
    await new Promise((r) => setTimeout(r, 50))
  }
  return n
}

/** A trigger that refuses every write of the kind on api_tokens (the failure of the row, after the file was written). */
async function refuseTokenWrites(db: PgTestDb, kind: 'INSERT' | 'UPDATE'): Promise<void> {
  await db.pool.query("CREATE FUNCTION refuse_token_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'token write refused (test)'; END $$")
  await db.pool.query(`CREATE TRIGGER refuse_token_write BEFORE ${kind} ON api_tokens FOR EACH ROW EXECUTE FUNCTION refuse_token_write()`)
}

describe('the verbs on PostgreSQL with the application role', () => {
  it('issue writes a 0600 file and one active row per agent, keeps on a second run, and rotates on request', async () => {
    const db = await freshDb()

    const first = await run('issue', 'alpha')
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toBe(`alpha\tissued\tfleet_agent\t${alphaFile()}\n`)
    const rawFirst = readTok(alphaFile())
    expect((await activeRows(db, 'fleet-agent:alpha')).map((r) => r.token_hash)).toEqual([sha(rawFirst)])

    const again = await run('issue', 'alpha')
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toBe(`alpha\tkept\tfleet_agent\t${alphaFile()}\n`)
    expect(readTok(alphaFile())).toBe(rawFirst)
    expect(await activeRows(db, 'fleet-agent:alpha')).toHaveLength(1)

    const rotated = await run('issue', '--rotate', 'alpha')
    expect(rotated.code, rotated.stderr).toBe(0)
    expect(rotated.stdout).toBe(`alpha\trotated\tfleet_agent\t${alphaFile()}\n`)
    const rawRotated = readTok(alphaFile())
    expect(rawRotated).not.toBe(rawFirst)
    expect((await activeRows(db, 'fleet-agent:alpha')).map((r) => r.token_hash)).toEqual([sha(rawRotated)])
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NOT NULL', [sha(rawFirst)])).toBe(1)
  })

  it('issue without names takes the main agent first (an admin token) and then every agent', async () => {
    const db = await freshDb()

    const r = await run('issue')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n').map((l) => l.split('\t').slice(0, 3).join('\t'))).toEqual([
      'main-agent\tissued\tadmin',
      'alpha\tissued\tfleet_agent',
      'beta\tissued\tfleet_agent',
    ])
    const rows = (await db.pool.query('SELECT name, role, agent_id FROM api_tokens ORDER BY id')).rows
    expect(rows).toEqual([
      { name: 'main-agent:main-agent', role: 'admin', agent_id: 'main-agent' },
      { name: 'fleet-agent:alpha', role: 'fleet_agent', agent_id: 'alpha' },
      { name: 'fleet-agent:beta', role: 'fleet_agent', agent_id: 'beta' },
    ])
  })

  it('issue --dry-run names the file, writes nothing and opens no row', async () => {
    const db = await freshDb()

    const r = await run('issue', '--dry-run', 'alpha')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe(`alpha\twould issue or keep\t${alphaFile()}\n`)
    expect(existsSync(alphaFile())).toBe(false)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM api_tokens')).toBe(0)
  })

  it('issue for an agent without a directory fails with exit 1 and the others in the run still get their token', async () => {
    const db = await freshDb()

    const r = await run('issue', 'no-such-agent', 'alpha')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("no-such-agent\tFAILED\tagent 'no-such-agent' has no directory\n")
    expect(r.stdout).toBe(`alpha\tissued\tfleet_agent\t${alphaFile()}\n`)
    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM api_tokens')).toBe(1)
  })

  it('issue-operator issues a named admin token and keeps it on the second run', async () => {
    const db = await freshDb()

    const a = await run('issue-operator')
    expect(a.code, a.stderr).toBe(0)
    expect(a.stdout).toBe(`operator\tissued\tadmin\t${operatorFile()}\n`)
    const b = await run('issue-operator')
    expect(b.stdout).toBe(`operator\tkept\tadmin\t${operatorFile()}\n`)
    expect((await db.pool.query("SELECT role, agent_id FROM api_tokens WHERE name = 'operator' AND revoked_at IS NULL")).rows).toEqual([{ role: 'admin', agent_id: null }])
  })

  it('list prints the active rows of every tenant, revoke revokes the tokens of one agent and says how many', async () => {
    const db = await freshDb()
    await seedRow(db, { hash: 'h-other', name: 'fleet-agent:gamma', role: 'fleet_agent', agentId: 'gamma', tenant: 'tenant-b', createdAt: 10 })
    expect((await run('issue', 'alpha')).code).toBe(0)

    const listed = await run('list')
    expect(listed.code, listed.stderr).toBe(0)
    const lines = listed.stdout.trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l.split('\t')).toHaveLength(6)
    expect(lines.some((l) => l.includes('\tfleet-agent:gamma\tfleet_agent\tgamma\ttenant-b\t'))).toBe(true)

    const revoked = await run('revoke', 'alpha')
    expect(revoked.code, revoked.stderr).toBe(0)
    expect(revoked.stdout).toBe('revoked 1 token(s) of alpha\n')
    expect(await run('revoke', 'alpha')).toMatchObject({ code: 0, stdout: 'revoked 0 token(s) of alpha\n' })
    expect((await run('list')).stdout.trim().split('\n')).toHaveLength(1)
  })
})

describe('check: every status on PostgreSQL, exit 1 on any finding, the row format unchanged', () => {
  const statusOf = (stdout: string): Record<string, string> =>
    Object.fromEntries(stdout.trim().split('\n').map((l) => { const f = l.split('\t'); return [f[0]!, f[1]!] }))

  async function issueBoth(): Promise<void> {
    expect((await run('issue', 'alpha')).code).toBe(0)
    expect((await run('issue-operator')).code).toBe(0)
  }

  it('ok: exit 0 and one four-field row per subject', async () => {
    await freshDb()
    await issueBoth()

    const r = await run('check', 'alpha')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe(`alpha\tok\tfleet_agent\t${alphaFile()}\noperator\tok\tadmin\t${operatorFile()}\n`)
  })

  it('missing: no token file', async () => {
    await freshDb()
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(statusOf(r.stdout)['alpha']).toBe('missing')
  })

  it('unknown_hash: a file no row recognises', async () => {
    await freshDb()
    writeFileSync(alphaFile(), `${randomBytes(32).toString('hex')}\n`)
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(statusOf(r.stdout)['alpha']).toBe('unknown_hash')
  })

  it('revoked: the row of the file was revoked', async () => {
    await freshDb()
    await issueBoth()
    expect((await run('revoke', 'alpha')).code).toBe(0)
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(statusOf(r.stdout)['alpha']).toBe('revoked')
  })

  it('wrong_role: the row of the file is not the one the subject expects', async () => {
    const db = await freshDb()
    await issueBoth()
    await db.pool.query("UPDATE api_tokens SET role = 'viewer' WHERE name = 'fleet-agent:alpha'")
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(statusOf(r.stdout)['alpha']).toBe('wrong_role')
  })

  it('multiple_active: a stray second active row of the name, with the detail field', async () => {
    const db = await freshDb()
    await issueBoth()
    await seedRow(db, { hash: 'h-stray', name: 'fleet-agent:alpha', role: 'fleet_agent', agentId: 'alpha', createdAt: NOW() })
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(r.stdout).toContain(`alpha\tmultiple_active\tfleet_agent\t${alphaFile()}\tfleet-agent:alpha: 2 active rows\n`)
  })

  it('shared_mismatch: a shared token file that no active dashboard row matches; ok when it does', async () => {
    const db = await freshDb()
    await issueBoth()
    writeFileSync(sharedFile(), 'shared-fixture-value')
    const bad = await run('check', 'alpha')
    expect(bad.code).toBe(1)
    expect(bad.stdout).toContain(`shared\tshared_mismatch\t-\t${sharedFile()}\n`)

    await seedRow(db, { hash: sha('shared-fixture-value'), name: 'dashboard', role: 'admin', createdAt: NOW() })
    const good = await run('check', 'alpha')
    expect(good.code, good.stdout).toBe(0)
    expect(good.stdout).toContain(`shared\tok\t-\t${sharedFile()}\n`)
  })

  it('shared_in_env: DASHBOARD_TOKEN set in the environment', async () => {
    await freshDb()
    await issueBoth()
    vi.stubEnv('DASHBOARD_TOKEN', 'env-fixture-value')
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('shared\tshared_in_env\t-\t.env\n')
  })

  it('an expired row reads as revoked', async () => {
    const db = await freshDb()
    await issueBoth()
    await db.pool.query("UPDATE api_tokens SET expires_at = 5 WHERE name = 'fleet-agent:alpha'")
    const r = await run('check', 'alpha')
    expect(r.code).toBe(1)
    expect(statusOf(r.stdout)['alpha']).toBe('revoked')
  })
})

describe('without the system job a run is blind, and a blind issue destroys the file', () => {
  it('the same rows read as empty outside the job: the file is rewritten, the insert is refused, the old row stays active', async () => {
    const db = await freshDb()
    expect((await run('issue', 'alpha')).code).toBe(0)
    const before = readTok(alphaFile())
    expect(await activeRows(db, 'fleet-agent:alpha')).toHaveLength(1)

    // the mutant: the same call the CLI makes, without the job around it
    await bootPgBackend({ migrateUrl: '' })
    // measured: the writer refuses the empty context before the policy does ("invalid token tenant_id (unknown)"), the policy is the second wall
    await expect(issueAgentToken('alpha')).rejects.toThrow(/invalid token tenant_id|row-level security/)

    const after = readTok(alphaFile())
    expect(after).not.toBe(before) // the valid file is gone
    const rows = await activeRows(db, 'fleet-agent:alpha')
    expect(rows.map((r) => r.token_hash)).toEqual([sha(before)]) // the active row is still the old one
    expect(rows.map((r) => r.token_hash)).not.toContain(sha(after)) // nothing recognises the file: locked out
  })

  it('the same issue under the CLI keeps the file and the row (the green side of the same data)', async () => {
    const db = await freshDb()
    expect((await run('issue', 'alpha')).code).toBe(0)
    const before = readTok(alphaFile())

    const again = await run('issue', 'alpha')
    expect(again.stdout).toBe(`alpha\tkept\tfleet_agent\t${alphaFile()}\n`)
    expect(readTok(alphaFile())).toBe(before)
    expect((await activeRows(db, 'fleet-agent:alpha')).map((r) => r.token_hash)).toEqual([sha(before)])
  })

  it('a blind list reads zero rows while the table has two (what the info line would show as 0)', async () => {
    const db = await freshDb()
    await seedRow(db, { hash: 'h-1', name: 'fleet-agent:alpha', role: 'fleet_agent', agentId: 'alpha' })
    await seedRow(db, { hash: 'h-2', name: 'fleet-agent:beta', role: 'fleet_agent', agentId: 'beta' })
    await bootPgBackend({ migrateUrl: '' })
    const { listApiTokenRows } = await import('../../db.js')

    expect(await countOf(db, 'SELECT COUNT(*) AS n FROM api_tokens')).toBe(2)
    expect(await listApiTokenRows()).toEqual([])
  })
})

describe('the token never leaves the process', () => {
  /** What no stream and no log line may contain: the raw value and its hash. */
  function expectNoToken(raw: string, streams: string[], log: string): void {
    for (const s of [...streams, log]) {
      expect(s).not.toContain(raw)
      expect(s).not.toContain(sha(raw))
    }
  }

  it('issue, a kept run, a rotation and issue-operator print and log the agent, the status and the file only', async () => {
    await freshDb()
    const log = spyLog()
    const outs: string[] = []
    for (const args of [['issue', 'alpha'], ['issue', 'alpha'], ['issue', '--rotate', 'alpha'], ['issue-operator']]) {
      const r = await run(...args)
      expect(r.code, r.stderr).toBe(0)
      outs.push(r.stdout, r.stderr)
    }
    expectNoToken(readTok(alphaFile()), outs, log())
    expectNoToken(readTok(operatorFile()), outs, log())
  })

  it('rotate-shared prints the file and the restart hint, never the new or the old value', async () => {
    await freshDb()
    writeFileSync(sharedFile(), 'old-shared-fixture-value')
    const log = spyLog()

    const r = await run('rotate-shared')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe(`shared\tissued\tadmin\t${sharedFile()}\n`)
    expect(r.stderr).toContain('Restart the dashboard')
    const fresh = readTok(sharedFile())
    expectNoToken(fresh, [r.stdout, r.stderr], log())
    expectNoToken('old-shared-fixture-value', [r.stdout, r.stderr], log())
  })

  it('a failing issue (the row is refused after the file was written) does not print the value either', async () => {
    const db = await freshDb()
    await refuseTokenWrites(db, 'INSERT')
    const log = spyLog()

    const r = await run('issue', 'alpha')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('alpha\tFAILED\t')
    expect(r.stderr).toContain('token write refused (test)')
    expectNoToken(readTok(alphaFile()), [r.stdout, r.stderr], log())
  })

  it('an error path of another verb (revoke refused by the database) prints the error and no token', async () => {
    const db = await freshDb()
    expect((await run('issue', 'alpha')).code).toBe(0)
    await refuseTokenWrites(db, 'UPDATE')
    const log = spyLog()

    const r = await run('revoke', 'alpha')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Error: ')
    expectNoToken(readTok(alphaFile()), [r.stdout, r.stderr], log())
  })

  it('the info line carries the backend, the verb and a count, and no name, id or hash', async () => {
    const db = await freshDb()
    await seedRow(db, { hash: 'h-seeded', name: 'fleet-agent:gamma', role: 'fleet_agent', agentId: 'gamma' })
    await seedRow(db, { hash: 'h-revoked', name: 'fleet-agent:delta', role: 'fleet_agent', agentId: 'delta', revokedAt: 5 })
    const info = vi.spyOn(logger, 'info')

    expect((await run('list')).code).toBe(0)

    const lines = info.mock.calls.filter((c) => c[1] === 'agent-tokens: run')
    expect(lines).toHaveLength(1)
    expect(lines[0]![0]).toEqual({ backend: 'pg', command: 'list', activeTokens: 1 })
  })
})

describe('file mode', () => {
  it('a new token file is 0600, and a kept run re-tightens a loosened one', async () => {
    await freshDb()
    expect((await run('issue', 'alpha')).code).toBe(0)
    expect(mode(alphaFile())).toBe(0o600)

    chmodSync(alphaFile(), 0o644)
    const again = await run('issue', 'alpha')
    expect(again.stdout).toContain('\tkept\t')
    expect(mode(alphaFile())).toBe(0o600)
  })

  it('rotate-shared writes the shared file 0600', async () => {
    await freshDb()
    expect((await run('rotate-shared')).code).toBe(0)
    expect(mode(sharedFile())).toBe(0o600)
  })
})

describe('rotate-shared', () => {
  it('rotates an active dashboard row: the old row is revoked with its hash, the new file matches the new active row', async () => {
    const db = await freshDb()
    writeFileSync(sharedFile(), 'old-shared-fixture-value')
    await seedRow(db, { hash: sha('old-shared-fixture-value'), name: 'dashboard', role: 'admin', createdAt: 5 })

    const r = await run('rotate-shared')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe(`shared\trotated\tadmin\t${sharedFile()}\n`)
    const rows = await activeRows(db, 'dashboard')
    expect(rows.map((x) => x.token_hash)).toEqual([sha(readTok(sharedFile()))])
    expect(await countOf(db, "SELECT COUNT(*) AS n FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NOT NULL", [sha('old-shared-fixture-value')])).toBe(1)
  })

  it('refuses while DASHBOARD_TOKEN is set: exit 1, the exact message, nothing written or revoked', async () => {
    const db = await freshDb()
    writeFileSync(sharedFile(), 'old-shared-fixture-value')
    await seedRow(db, { hash: sha('old-shared-fixture-value'), name: 'dashboard', role: 'admin', createdAt: 5 })
    vi.stubEnv('DASHBOARD_TOKEN', 'env-fixture-value')

    const r = await run('rotate-shared')
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(
      'shared\tFAILED\tDASHBOARD_TOKEN is set in the environment or .env: it overrides store/.dashboard-token, so a rotation of the file would change nothing. Remove it first.\n',
    )
    expect(r.stdout).toBe('')
    expect(readTok(sharedFile())).toBe('old-shared-fixture-value')
    expect((await activeRows(db, 'dashboard')).map((x) => x.token_hash)).toEqual([sha('old-shared-fixture-value')])
  })
})

describe('the entry: exit codes, the pool ended on every path, the boot never migrates', () => {
  it('no command, an unknown command and a missing argument exit 2 with the usage text, and open nothing', async () => {
    const db = await freshDb()
    const info = vi.spyOn(logger, 'info')
    for (const argv of [[], ['bogus'], ['revoke'], ['revoke', 'a', 'b'], ['archive-shared-age']]) {
      const r = await run(...argv)
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.stderr).toContain('Usage:')
      expect(r.stdout).toBe('')
    }
    expect(info.mock.calls.filter((c) => c[1] === 'agent-tokens: run')).toHaveLength(0)
    expect(await appConnections(db)).toBe(0)
  })

  it('a successful run exits 0 and leaves no connection of the application role open', async () => {
    const db = await freshDb()
    expect((await run('list')).code).toBe(0)
    expect(await appConnections(db)).toBe(0)
  })

  it('a failing issue exits 1 and leaves no connection open', async () => {
    const db = await freshDb()
    expect((await run('issue', 'no-such-agent')).code).toBe(1)
    expect(await appConnections(db)).toBe(0)
  })

  it('an exception after the boot (the database refuses the write) exits 1 with the error, and leaves no connection open', async () => {
    const db = await freshDb()
    expect((await run('issue', 'alpha')).code).toBe(0)
    await refuseTokenWrites(db, 'UPDATE')

    const r = await run('revoke', 'alpha')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Error: ')
    expect(await appConnections(db)).toBe(0)
  })

  it('a failing check (a finding) exits 1 and leaves no connection open', async () => {
    const db = await freshDb()
    expect((await run('check', 'alpha')).code).toBe(1)
    expect(await appConnections(db)).toBe(0)
  })

  it('the boot never migrates, even with a migrate URL set in the environment', async () => {
    const db = await freshDb()
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', db.ownerUrl)

    expect((await run('list')).code).toBe(0)
    expect(applyPgMigrations).not.toHaveBeenCalled()
  })
})

describe('archive-shared-age: a SQLite archive against the live PostgreSQL row', () => {
  /** A throwaway archive database: the table and the one active dashboard row the verb reads. */
  function archive(createdAt: number | null): string {
    const path = join(state.root, `archive-${createdAt}.db`)
    const a = new Database(path)
    a.exec('CREATE TABLE api_tokens (id INTEGER PRIMARY KEY, token_hash TEXT, name TEXT, created_at INTEGER, revoked_at INTEGER)')
    if (createdAt !== null) a.prepare("INSERT INTO api_tokens (token_hash, name, created_at, revoked_at) VALUES ('h', 'dashboard', ?, NULL)").run(createdAt)
    a.close()
    return path
  }

  it('predates: the archive holds an older shared token than the live row', async () => {
    const db = await freshDb()
    await seedRow(db, { hash: 'live', name: 'dashboard', role: 'admin', createdAt: 2000 })
    const r = await run('archive-shared-age', archive(1000))
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe('predates\n')
  })

  it('current: the archive holds the live shared token (or a newer one)', async () => {
    const db = await freshDb()
    await seedRow(db, { hash: 'live', name: 'dashboard', role: 'admin', createdAt: 2000 })
    expect((await run('archive-shared-age', archive(2000))).stdout).toBe('current\n')
    expect((await run('archive-shared-age', archive(3000))).stdout).toBe('current\n')
  })

  it('unknown: no live dashboard row, no row in the archive, a missing file, a file that is no archive', async () => {
    const db = await freshDb()
    // no live row yet
    expect((await run('archive-shared-age', archive(1000))).stdout).toBe('unknown\n')
    await seedRow(db, { hash: 'live', name: 'dashboard', role: 'admin', createdAt: 2000 })
    expect((await run('archive-shared-age', archive(null))).stdout).toBe('unknown\n')
    expect((await run('archive-shared-age', join(state.root, 'no-such-archive.db'))).stdout).toBe('unknown\n')
    const notDb = join(state.root, 'not-a-database.db')
    writeFileSync(notDb, 'this is not a sqlite file')
    expect((await run('archive-shared-age', notDb)).stdout).toBe('unknown\n')
  })

  it('a revoked live dashboard row is not the live token (unknown, not predates)', async () => {
    const db = await freshDb()
    await seedRow(db, { hash: 'live', name: 'dashboard', role: 'admin', createdAt: 2000, revokedAt: 3000 })
    expect((await run('archive-shared-age', archive(1000))).stdout).toBe('unknown\n')
  })
})

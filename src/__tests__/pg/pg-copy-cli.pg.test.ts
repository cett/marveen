// The CLI of the copy tool (scripts/migrate-sqlite-to-pg.ts) against a real PostgreSQL 16 target. The --dry-run flag is the
// operator's safety net, so it is tested through the script itself (a spawned process), not through runCopy.
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const tsx = join(repo, 'node_modules', '.bin', 'tsx')
const script = join(repo, 'scripts', 'migrate-sqlite-to-pg.ts')

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A SQLite database built by the migration chain with one row in agent_audit_log. */
function buildSqlite(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-cli-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const db = new Database(file)
  applyMigrations(db)
  db.exec("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'entity-a', 'action-a')")
  db.close()
  return file
}

/** The script, run as the operator runs it, with the owner URL in the migrate variable. */
function runCli(args: string[], ownerUrl: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(tsx, [script, ...args], {
    cwd: repo,
    env: { ...process.env, MARVEEN_PG_MIGRATE_URL: ownerUrl },
    encoding: 'utf8',
    timeout: 120000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

let target: PgTestDb | undefined

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

async function auditRows(t: PgTestDb): Promise<number> {
  const r = await t.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM agent_audit_log')
  return Number(r.rows[0]!.n)
}

describe('the CLI copy: --dry-run writes nothing, and a run without it commits', () => {
  it('copy --dry-run exits 0 with committed false, and the target holds no row afterwards', async () => {
    target = await createPgTestDb()
    const r = runCli(['copy', '--sqlite', buildSqlite(), '--dry-run'], target.ownerUrl)
    expect(r.status, r.stderr).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.dryRun).toBe(true)
    expect(report.committed).toBe(false)
    expect(await auditRows(target)).toBe(0)
  })

  it('copy without the flag exits 0 with committed true, and the row arrives', async () => {
    target = await createPgTestDb()
    const r = runCli(['copy', '--sqlite', buildSqlite()], target.ownerUrl)
    expect(r.status, r.stderr).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.dryRun).toBe(false)
    expect(report.committed).toBe(true)
    expect(await auditRows(target)).toBe(1)
  })
})

describe('the CLI usage: a missing argument or an unknown command exits 2 and writes nothing', () => {
  it('copy without --sqlite exits 2 and names the argument', async () => {
    target = await createPgTestDb()
    const r = runCli(['copy'], target.ownerUrl)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--sqlite/)
    expect(await auditRows(target)).toBe(0)
  })

  it('an unknown command exits 2 with the usage line', async () => {
    target = await createPgTestDb()
    const r = runCli(['wipe', '--sqlite', buildSqlite()], target.ownerUrl)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/usage/)
  })
})

describe('the exit codes: 0 green, 1 refused, 2 error (a, b)', () => {
  it('check on a clean target exits 0 with ok true', async () => {
    target = await createPgTestDb()
    const r = runCli(['check', '--sqlite', buildSqlite()], target.ownerUrl)
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).ok).toBe(true)
  })

  it('check on a target that already holds a row exits 1 and names the table', async () => {
    target = await createPgTestDb()
    await target.pool.query("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'existing', 'a')")
    const r = runCli(['check', '--sqlite', buildSqlite()], target.ownerUrl)
    expect(r.status, r.stderr).toBe(1)
    const report = JSON.parse(r.stdout)
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'agent_audit_log' })]))
  })

  it('copy on the same refused target exits 1 with committed false, and the existing row is the only row', async () => {
    target = await createPgTestDb()
    await target.pool.query("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'existing', 'a')")
    const r = runCli(['copy', '--sqlite', buildSqlite()], target.ownerUrl)
    expect(r.status, r.stderr).toBe(1)
    const report = JSON.parse(r.stdout)
    expect(report.ok).toBe(false)
    expect(report.committed).toBe(false)
    expect(await auditRows(target)).toBe(1)
  })

  it('check against an unreachable target exits 2 and writes nothing to stdout', () => {
    const r = runCli(['check', '--sqlite', buildSqlite()], 'postgres://postgres@127.0.0.1:1/postgres')
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/check: /)
  })
})

describe('the CLI --orphans flag: the default refuses, skip leaves the orphan out, any other value is a usage error', () => {
  /** A SQLite database with one orphan row: memory_versions points at a memory that is not there (foreign keys off, as the live data is). */
  function buildSqliteOrphan(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pgcopy-cli-orphan-'))
    dirs.push(dir)
    const file = join(dir, 'source.db')
    const db = new Database(file)
    applyMigrations(db)
    db.pragma('foreign_keys = OFF')
    db.exec("INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type) VALUES (999, 'orphaned version', 'c', 1, 'agent-a', 'create')")
    db.close()
    return file
  }

  async function versionRows(t: PgTestDb): Promise<number> {
    const r = await t.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM memory_versions')
    return Number(r.rows[0]!.n)
  }

  it('copy without the flag refuses the orphan (the default is refuse): exit 1, the refusal names memory_versions, nothing is written', async () => {
    target = await createPgTestDb()
    const r = runCli(['copy', '--sqlite', buildSqliteOrphan()], target.ownerUrl)
    expect(r.status, r.stderr).toBe(1)
    const report = JSON.parse(r.stdout)
    expect(report.ok).toBe(false)
    expect(report.committed).toBe(false)
    expect(JSON.stringify(report.refusals)).toMatch(/memory_versions/)
    expect(await versionRows(target)).toBe(0)
  })

  it('copy --orphans skip exits 0, the notice names the skipped row, and the orphan is not written', async () => {
    target = await createPgTestDb()
    const r = runCli(['copy', '--sqlite', buildSqliteOrphan(), '--orphans', 'skip'], target.ownerUrl)
    expect(r.status, r.stderr).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.notice).toMatch(/^orphans skipped \(--orphans skip\): 1 row\(s\)/)
    expect(report.committed).toBe(true)
    expect(await versionRows(target)).toBe(0)
  })

  it('copy --orphans with a value that is neither refuse nor skip exits 2, names the flag, and writes nothing', async () => {
    target = await createPgTestDb()
    const r = runCli(['copy', '--sqlite', buildSqliteOrphan(), '--orphans', 'bogus'], target.ownerUrl)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--orphans takes refuse or skip/)
    expect(await versionRows(target)).toBe(0)
  })
})

describe('the CLI never prints the password of the target URL (c)', () => {
  const SENTINEL = 'pw-sentinel-c'

  it('an unknown host with a password in the URL exits 2, and the password is in neither stream', () => {
    const r = runCli(['check', '--sqlite', buildSqlite()], `postgres://user:${SENTINEL}@no-such-host.invalid:5432/db`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/ENOTFOUND/)
    expect(r.stdout + r.stderr).not.toContain(SENTINEL)
  })

  it('a driver error raised while the client is built (an sslrootcert path that names the password) is redacted in the CLI output', () => {
    // pg-connection-string reads sslrootcert in the Client constructor, outside connect(): the CLI catch is the only sanitiser on that path
    const r = runCli(['check', '--sqlite', buildSqlite()], `postgres://user:${SENTINEL}@no-such-host.invalid:5432/db?sslrootcert=${SENTINEL}`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/ENOENT/)
    expect(r.stdout + r.stderr).not.toContain(SENTINEL)
  })

  it('a driver error that quotes the host (a host override that names the password) is redacted in the CLI output', () => {
    const r = runCli(['check', '--sqlite', buildSqlite()], `postgres://user:${SENTINEL}@no-such-host.invalid:5432/db?host=${SENTINEL}.invalid`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/ENOTFOUND/)
    expect(r.stdout + r.stderr).not.toContain(SENTINEL)
  })
})

// scripts/pg-restore-drill.sh against a real PostgreSQL 16 server (the PG test harness, never the live cluster).
//
// The script is run as the operator's command task runs it: a spawned process with its own environment. The "live" database
// is a harness database (the real baseline schema, row-level security forced), the dump is a real `pg_dump -Fc` taken the
// way the nightly job takes it (the backup role, which bypasses row-level security, with the provisioning grants of
// docs/pg-provisioning.md step 5), and the restoring role is a test role of its own with CREATEDB: no superuser, no BYPASSRLS,
// no membership in marveen_owner, no grant on the live database (the dump is restored with --no-owner --no-acl). No credential is
// real: the passwords are the harness-only throwaway values, written into 0600 password files, never into argv.
//
// Cells: OK (equal; live ahead OR shrunk inside the tolerance, with the drift named in the summary; the fixed default list);
// FAIL (live ahead beyond the tolerance; live shrunk beyond the tolerance, the percent arm too;
// restored copy empty while live is not, whatever the tolerance; stale dump; checksum
// mismatch or missing sidecar; no dump or only a probe dump; a restore that fails half way; an unknown table); the
// throwaway database is dropped after every one of them, success or failure; each missing precondition is named and
// nothing is created; no password in the output and none in the script. Added by the review fixup: the password-file mode
// check fails closed under a GNU-like stat (-c first, an unreadable mode is a FAIL); the backup role counts the restored copy
// through the script's own GRANT (the dump's ACL is not replayed, the drill role is no member of the owner role and reads
// nothing of the live database); a backup password file that names only the live database fails in the preflight; orphaned
// throwaway databases of a killed run are swept by owner and age. Each rule is a mutant of the script that turns its cell red
// (the PR description lists them).
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgTestDb, pgTestUrl, PG_TEST_BACKUP_ROLE, PG_TEST_OWNER_ROLE, type PgTestDb } from '../../src/__tests__/helpers/pg-test-db.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const script = join(repo, 'scripts', 'pg-restore-drill.sh')
const BACKUP_PASSWORD = 'harness-only-backup' // the harness value of marveen_backup (src/__tests__/helpers/pg-test-db.ts)
const DRILL_PASSWORD = 'harness-only-drill-owner'
const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

const suffix = randomBytes(4).toString('hex')
const DRILL = `drilltest_drill_${suffix}`
const NOCREATEDB = `drilltest_nocreatedb_${suffix}`
const TEMPLATE = `drilltest_tpl_${suffix}`
const BARE_TEMPLATE = `drilltest_bare_tpl_${suffix}`
const DEFAULT_TABLES = ['memories', 'kanban_cards', 'workspace_docs', 'schedules', 'dashboard_users', 'agent_messages', 'tenants', 'system_config', 'conversation_log']

let admin: pg.Client
let live: PgTestDb
let host: string
let port: string
let maintDb: string
let work: string
// PATH of every spawned tool: the bin directory of the clients that MATCH the server's major version first. The runner's
// default clients can be newer than the server (PostgreSQL 17 clients, 16 server), and a 17 pg_restore sets
// transaction_timeout, which a 16 server rejects; the dump is also taken by the matching pg_dump.
let toolPath = process.env.PATH ?? ''

/** The major version a client tool on `path` reports (`pg_dump --version`), or undefined when it is not there. */
function toolMajor(tool: string, path: string): number | undefined {
  const r = spawnSync(tool, ['--version'], { encoding: 'utf8', env: { PATH: path } })
  const m = r.status === 0 ? /\) (\d+)/.exec(r.stdout) : null
  return m ? Number(m[1]) : undefined
}

/**
 * The PATH every spawned tool uses: the PATH itself when its pg_dump, pg_restore and psql are all of the server's major
 * (one bin directory for the dump and for the drill), else the bin directory of that major. No match is an ERROR, never a skip.
 */
function resolveToolPath(major: number): string {
  const base = process.env.PATH ?? ''
  if (['pg_dump', 'pg_restore', 'psql'].every((t) => toolMajor(t, base) === major)) return base
  const bin = matchingBinDir(major)
  if (bin) return `${bin}:${base}`
  throw new Error(`no PostgreSQL ${major} client tools (pg_dump, pg_restore, psql) on PATH, in /usr/lib/postgresql/${major}/bin or Homebrew: install postgresql-client-${major} (or set PG_TEST_BIN_DIR)`)
}

/** The bin directory of PostgreSQL <major> clients (Debian/Ubuntu, Homebrew), or undefined when none is installed there. */
function matchingBinDir(major: number): string | undefined {
  const candidates = [
    process.env.PG_TEST_BIN_DIR,
    `/usr/lib/postgresql/${major}/bin`,
    `/opt/homebrew/opt/postgresql@${major}/bin`,
    `/usr/local/opt/postgresql@${major}/bin`,
  ]
  return candidates.find((d) => d !== undefined && d !== '' && ['pg_dump', 'pg_restore', 'psql'].every((t) => existsSync(join(d, t))))
}
let backupPass: string
let drillPass: string
let nocreatedbPass: string
let dumpDirs: string[] = []

/** One cluster-level statement as the harness admin. */
async function adminSql(sql: string): Promise<void> {
  await admin.query(sql)
}

function passfile(name: string, role: string, password: string, mode = 0o600, database = '*'): string {
  const p = join(work, name)
  writeFileSync(p, `${host}:${port}:${database}:${role}:${password}\n`)
  chmodSync(p, mode)
  return p
}

/** pg_dump -Fc of the live database as the backup role, into a new directory, named and checksummed as the nightly job does. */
function makeDump(opts: { ageHours?: number; name?: string; sidecar?: 'ok' | 'wrong' | 'none' } = {}): string {
  const dir = mkdtempSync(join(work, 'dumps-'))
  dumpDirs.push(dir)
  const file = join(dir, opts.name ?? 'marveen-20261127-033014.dump')
  const r = spawnSync('pg_dump', ['-Fc', '-h', host, '-p', port, '-U', PG_TEST_BACKUP_ROLE, '-d', live.name, '-f', file], {
    env: { PATH: toolPath, PGPASSFILE: backupPass },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr}`)
  const sidecar = opts.sidecar ?? 'ok'
  if (sidecar !== 'none') {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
    // the nightly job writes `<hash>  <full path>`; a wrong one differs in the hash
    writeFileSync(`${file}.sha256`, `${sidecar === 'ok' ? hash : '0'.repeat(64)}  ${file}\n`)
  }
  if (opts.ageHours !== undefined) {
    const t = new Date(Date.now() - opts.ageHours * 3600 * 1000)
    utimesSync(file, t, t)
  }
  return dir
}

interface Run { status: number | null; stdout: string; stderr: string }

/** The drill, run the way the command task runs it. The overrides win over the defaults of this harness. */
function runDrill(dumpDir: string, over: Record<string, string> = {}): Run {
  const env: Record<string, string> = {
    PATH: toolPath,
    HOME: work,
    PG_DRILL_DUMP_DIR: dumpDir,
    PG_DRILL_BIN_DIR: '', // empty: the tools come from PATH
    PG_DRILL_HOST: host,
    PG_DRILL_PORT: port,
    PG_DRILL_DB: live.name,
    PG_DRILL_MAINT_DB: maintDb,
    PG_DRILL_ROLE: DRILL,
    PG_DRILL_BACKUP_ROLE: PG_TEST_BACKUP_ROLE,
    PG_DRILL_TEMPLATE: TEMPLATE,
    PG_DRILL_PASSFILE: drillPass,
    PG_DRILL_BACKUP_PASSFILE: backupPass,
    PG_DRILL_TABLES: 'memories system_config tenants',
    ...over,
  }
  const r = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 120000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const lastLine = (s: string): string => s.trimEnd().split('\n').pop() ?? ''

// Throwaway databases that were on the server before this file started (another run's, a real drill's): not this file's
// business, so the cells compare against them instead of expecting a server with none.
let preexisting = new Set<string>()

async function throwawayDatabases(): Promise<string[]> {
  const r = await live.pool.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'marveen\\_drill\\_2%' AND NOT datistemplate ORDER BY 1")
  return r.rows.map((x) => x.datname)
}

/** Throwaway databases of a drill that are still on the server and were not there when the file started. */
async function leftovers(): Promise<string[]> {
  return (await throwawayDatabases()).filter((n) => !preexisting.has(n))
}

async function insertMemories(n: number, tag: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await live.pool.query(
      "INSERT INTO memories (chat_id, content, sector, created_at, accessed_at) VALUES ('chat-a', $1, 'semantic', 1700000000, 1700000000)",
      [`${tag}-${i}`])
  }
}

/** Back to exactly the rows the seeded dump holds (seed-0 .. seed-4), whatever a cell inserted or deleted. */
async function resetMemories(): Promise<void> {
  await live.pool.query('DELETE FROM memories')
  await insertMemories(5, 'seed')
}

let dumpEmptyMemories: string
let dumpSeeded: string

beforeAll(async () => {
  const url = new URL(pgTestUrl())
  host = url.hostname
  port = url.port || '5432'
  maintDb = url.pathname.replace(/^\//, '') || 'postgres'
  work = mkdtempSync(join(tmpdir(), 'pg-restore-drill-'))
  admin = new pg.Client({ connectionString: pgTestUrl() })
  await admin.connect()
  const serverMajor = Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000)
  toolPath = resolveToolPath(serverMajor)
  live = await createPgTestDb() // also makes sure the harness roles exist
  preexisting = new Set(await throwawayDatabases())

  // roles: the drill role is its own role (CREATEDB, no superuser, no BYPASSRLS, NO membership in marveen_owner, no grant on
  // the live database); a second one has no CREATEDB for the precondition cell
  await adminSql(`CREATE ROLE ${quote(DRILL)} LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD '${DRILL_PASSWORD}'`)
  await adminSql(`CREATE ROLE ${quote(NOCREATEDB)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${DRILL_PASSWORD}'`)
  // templates: one with both extensions (what the provisioning step creates), one bare (a restore into it must fail)
  for (const [name, withExt] of [[TEMPLATE, true], [BARE_TEMPLATE, false]] as const) {
    await adminSql(`CREATE DATABASE ${quote(name)}`)
    if (withExt) {
      const c = new pg.Client({ connectionString: pgTestUrl().replace(/\/[^/]*$/, `/${name}`) })
      await c.connect()
      try { await c.query('CREATE EXTENSION vector'); await c.query('CREATE EXTENSION unaccent') } finally { await c.end() }
    }
    await adminSql(`ALTER DATABASE ${quote(name)} IS_TEMPLATE true`)
  }
  // the provisioning grants of docs/pg-provisioning.md, step 5: the backup role reads everything and the dump carries them
  const b = quote(PG_TEST_BACKUP_ROLE)
  for (const sql of [
    `GRANT USAGE ON SCHEMA public, app TO ${b}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${b}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${b}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(PG_TEST_OWNER_ROLE)} IN SCHEMA public GRANT SELECT ON TABLES TO ${b}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(PG_TEST_OWNER_ROLE)} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${b}`,
  ]) await live.ownerPool.query(sql)

  backupPass = passfile('pgpass-backup', PG_TEST_BACKUP_ROLE, BACKUP_PASSWORD)
  drillPass = passfile('pgpass-owner', DRILL, DRILL_PASSWORD)
  nocreatedbPass = passfile('pgpass-nocreatedb', NOCREATEDB, DRILL_PASSWORD)

  // data: memories is empty in the first dump, 5 rows in the second; system_config and tenants carry what the baseline seeds
  dumpEmptyMemories = makeDump()
  await insertMemories(5, 'seed')
  await live.pool.query("INSERT INTO system_config (key, value) VALUES ('drill-test-key', 'v') ON CONFLICT DO NOTHING")
  dumpSeeded = makeDump()
}, 120000)

afterAll(async () => {
  try {
    for (const name of [TEMPLATE, BARE_TEMPLATE]) {
      await admin.query(`ALTER DATABASE ${quote(name)} IS_TEMPLATE false`).catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`).catch(() => undefined)
    }
    await live?.close()
    for (const role of [DRILL, NOCREATEDB]) await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`).catch(() => undefined)
  } finally {
    await admin?.end()
    rmSync(work, { recursive: true, force: true })
  }
})

describe('pg-restore-drill.sh', () => {
  it('OK: a dump restores and the backup role counts the restored copy through the script\'s own GRANT (the dump\'s ACL is not replayed); one summary line, nothing left behind', async () => {
    const r = runDrill(dumpSeeded)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(lastLine(r.stdout)).not.toContain('(restored 0 rows')
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(lastLine(r.stdout)).toMatch(/^pg-restore-drill: OK marveen-20261127-033014\.dump -- 3 of 3 tables match \(restored \d+ rows, live \d+ rows\)$/)
    expect(await leftovers()).toEqual([])
  }, 90000)

  it('OK: the fixed default list of nine key tables exists in the schema and counts', async () => {
    const r = runDrill(dumpSeeded, { PG_DRILL_TABLES: DEFAULT_TABLES.join(' ') })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(lastLine(r.stdout)).toContain('9 of 9 tables match')
    // the default is the list of the brief, in the script itself (a run with no override uses it)
    const text = readFileSync(script, 'utf8')
    const m = /^TABLES="\$\{PG_DRILL_TABLES:-([^}]*)\}"/m.exec(text)
    expect(m?.[1].split(' ')).toEqual(DEFAULT_TABLES)
  }, 90000)

  it('OK: the live database ahead of the dump by 2 rows (the hours since the nightly dump) is inside the tolerance', async () => {
    await insertMemories(2, 'ahead')
    try {
      const r = runDrill(dumpSeeded)
      expect(r.status).toBe(0)
      expect(lastLine(r.stdout)).toContain('3 of 3 tables match')
      expect(lastLine(r.stdout)).toMatch(/\) -- drift: memories \+2$/) // inside the tolerance, and the difference is named
    } finally {
      await live.pool.query("DELETE FROM memories WHERE content LIKE 'ahead-%'")
    }
  }, 90000)

  it('OK: the live database SHRUNK by 2 rows (a retention sweeper deleted them since the dump) is inside the tolerance, and the drift is named with its sign', async () => {
    await live.pool.query("DELETE FROM memories WHERE content IN ('seed-0', 'seed-1')")
    try {
      const r = runDrill(dumpSeeded)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
      expect(lastLine(r.stdout)).toMatch(/^pg-restore-drill: OK marveen-20261127-033014\.dump -- 3 of 3 tables match \(restored \d+ rows, live \d+ rows\) -- drift: memories -2$/)
      expect(await leftovers()).toEqual([])
    } finally {
      await resetMemories()
    }
  }, 90000)

  it('OK: every drifting table is named, in the order of the list, and an unchanged table is not', async () => {
    await live.pool.query("DELETE FROM memories WHERE content = 'seed-0'")
    await live.pool.query("DELETE FROM system_config WHERE key = 'drill-test-key'")
    try {
      const r = runDrill(dumpSeeded)
      expect(r.status).toBe(0)
      expect(lastLine(r.stdout)).toMatch(/ -- drift: memories -1, system_config -1$/)
      expect(lastLine(r.stdout)).not.toContain('tenants')
    } finally {
      await resetMemories()
      await live.pool.query("INSERT INTO system_config (key, value) VALUES ('drill-test-key', 'v') ON CONFLICT DO NOTHING")
    }
  }, 90000)

  it('FAIL: a live table with no rows while the restored copy has 1 fails at the default tolerance (a wipe, or the backup role cannot see the rows)', async () => {
    await live.pool.query('DELETE FROM memories')
    await insertMemories(1, 'lone')
    const dumpOne = makeDump()
    await live.pool.query('DELETE FROM memories')
    try {
      const r = runDrill(dumpOne) // 1 row of difference is inside max(2, 10 percent): only the mirror rule fails it
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(lastLine(r.stderr)).toContain('memories: live table is empty, restored has 1: a wipe, or the backup role cannot see the rows')
      expect(await leftovers()).toEqual([])
    } finally {
      await resetMemories()
    }
  }, 90000)

  it('FAIL: the live database shrank by MORE than the tolerance (3 rows of 5 at the defaults, 2 rows and 10 percent): the table is named', async () => {
    await live.pool.query("DELETE FROM memories WHERE content IN ('seed-0', 'seed-1', 'seed-2')")
    try {
      const r = runDrill(dumpSeeded)
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(lastLine(r.stderr)).toMatch(/^pg-restore-drill: FAIL -- marveen-20261127-033014\.dump: 2 of 3 tables match -- memories: live shrank: restored 5 > live 2 by more than 2$/)
      expect(await leftovers()).toEqual([])
    } finally {
      await resetMemories()
    }
  }, 90000)

  it('the percent arm of the tolerance is symmetric too: 20 percent of 5 restored rows allows 1 row either way, not 2', async () => {
    const strict = { PG_DRILL_TOL_ABS: '0', PG_DRILL_TOL_PCT: '20' }
    await live.pool.query("DELETE FROM memories WHERE content = 'seed-0'")
    try {
      expect(runDrill(dumpSeeded, strict).status).toBe(0) // 1 fewer: inside
      await live.pool.query("DELETE FROM memories WHERE content = 'seed-1'")
      const shrunk = runDrill(dumpSeeded, strict)
      expect(shrunk.status).toBe(1) // 2 fewer: outside
      expect(lastLine(shrunk.stderr)).toContain('memories: live shrank: restored 5 > live 3 by more than 1')
      await resetMemories()
      await insertMemories(1, 'ahead') // 6 live of 5 restored: 1 more, inside
      expect(runDrill(dumpSeeded, strict).status).toBe(0)
      await insertMemories(1, 'ahead2') // 7 live: 2 more, outside
      const grown = runDrill(dumpSeeded, strict)
      expect(grown.status).toBe(1)
      expect(lastLine(grown.stderr)).toContain('memories: live 7 is ahead of restored 5 by more than 1')
      expect(await leftovers()).toEqual([])
    } finally {
      await resetMemories()
    }
  }, 180000)

  it('FAIL: the live database ahead by more than the tolerance (a row missing on the restored side) names the table', async () => {
    await insertMemories(1, 'ahead')
    try {
      const r = runDrill(dumpSeeded, { PG_DRILL_TOL_ABS: '0', PG_DRILL_TOL_PCT: '0' })
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
      expect(lastLine(r.stderr)).toMatch(/^pg-restore-drill: FAIL -- marveen-20261127-033014\.dump: 2 of 3 tables match -- memories: live 6 is ahead of restored 5 by more than 0$/)
      expect(await leftovers()).toEqual([])
    } finally {
      await live.pool.query("DELETE FROM memories WHERE content LIKE 'ahead-%'")
    }
  }, 90000)

  it('FAIL: the restored copy holds more rows than the live database and the tolerance is zero (any row lost since the dump)', async () => {
    await live.pool.query("DELETE FROM memories WHERE content = 'seed-0'")
    try {
      const r = runDrill(dumpSeeded, { PG_DRILL_TOL_ABS: '0', PG_DRILL_TOL_PCT: '0' })
      expect(r.status).toBe(1)
      expect(lastLine(r.stderr)).toContain('memories: live shrank: restored 5 > live 4 by more than 0')
      expect(await leftovers()).toEqual([])
    } finally {
      await resetMemories()
    }
  }, 90000)

  it('FAIL: an empty restored table while live has rows fails whatever the tolerance', async () => {
    const r = runDrill(dumpEmptyMemories, { PG_DRILL_TOL_ABS: '1000', PG_DRILL_TOL_PCT: '100' })
    expect(r.status).toBe(1)
    expect(lastLine(r.stderr)).toContain('memories: restored copy is empty, live has ')
    expect(await leftovers()).toEqual([])
  }, 90000)

  it('FAIL: a table that is not in the restored copy cannot be counted, and the throwaway database is still dropped', async () => {
    const r = runDrill(dumpSeeded, { PG_DRILL_TABLES: 'memories no_such_table_here' })
    expect(r.status).toBe(1)
    expect(lastLine(r.stderr)).toContain('no_such_table_here: cannot be counted in the restored copy')
    expect(lastLine(r.stderr)).toContain('1 of 2 tables match')
    expect(await leftovers()).toEqual([])
  }, 90000)

  it('FAIL: a restore that fails half way (a template without the extensions) is a FAIL and the throwaway database is dropped', async () => {
    const r = runDrill(dumpSeeded, { PG_DRILL_TEMPLATE: BARE_TEMPLATE })
    expect(r.status).toBe(1)
    expect(lastLine(r.stderr)).toMatch(/^pg-restore-drill: FAIL -- pg_restore of marveen-20261127-033014\.dump failed: /)
    expect(await leftovers()).toEqual([])
  }, 90000)

  it('OK: a grant to a role that does not exist in the cluster any more is not replayed (--no-acl), forced row-level security does not hide rows', async () => {
    const ghost = `drilltest_ghost_${suffix}`
    await adminSql(`CREATE ROLE ${quote(ghost)} NOLOGIN`)
    await live.pool.query(`GRANT SELECT ON memories TO ${quote(ghost)}`)
    const dir = makeDump()
    await live.pool.query(`REVOKE SELECT ON memories FROM ${quote(ghost)}`)
    await adminSql(`DROP ROLE ${quote(ghost)}`)
    const r = runDrill(dir)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    // memories has 5 rows and is under forced row-level security in the restored schema's source: the count saw them all
    expect(lastLine(r.stdout)).toContain('3 of 3 tables match')
    expect(lastLine(r.stdout)).not.toContain('(restored 0 rows')
  }, 90000)

  it('FAIL: a dump older than 36 hours; a 30 hour old one passes', async () => {
    const stale = runDrill(makeDump({ ageHours: 40 }))
    expect(stale.status).toBe(1)
    expect(lastLine(stale.stderr)).toBe('pg-restore-drill: FAIL -- the newest dump (marveen-20261127-033014.dump) is older than 36 hours: the nightly dump has stopped')
    const fresh = runDrill(makeDump({ ageHours: 30 }))
    expect(fresh.status).toBe(0)
  }, 120000)

  it('FAIL: a sidecar that does not match, and a dump with no sidecar', () => {
    const wrong = runDrill(makeDump({ sidecar: 'wrong' }))
    expect(wrong.status).toBe(1)
    expect(lastLine(wrong.stderr)).toContain('sha256 of marveen-20261127-033014.dump does not match its sidecar')
    const none = runDrill(makeDump({ sidecar: 'none' }))
    expect(none.status).toBe(1)
    expect(lastLine(none.stderr)).toContain('has no .sha256 sidecar')
  }, 120000)

  it('FAIL: no dump at all, and a probe dump (marveen-probe-*.dump) is never drilled', () => {
    const empty = mkdtempSync(join(work, 'empty-'))
    const none = runDrill(empty)
    expect(none.status).toBe(1)
    expect(lastLine(none.stderr)).toMatch(/^pg-restore-drill: FAIL -- no dump marveen-<date>-<time>\.dump in /)
    const probe = runDrill(makeDump({ name: 'marveen-probe-20261126.dump' }))
    expect(probe.status).toBe(1)
    expect(lastLine(probe.stderr)).toContain('no dump marveen-<date>-<time>.dump')
  }, 120000)

  it('FAIL: each missing precondition is named and nothing is created', async () => {
    const noCreatedb = runDrill(dumpSeeded, { PG_DRILL_ROLE: NOCREATEDB, PG_DRILL_PASSFILE: nocreatedbPass })
    expect(noCreatedb.status).toBe(1)
    expect(lastLine(noCreatedb.stderr)).toContain(`role ${NOCREATEDB} lacks CREATEDB`)

    const noTemplate = runDrill(dumpSeeded, { PG_DRILL_TEMPLATE: `drilltest_missing_${suffix}` })
    expect(noTemplate.status).toBe(1)
    expect(lastLine(noTemplate.stderr)).toContain(`template database drilltest_missing_${suffix} does not exist`)

    const notTemplate = runDrill(dumpSeeded, { PG_DRILL_TEMPLATE: live.name })
    expect(notTemplate.status).toBe(1)
    expect(lastLine(notTemplate.stderr)).toContain(`database ${live.name} exists but is not a template`)

    // the drill role must hold no right on the live database: a SELECT grant, a membership of the owner role, BYPASSRLS
    // and superuser are each refused
    await live.pool.query(`GRANT SELECT ON memories TO ${quote(DRILL)}`)
    try {
      const reads = runDrill(dumpSeeded)
      expect(reads.status).toBe(1)
      expect(lastLine(reads.stderr)).toContain(`role ${DRILL} can read`)
      expect(lastLine(reads.stderr)).toContain('of the live database')
    } finally {
      await live.pool.query(`REVOKE SELECT ON memories FROM ${quote(DRILL)}`)
    }
    await admin.query(`GRANT ${quote(PG_TEST_OWNER_ROLE)} TO ${quote(DRILL)}`)
    try {
      const member = runDrill(dumpSeeded)
      expect(member.status).toBe(1)
      expect(lastLine(member.stderr)).toContain(`role ${DRILL} can read`)
    } finally {
      await admin.query(`REVOKE ${quote(PG_TEST_OWNER_ROLE)} FROM ${quote(DRILL)}`)
    }
    await admin.query(`ALTER ROLE ${quote(DRILL)} BYPASSRLS`)
    try {
      const bypass = runDrill(dumpSeeded)
      expect(bypass.status).toBe(1)
      expect(lastLine(bypass.stderr)).toContain('is a superuser or has BYPASSRLS')
    } finally {
      await admin.query(`ALTER ROLE ${quote(DRILL)} NOBYPASSRLS`)
    }

    const noFile = runDrill(dumpSeeded, { PG_DRILL_PASSFILE: join(work, 'does-not-exist') })
    expect(noFile.status).toBe(1)
    expect(lastLine(noFile.stderr)).toContain('drill role password file')
    expect(lastLine(noFile.stderr)).toContain('does not exist')

    const open = passfile('pgpass-open', DRILL, DRILL_PASSWORD, 0o644)
    const openMode = runDrill(dumpSeeded, { PG_DRILL_PASSFILE: open })
    expect(openMode.status).toBe(1)
    expect(lastLine(openMode.stderr)).toContain('must be 0600')

    const wrongPassword = passfile('pgpass-wrong', DRILL, 'not-the-password')
    const badLogin = runDrill(dumpSeeded, { PG_DRILL_PASSFILE: wrongPassword })
    expect(badLogin.status).toBe(1)
    expect(lastLine(badLogin.stderr)).toContain(`cannot connect as ${DRILL}`)
    expect(await leftovers()).toEqual([])
  }, 180000)

  it('FAIL: the throwaway database is dropped when the run is cut off by a signal after it was created', async () => {
    // a signal during the restore: SIGTERM the script as soon as a throwaway database shows up
    const p = spawn('bash', [script], {
      env: {
        PATH: toolPath, HOME: work, PG_DRILL_DUMP_DIR: dumpSeeded, PG_DRILL_BIN_DIR: '', PG_DRILL_HOST: host,
        PG_DRILL_PORT: port, PG_DRILL_DB: live.name, PG_DRILL_MAINT_DB: maintDb, PG_DRILL_ROLE: DRILL,
        PG_DRILL_BACKUP_ROLE: PG_TEST_BACKUP_ROLE, PG_DRILL_TEMPLATE: TEMPLATE, PG_DRILL_PASSFILE: drillPass,
        PG_DRILL_BACKUP_PASSFILE: backupPass,
      },
    })
    let err = ''
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    const done = new Promise<number | null>((resolve) => p.on('close', (code) => resolve(code)))
    try {
      const deadline = Date.now() + 60000
      while (Date.now() < deadline && (await leftovers()).length === 0) await new Promise((r) => setTimeout(r, 25))
      expect((await leftovers()).length).toBeGreaterThan(0) // it was created
      p.kill('SIGTERM')
      const code = await done
      expect(code).toBe(1)
      expect(lastLine(err)).toContain('pg-restore-drill: FAIL')
      expect(await leftovers()).toEqual([])
    } finally {
      // an assertion that threw before the signal must not leave the script running into the next cell
      if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await done }
    }
  }, 120000)

  it('no password appears in any output, and the script holds no URL, PGPASSWORD or -W', () => {
    const outputs = [runDrill(dumpSeeded), runDrill(dumpSeeded, { PG_DRILL_PASSFILE: join(work, 'does-not-exist') })]
    for (const o of outputs) {
      for (const secret of [BACKUP_PASSWORD, DRILL_PASSWORD, 'harness-only']) {
        expect(o.stdout + o.stderr).not.toContain(secret)
      }
    }
    const text = readFileSync(script, 'utf8')
    const code = text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    expect(code).not.toMatch(/PGPASSWORD/)
    expect(code).not.toMatch(/postgres(ql)?:\/\//)
    expect(code).not.toMatch(/\s-W(\s|$)/)
    expect(code).toMatch(/PGPASSFILE=/)
  }, 120000)
  // ---- review fixup cells ---------------------------------------------------------------------------------------------

  /** A directory with a `stat` that behaves like GNU stat for the two forms the script may call; put it first on PATH. */
  function gnuLikeStatShim(): string {
    const dir = mkdtempSync(join(work, 'shim-'))
    // GNU: -c FORMAT prints the mode (here STAT_SHIM_MODE); -f is the FILESYSTEM status and prints "?p" for the unknown
    // directive %L, exit 0 (the behaviour that made the old order fail open). Anything else: exit 1.
    const body = [
      '#!/bin/sh',
      'case "$1" in',
      '  -c) printf "%s\\n" "${STAT_SHIM_MODE}"; exit 0 ;;',
      '  -f) printf "?p\\n"; exit 0 ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n')
    const f = join(dir, 'stat')
    writeFileSync(f, body)
    chmodSync(f, 0o755)
    return dir
  }

  it('FAIL: under a GNU-like stat (-f is the filesystem status) an open password file is still refused, and an unreadable mode fails closed', async () => {
    const shim = gnuLikeStatShim()
    const withShim = { PATH: `${shim}:${toolPath}` }
    // GNU -c prints 644: the file is refused with the real mode (the old order asked -f first and got "?p")
    const open = runDrill(dumpSeeded, { ...withShim, STAT_SHIM_MODE: '644' })
    expect(open.status).toBe(1)
    expect(lastLine(open.stderr)).toContain('has mode 644')
    expect(lastLine(open.stderr)).toContain('must be 0600')
    // a stat that answers with something that is not an octal mode: fail closed, naming it
    const garbage = runDrill(dumpSeeded, { ...withShim, STAT_SHIM_MODE: 'not-a-mode' })
    expect(garbage.status).toBe(1)
    expect(lastLine(garbage.stderr)).toContain("cannot read the mode of")
    expect(lastLine(garbage.stderr)).toContain("(got 'not-a-mode')")
    // and a GNU-like stat on a 0600 file passes (the guard is not a blanket refusal)
    const ok = runDrill(dumpSeeded, { ...withShim, STAT_SHIM_MODE: '600' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(await leftovers()).toEqual([])
  }, 180000)

  it('the drill role is no member of the owner role, reads nothing of the live database and can drop no database of anyone else', async () => {
    const members = await admin.query(
      `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1`, [DRILL])
    expect(members.rows[0].n).toBe(0)
    const foreign = `drilltest_foreign_${suffix}`
    await adminSql(`CREATE DATABASE ${quote(foreign)}`)
    const as = async (database: string, sql: string): Promise<string | null> => {
      const c = new pg.Client({ host, port: Number(port), user: DRILL, password: DRILL_PASSWORD, database })
      await c.connect()
      try { await c.query(sql); return null } catch (e) { return (e as Error).message } finally { await c.end() }
    }
    try {
      expect(await as(live.name, 'SELECT count(*) FROM memories')).toMatch(/permission denied/)
      expect(await as(maintDb, `DROP DATABASE ${quote(live.name)}`)).toMatch(/must be owner/)
      expect(await as(maintDb, `DROP DATABASE ${quote(foreign)}`)).toMatch(/must be owner/)
    } finally {
      await adminSql(`DROP DATABASE IF EXISTS ${quote(foreign)} WITH (FORCE)`)
    }
  }, 60000)

  it('FAIL: a backup role that does not bypass row-level security is refused (both sides would count 0 and 0 = 0 would pass), nothing is created', async () => {
    const weak = `drilltest_nobypass_${suffix}`
    await adminSql(`CREATE ROLE ${quote(weak)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'harness-only-weak'`)
    try {
      const weakPass = passfile('pgpass-weak', weak, 'harness-only-weak')
      const r = runDrill(dumpSeeded, { PG_DRILL_BACKUP_ROLE: weak, PG_DRILL_BACKUP_PASSFILE: weakPass })
      expect(r.status).toBe(1)
      expect(lastLine(r.stderr)).toContain(`role ${weak} neither bypasses row-level security`)
      expect(await leftovers()).toEqual([])
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${quote(weak)}`).catch(() => undefined)
    }
  }, 90000)

  it('FAIL: a backup password file whose database field names only the live database is refused in the preflight, with the fix, and nothing is created', async () => {
    const liveOnly = passfile('pgpass-backup-live-only', PG_TEST_BACKUP_ROLE, BACKUP_PASSWORD, 0o600, live.name)
    const r = runDrill(dumpSeeded, { PG_DRILL_BACKUP_PASSFILE: liveOnly })
    expect(r.status).toBe(1)
    expect(lastLine(r.stderr)).toContain(`cannot connect as ${PG_TEST_BACKUP_ROLE} to ${TEMPLATE}`)
    expect(lastLine(r.stderr)).toContain('database field')
    expect(lastLine(r.stderr)).toContain('must be *')
    expect(await leftovers()).toEqual([])
    expect(r.stderr).not.toContain(BACKUP_PASSWORD)
  }, 90000)

  it('orphans: a 30 hour old throwaway database of the drill role is dropped at the start; a 1 hour old one, another owner\'s and a differently named one stay', async () => {
    const stamp = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const old = `marveen_drill_${stamp(30)}_90001`
    const young = `marveen_drill_${stamp(1)}_90002`
    const foreignOwner = `marveen_drill_${stamp(30)}_90003`
    const otherName = `marveen_drill_notastamp_${suffix}`
    const created = [old, young, foreignOwner, otherName]
    try {
      for (const [name, owner] of [[old, DRILL], [young, DRILL], [foreignOwner, NOCREATEDB], [otherName, DRILL]] as const) {
        await adminSql(`CREATE DATABASE ${quote(name)} TEMPLATE template0 OWNER ${quote(owner)}`)
      }
      const r = runDrill(dumpSeeded)
      expect(r.status, r.stderr).toBe(0)
      expect(lastLine(r.stdout)).toContain('-- dropped 1 orphaned throwaway database(s) of earlier runs')
      // the other owner's database is not even tried (the drill role could not drop it anyway: the owner filter is what keeps the
      // run from reporting a failed drop of something that was never its own)
      expect(lastLine(r.stdout)).not.toContain('could NOT drop')
      const left = (await live.pool.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [created])).rows.map((x) => x.datname).sort()
      expect(left).toEqual([young, foreignOwner, otherName].sort())
    } finally {
      for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`).catch(() => undefined)
    }
    expect(await leftovers()).toEqual([])
  }, 120000)

  it('the throwaway database is dropped even when WITH (FORCE) is refused (a real restore wakes an autovacuum worker the drill role may not terminate)', async () => {
    // A psql shim that refuses every DROP ... WITH (FORCE) the way PostgreSQL refuses a non-superuser that must terminate an
    // autovacuum worker, and passes everything else to the real psql. The drop must work through the plain DROP.
    const dir = mkdtempSync(join(work, 'psqlshim-'))
    const real = spawnSync('sh', ['-c', 'command -v psql'], { encoding: 'utf8', env: { PATH: toolPath } }).stdout.trim()
    expect(real).not.toBe('')
    const shim = join(dir, 'psql')
    writeFileSync(shim, [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in',
      '    *"WITH (FORCE)"*) echo "ERROR:  permission denied to terminate process" >&2; exit 1 ;;',
      '  esac',
      'done',
      'exec "${REAL_PSQL}" "$@"',
      '',
    ].join('\n'))
    chmodSync(shim, 0o755)
    const r = runDrill(dumpSeeded, { PATH: `${dir}:${toolPath}`, REAL_PSQL: real })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toBe('')
    expect(await leftovers()).toEqual([])
  }, 120000)

  it('FAIL: a pg_restore of another major than the server, a dump header newer than the server and an unreadable version are refused with the fix named, and no throwaway database is created', async () => {
    // a pg_restore shim: --version says SHIM_PG_RESTORE_VERSION; -l (the listing) rewrites the "Dumped by pg_dump version" header
    // to SHIM_DUMP_MAJOR when that is set (a simulated newer dump); everything else goes to the real pg_restore
    const dir = mkdtempSync(join(work, 'restoreshim-'))
    const real = spawnSync('sh', ['-c', 'command -v pg_restore'], { encoding: 'utf8', env: { PATH: toolPath } }).stdout.trim()
    expect(real).not.toBe('')
    const shim = join(dir, 'pg_restore')
    writeFileSync(shim, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "${SHIM_PG_RESTORE_VERSION}"; exit 0; fi',
      'if [ "$1" = "-l" ] && [ -n "${SHIM_DUMP_MAJOR}" ]; then',
      '  "${REAL_PG_RESTORE}" "$@" | sed "s/Dumped by pg_dump version: [0-9][0-9]*/Dumped by pg_dump version: ${SHIM_DUMP_MAJOR}/"',
      '  exit 0',
      'fi',
      'exec "${REAL_PG_RESTORE}" "$@"',
      '',
    ].join('\n'))
    chmodSync(shim, 0o755)
    const serverMajor = toolMajor('pg_restore', toolPath) as number
    const withShim = (extra: Record<string, string>): Record<string, string> => ({
      PATH: `${dir}:${toolPath}`, REAL_PG_RESTORE: real, SHIM_PG_RESTORE_VERSION: `pg_restore (PostgreSQL) ${serverMajor}.0`, SHIM_DUMP_MAJOR: '', ...extra,
    })

    // the client is newer than the server (the 17 client against a 16 server of the CI runner)
    const newer = runDrill(dumpSeeded, withShim({ SHIM_PG_RESTORE_VERSION: `pg_restore (PostgreSQL) ${serverMajor + 1}.1` }))
    expect(newer.status).toBe(1)
    expect(lastLine(newer.stderr)).toContain(`is PostgreSQL ${serverMajor + 1}, not the server's major (${serverMajor})`)
    expect(lastLine(newer.stderr)).toContain('PG_DRILL_BIN_DIR')
    expect(await leftovers()).toEqual([])

    // the client is older than the server: not the same major either
    const older = runDrill(dumpSeeded, withShim({ SHIM_PG_RESTORE_VERSION: `pg_restore (PostgreSQL) ${serverMajor - 1}.9` }))
    expect(older.status).toBe(1)
    expect(lastLine(older.stderr)).toContain(`is PostgreSQL ${serverMajor - 1}, not the server's major (${serverMajor})`)
    expect(await leftovers()).toEqual([])

    // the dump was made by a newer pg_dump than the server (the header of the listing says so)
    const newerDump = runDrill(dumpSeeded, withShim({ SHIM_DUMP_MAJOR: String(serverMajor + 1) }))
    expect(newerDump.status).toBe(1)
    expect(lastLine(newerDump.stderr)).toContain(`was made by pg_dump ${serverMajor + 1}, newer than the server (${serverMajor})`)
    expect(await leftovers()).toEqual([])

    // an unreadable client version fails closed
    const garbage = runDrill(dumpSeeded, withShim({ SHIM_PG_RESTORE_VERSION: 'something else entirely' }))
    expect(garbage.status).toBe(1)
    expect(lastLine(garbage.stderr)).toContain('cannot determine the versions')
    expect(await leftovers()).toEqual([])

    // an OLDER dump header (dumped by pg_dump of an older major) is fine: the same-major client restores it
    const olderDump = runDrill(dumpSeeded, withShim({ SHIM_DUMP_MAJOR: String(serverMajor - 1) }))
    expect(olderDump.status, olderDump.stderr).toBe(0)
  }, 180000)
})

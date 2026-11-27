// scripts/pg-restore-drill.sh against a real PostgreSQL 16 server (the PG test harness, never the live cluster).
//
// The script is run as the operator's command task runs it: a spawned process with its own environment. The "live" database
// is a harness database (the real baseline schema, row-level security forced), the dump is a real `pg_dump -Fc` taken the
// way the nightly job takes it (the backup role, which bypasses row-level security, with the provisioning grants of
// docs/pg-provisioning.md step 5), and the restoring role is a test role with CREATEDB that is a member of marveen_owner
// (the dump carries `ALTER DEFAULT PRIVILEGES FOR ROLE marveen_owner`, which only a member may restore). No credential is
// real: the passwords are the harness-only throwaway values, written into 0600 password files, never into argv.
//
// Cells: OK (equal; live ahead inside the tolerance; the fixed default list); FAIL (live ahead beyond the tolerance;
// restored has more rows than live; restored copy empty while live is not, whatever the tolerance; stale dump; checksum
// mismatch or missing sidecar; no dump or only a probe dump; a restore that fails half way; an unknown table); the
// throwaway database is dropped after every one of them, success or failure; each missing precondition is named and
// nothing is created; no password in the output and none in the script. Each rule is a mutant of the script that turns
// its cell red (the PR description lists them).
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgTestDb, pgTestUrl, PG_TEST_BACKUP_ROLE, PG_TEST_OWNER_ROLE, type PgTestDb } from '../../src/__tests__/helpers/pg-test-db.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const script = join(repo, 'scripts', 'pg-restore-drill.sh')
const BACKUP_PASSWORD = 'harness-only-backup' // the harness value of marveen_backup (src/__tests__/helpers/pg-test-db.ts)
const DRILL_OWNER_PASSWORD = 'harness-only-drill-owner'
const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

const suffix = randomBytes(4).toString('hex')
const OWNER = `drilltest_owner_${suffix}`
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
let backupPass: string
let ownerPass: string
let nocreatedbPass: string
let dumpDirs: string[] = []

/** One cluster-level statement as the harness admin. */
async function adminSql(sql: string): Promise<void> {
  await admin.query(sql)
}

function passfile(name: string, role: string, password: string, mode = 0o600): string {
  const p = join(work, name)
  writeFileSync(p, `${host}:${port}:*:${role}:${password}\n`)
  chmodSync(p, mode)
  return p
}

/** pg_dump -Fc of the live database as the backup role, into a new directory, named and checksummed as the nightly job does. */
function makeDump(opts: { ageHours?: number; name?: string; sidecar?: 'ok' | 'wrong' | 'none' } = {}): string {
  const dir = mkdtempSync(join(work, 'dumps-'))
  dumpDirs.push(dir)
  const file = join(dir, opts.name ?? 'marveen-20261127-033014.dump')
  const r = spawnSync('pg_dump', ['-Fc', '-h', host, '-p', port, '-U', PG_TEST_BACKUP_ROLE, '-d', live.name, '-f', file], {
    env: { PATH: process.env.PATH ?? '', PGPASSFILE: backupPass },
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
    PATH: process.env.PATH ?? '',
    HOME: work,
    PG_DRILL_DUMP_DIR: dumpDir,
    PG_DRILL_BIN_DIR: '', // empty: the tools come from PATH
    PG_DRILL_HOST: host,
    PG_DRILL_PORT: port,
    PG_DRILL_DB: live.name,
    PG_DRILL_MAINT_DB: maintDb,
    PG_DRILL_OWNER_ROLE: OWNER,
    PG_DRILL_BACKUP_ROLE: PG_TEST_BACKUP_ROLE,
    PG_DRILL_TEMPLATE: TEMPLATE,
    PG_DRILL_OWNER_PASSFILE: ownerPass,
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
  live = await createPgTestDb() // also makes sure the harness roles exist
  preexisting = new Set(await throwawayDatabases())

  // roles: the restoring role is a member of marveen_owner with CREATEDB (the harness owner has none and the harness keeps it
  // that way), a second one has no CREATEDB for the precondition cell
  await adminSql(`CREATE ROLE ${quote(OWNER)} LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD '${DRILL_OWNER_PASSWORD}'`)
  await adminSql(`GRANT ${quote(PG_TEST_OWNER_ROLE)} TO ${quote(OWNER)}`)
  await adminSql(`CREATE ROLE ${quote(NOCREATEDB)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${DRILL_OWNER_PASSWORD}'`)
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
  ownerPass = passfile('pgpass-owner', OWNER, DRILL_OWNER_PASSWORD)
  nocreatedbPass = passfile('pgpass-nocreatedb', NOCREATEDB, DRILL_OWNER_PASSWORD)

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
    for (const role of [OWNER, NOCREATEDB]) await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`).catch(() => undefined)
  } finally {
    await admin?.end()
    rmSync(work, { recursive: true, force: true })
  }
})

describe('pg-restore-drill.sh', () => {
  it('OK: a dump of the seeded database restores and every table matches; one summary line, nothing left behind', async () => {
    const r = runDrill(dumpSeeded)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
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
    } finally {
      await live.pool.query("DELETE FROM memories WHERE content LIKE 'ahead-%'")
    }
  }, 90000)

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

  it('FAIL: the restored copy holds more rows than the live database (rows lost since the dump)', async () => {
    await live.pool.query("DELETE FROM memories WHERE content = 'seed-0'")
    try {
      const r = runDrill(dumpSeeded)
      expect(r.status).toBe(1)
      expect(lastLine(r.stderr)).toContain('memories: restored 5 > live 4')
      expect(await leftovers()).toEqual([])
    } finally {
      await insertMemories(1, 'seed-restore')
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
    const noCreatedb = runDrill(dumpSeeded, { PG_DRILL_OWNER_ROLE: NOCREATEDB, PG_DRILL_OWNER_PASSFILE: nocreatedbPass })
    expect(noCreatedb.status).toBe(1)
    expect(lastLine(noCreatedb.stderr)).toContain(`role ${NOCREATEDB} lacks CREATEDB`)

    const noTemplate = runDrill(dumpSeeded, { PG_DRILL_TEMPLATE: `drilltest_missing_${suffix}` })
    expect(noTemplate.status).toBe(1)
    expect(lastLine(noTemplate.stderr)).toContain(`template database drilltest_missing_${suffix} does not exist`)

    const notTemplate = runDrill(dumpSeeded, { PG_DRILL_TEMPLATE: live.name })
    expect(notTemplate.status).toBe(1)
    expect(lastLine(notTemplate.stderr)).toContain(`database ${live.name} exists but is not a template`)

    const noRole = runDrill(dumpSeeded, { PG_DRILL_APP_ROLE: `drilltest_norole_${suffix}` })
    expect(noRole.status).toBe(1)
    expect(lastLine(noRole.stderr)).toContain('must all exist before a restore')

    const noFile = runDrill(dumpSeeded, { PG_DRILL_OWNER_PASSFILE: join(work, 'does-not-exist') })
    expect(noFile.status).toBe(1)
    expect(lastLine(noFile.stderr)).toContain('owner role password file')
    expect(lastLine(noFile.stderr)).toContain('does not exist')

    const open = passfile('pgpass-open', OWNER, DRILL_OWNER_PASSWORD, 0o644)
    const openMode = runDrill(dumpSeeded, { PG_DRILL_OWNER_PASSFILE: open })
    expect(openMode.status).toBe(1)
    expect(lastLine(openMode.stderr)).toContain('must be 0600')

    const wrongPassword = passfile('pgpass-wrong', OWNER, 'not-the-password')
    const badLogin = runDrill(dumpSeeded, { PG_DRILL_OWNER_PASSFILE: wrongPassword })
    expect(badLogin.status).toBe(1)
    expect(lastLine(badLogin.stderr)).toContain(`cannot connect as ${OWNER}`)
    expect(await leftovers()).toEqual([])
  }, 180000)

  it('FAIL: the throwaway database is dropped when the run is cut off by a signal after it was created', async () => {
    // a signal during the restore: SIGTERM the script as soon as a throwaway database shows up
    const p = spawn('bash', [script], {
      env: {
        PATH: process.env.PATH ?? '', HOME: work, PG_DRILL_DUMP_DIR: dumpSeeded, PG_DRILL_BIN_DIR: '', PG_DRILL_HOST: host,
        PG_DRILL_PORT: port, PG_DRILL_DB: live.name, PG_DRILL_MAINT_DB: maintDb, PG_DRILL_OWNER_ROLE: OWNER,
        PG_DRILL_BACKUP_ROLE: PG_TEST_BACKUP_ROLE, PG_DRILL_TEMPLATE: TEMPLATE, PG_DRILL_OWNER_PASSFILE: ownerPass,
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
    const outputs = [runDrill(dumpSeeded), runDrill(dumpSeeded, { PG_DRILL_OWNER_PASSFILE: join(work, 'does-not-exist') })]
    for (const o of outputs) {
      for (const secret of [BACKUP_PASSWORD, DRILL_OWNER_PASSWORD, 'harness-only']) {
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
})

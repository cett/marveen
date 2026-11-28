// Parity of the hook-side PostgreSQL switch (scripts/hooks/hook_pg_mode.py): the Python function, the app's own rule
// (resolvePgUrl() or the marker) and the shell reference (scripts/pg-configured.sh) must give the SAME boolean on the
// same fixture. A hook that read SQLite where the app reads PostgreSQL would decide from a stale file; one that read
// the route where the app is on SQLite would fail closed for nothing. A divergence is resolved toward the app.
//
// Privacy: neutral fixtures only (leakmarker, placeholder-pass).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const INSTALL = resolve(__dirname, '..', '..')
const URL = 'postgres://user:placeholder-pass@leakmarker.invalid:5432/db'

interface Fixture {
  name: string
  /** the secret mount file content (null: no file) */
  mount?: string | null
  /** the MARVEEN_PG_URL environment variable (undefined: not set) */
  env?: string
  /** the .env file content (null: no file) */
  dotenv?: string | null
  /** the .env is present but cannot be read */
  unreadableDotenv?: boolean
  /** the store marker <install>/store/.pg-installed is present (the fifth layer, P-E: durable, written by the PG boot) */
  storeMarker?: boolean
  /** the marker MARVEEN_PG_CONFIGURED=1 */
  marker?: boolean
  /** the store dir holds the marker but has no search bit: the marker cannot be stat'ed (a chmod row: skipped as root) */
  unreadableStore?: boolean
  /** the store path is a regular file, not a directory */
  storeIsFile?: boolean
  /** the MARVEEN_STORE_DIR environment variable names an env store: 'marker' (the marker is in it) or 'empty' (it is not) */
  envStore?: 'marker' | 'empty'
  /** the answer the app must give (a row that pins the rule, not only the agreement of the three readers) */
  expect?: 'PG' | 'SQLite'
}

// The table of src/__tests__/backup-guard-parity.test.ts, row for row (a cell below pins that no row was dropped),
// plus the rows only the Python parser can get wrong.
const FIXTURES: Fixture[] = [
  { name: 'mount with a URL', mount: `${URL}\n` },
  { name: 'mount blank', mount: '   \n' },
  { name: 'environment with a URL', env: URL },
  { name: 'environment whitespace', env: '   ' },
  { name: '.env with a URL', dotenv: `MARVEEN_PG_URL=${URL}\n` },
  { name: '.env with a quoted URL', dotenv: `MARVEEN_PG_URL="${URL}"\n` },
  { name: '.env blank value', dotenv: 'MARVEEN_PG_URL=   \n' },
  { name: '.env with leading spaces before the key', dotenv: `  MARVEEN_PG_URL=${URL}\n` },
  { name: '.env with a tab before the key', dotenv: `\tMARVEEN_PG_URL=${URL}\n` },
  { name: '.env with spaces around the equals sign', dotenv: `MARVEEN_PG_URL = ${URL}\n` },
  { name: 'marker only', marker: true },
  { name: 'a readable .env without a URL, and the marker only', dotenv: 'OTHER_KEY=1\n', marker: true },
  { name: '.env value is an empty double-quoted pair', dotenv: 'MARVEEN_PG_URL=""\n' },
  { name: '.env value is an empty single-quoted pair', dotenv: "MARVEEN_PG_URL=''\n" },
  { name: '.env with CRLF line endings', dotenv: `MARVEEN_PG_URL=${URL}\r\n` },
  { name: '.env with a commented line', dotenv: `# MARVEEN_PG_URL=${URL}\n` },
  { name: '.env: a URL then a blank value (the last one wins: not PostgreSQL)', dotenv: `MARVEEN_PG_URL=${URL}\nMARVEEN_PG_URL=\n` },
  { name: '.env: a blank value then a URL (the last one wins: PostgreSQL)', dotenv: `MARVEEN_PG_URL=\nMARVEEN_PG_URL=${URL}\n` },
  { name: 'all absent', mount: null, dotenv: null },
  { name: 'unreadable .env with the marker', unreadableDotenv: true, marker: true },
  { name: 'unreadable .env without the marker', unreadableDotenv: true },
  { name: 'a URL in the mount and the marker', mount: `${URL}\n`, marker: true },
  // the fifth layer: the store marker outlives the configuration (a lost .env, a shell without the variable)
  { name: 'store marker alone (no URL anywhere, no variable)', storeMarker: true },
  { name: 'store marker with a blank URL in the .env', storeMarker: true, dotenv: 'MARVEEN_PG_URL=   \n' },
  { name: 'store marker with an unreadable .env', storeMarker: true, unreadableDotenv: true },
  { name: 'store marker absent, nothing configured', storeMarker: false },
  // one rule for an unreadable store (P-E, decision 3): the marker is PRESENT when its store cannot be read or is not a
  // directory; a store that does not exist at all stays absent (the row above)
  { name: 'store dir without the search bit (the marker inside cannot be read)', unreadableStore: true, expect: 'PG' },
  { name: 'store path is a regular file, not a directory', storeIsFile: true, expect: 'PG' },
  // the second place (P-E, decision 4): the hooks and the shell look in <install>/store AND in $MARVEEN_STORE_DIR when it is
  // set; the app reads its own store only, so a row that names an env store compares the app against THAT store
  { name: 'store marker in the environment store alone (MARVEEN_STORE_DIR set)', envStore: 'marker', expect: 'PG' },
  { name: 'environment store set and empty, no marker anywhere', envStore: 'empty', expect: 'SQLite' },
  // rows that are specific to the Python parser (not in the shell table)
  { name: 'py-only: a lone double quote as the value', dotenv: 'MARVEEN_PG_URL="\n' },
  { name: 'py-only: a value with a space inside the quotes only', dotenv: 'MARVEEN_PG_URL=" "\n' },
  { name: 'py-only: a line without an equals sign', dotenv: 'MARVEEN_PG_URL\n' },
  { name: 'py-only: the URL contains an equals sign (split at the first one)', dotenv: 'MARVEEN_PG_URL=a=b\n' },
  { name: 'py-only: another key that only contains the name', dotenv: `X_MARVEEN_PG_URL=${URL}\n` },
]

/** One fixture on disk: the secret mount, the install root, and the env store (MARVEEN_STORE_DIR when a row sets it). */
interface Case {
  mountDir: string
  installRoot: string
  envStoreDir: string
}

let root: string
/** directories a fixture made unsearchable: restored before the cleanup (rmSync cannot enter them otherwise) */
const toRestore: string[] = []
/** root reads through a 0000 directory, so the chmod rows say nothing there (nit 8): they are skipped */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hook-pg-parity-'))
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
  vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const p of toRestore.splice(0)) chmodSync(p, 0o755)
  rmSync(root, { recursive: true, force: true })
})

function materialise(f: Fixture): Case {
  const dir = mkdtempSync(join(root, 'case-'))
  const mountDir = join(dir, 'secrets')
  mkdirSync(mountDir)
  if (f.mount !== undefined && f.mount !== null) writeFileSync(join(mountDir, 'MARVEEN_PG_URL'), f.mount)
  const installRoot = join(dir, 'install')
  mkdirSync(installRoot)
  if (f.dotenv !== undefined && f.dotenv !== null) writeFileSync(join(installRoot, '.env'), f.dotenv)
  if (f.unreadableDotenv) {
    writeFileSync(join(installRoot, '.env'), `MARVEEN_PG_URL=${URL}\n`)
    chmodSync(join(installRoot, '.env'), 0o000)
  }
  if (f.storeMarker || f.unreadableStore) {
    mkdirSync(join(installRoot, 'store'))
    writeFileSync(join(installRoot, 'store', '.pg-installed'), 'pg-installed 2026-11-28T00:00:00.000Z\n')
  }
  if (f.unreadableStore) {
    chmodSync(join(installRoot, 'store'), 0o000)
    toRestore.push(join(installRoot, 'store'))
  }
  if (f.storeIsFile) writeFileSync(join(installRoot, 'store'), 'not a directory\n')
  const envStoreDir = join(dir, 'env-store')
  mkdirSync(envStoreDir)
  if (f.envStore === 'marker') writeFileSync(join(envStoreDir, '.pg-installed'), 'pg-installed 2026-11-28T00:00:00.000Z\n')
  return { mountDir, installRoot, envStoreDir }
}

function childEnv(f: Fixture, c: Case): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SECRET_MOUNT_DIR: c.mountDir }
  if (f.envStore !== undefined) env.MARVEEN_STORE_DIR = c.envStoreDir
  if (f.env !== undefined) env.MARVEEN_PG_URL = f.env
  if (f.marker) env.MARVEEN_PG_CONFIGURED = '1'
  return env
}

/** The shell reference: scripts/pg-configured.sh. */
function shellAnswer(f: Fixture, c: Case): string {
  const text = readFileSync(join(INSTALL, 'scripts', 'pg-configured.sh'), 'utf-8')
  // from the first helper on (pg_store_marker_at sits above pg_configured): the functions the answer needs
  const script = `${text.slice(text.indexOf('pg_store_marker_at() {'))}\npg_configured "${c.installRoot}" && echo PG || echo SQLite\n`
  return spawnSync('bash', ['-c', script], { env: childEnv(f, c), encoding: 'utf-8' }).stdout.trim()
}

function pythonRun(f: Fixture, c: Case, expr: string) {
  const code = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(join(INSTALL, 'scripts', 'hooks'))})`,
    'import hook_pg_mode',
    `print(${expr.replace('ROOT', JSON.stringify(c.installRoot))})`,
  ].join('\n')
  return spawnSync('python3', ['-I', '-c', code], { env: childEnv(f, c), encoding: 'utf-8' })
}

/** The hook function, run in its own interpreter with the same environment the shell got. */
function pythonAnswer(f: Fixture, c: Case): string {
  const run = pythonRun(f, c, '"PG" if hook_pg_mode.pg_mode(ROOT) else "SQLite"')
  return run.stdout.trim() || `ERROR: ${run.stderr}`
}

/** The app's answer: a URL resolves through the app's own layers, or the marker. */
async function appAnswer(f: Fixture, c: Case): Promise<string> {
  vi.resetModules()
  process.env.SECRET_MOUNT_DIR = c.mountDir
  process.env.CLAUDECLAW_ENV_DIR = c.installRoot
  if (f.env !== undefined) process.env.MARVEEN_PG_URL = f.env
  else delete process.env.MARVEEN_PG_URL
  if (f.marker) process.env.MARVEEN_PG_CONFIGURED = '1'
  else delete process.env.MARVEEN_PG_CONFIGURED
  const url = await import('../db/pg/url.js')
  const resolved = url.resolvePgUrl() !== undefined
  const marker = process.env.MARVEEN_PG_CONFIGURED === '1'
  // the store marker, the fifth layer: the app's OWN reader (the same function its SQLite entry calls, decision D3),
  // applied to the install's store dir (the parity cell measures the real reader, not a second existsSync)
  // the app reads its OWN store only: the env store when the row names one, else the install's store (P-E)
  const appStore = f.envStore !== undefined ? c.envStoreDir : join(c.installRoot, 'store')
  const storeMarker = url.pgInstallMarkerPresentIn(appStore)
  return resolved || marker || storeMarker ? 'PG' : 'SQLite'
}

describe('the hook-side PostgreSQL switch: Python, the app and pg-configured.sh agree on every fixture', () => {
  for (const f of FIXTURES) {
    it.skipIf(f.unreadableStore === true && isRoot)(`fixture "${f.name}"`, async () => {
      const c = materialise(f)
      const app = await appAnswer(f, c)
      if (f.expect !== undefined) expect(app, `the app on "${f.name}"`).toBe(f.expect)
      expect(pythonAnswer(f, c), `python on "${f.name}"`).toBe(app)
      expect(shellAnswer(f, c), `pg-configured.sh on "${f.name}"`).toBe(app)
    })
  }

  it('the fixture table is not vacuous: it contains both PostgreSQL and SQLite answers', () => {
    const answers = new Set<string>()
    for (const f of FIXTURES) {
      const c = materialise(f)
      answers.add(pythonAnswer(f, c))
    }
    expect([...answers].sort()).toEqual(['PG', 'SQLite'])
  })

  it('the table keeps every row of the shell guard parity cell: no row was dropped or renamed', () => {
    const other = readFileSync(join(INSTALL, 'src', '__tests__', 'backup-guard-parity.test.ts'), 'utf-8')
    const names = [...other.matchAll(/^\s*\{ name: (['"`])(.*?)\1,/gm)].map((m) => m[2])
    expect(names.length).toBeGreaterThan(15)
    const ours = new Set(FIXTURES.map((f) => f.name))
    for (const n of names) expect(ours.has(n.replace(/\\'/g, "'")), n).toBe(true)
  })

  it('the function returns a boolean and leaks no part of the URL', () => {
    const f: Fixture = { name: 'leak', env: URL }
    const c = materialise(f)
    const run = pythonRun(f, c, 'repr(hook_pg_mode.pg_mode(ROOT))')
    expect(run.stdout.trim()).toBe('True')
    expect(run.stdout + run.stderr).not.toContain('leakmarker')
  })
})

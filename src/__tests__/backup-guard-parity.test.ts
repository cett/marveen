// Parity of the stale-SQLite guard (G5, A5): the shell detection function (scripts/pg-configured.sh, and the copies inlined
// in scripts/backup.sh and scripts/restore-drill.sh) and the app's own rule (resolvePgUrl() or the marker that the guard
// refuses on) must give the same answer on the same fixture. A divergence is a finding about the fixture, resolved
// toward the app. Every copy is run, so a copy that drifts cannot hide behind the others.
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
  /** the marker MARVEEN_PG_CONFIGURED=1 */
  marker?: boolean
}

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
]

// One source: backup.sh and restore-drill.sh source scripts/pg-configured.sh, so the function that runs is this one.
const COPIES = [{ file: 'scripts/pg-configured.sh', extract: (t: string) => t.slice(t.indexOf('pg_configured() {')) }]

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-parity-'))
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
  vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** Writes the fixture to a fresh directory: returns the mount dir and the install root (with or without the .env). */
function materialise(f: Fixture): { mountDir: string; installRoot: string } {
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
  return { mountDir, installRoot }
}

/** The shell answer of one copy: 'PG' when pg_configured returns 0, 'SQLite' otherwise. */
function shellAnswer(copyFile: string, extract: (t: string) => string, f: Fixture, mountDir: string, installRoot: string): string {
  const text = readFileSync(join(INSTALL, copyFile), 'utf-8')
  const fn = extract(text)
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SECRET_MOUNT_DIR: mountDir }
  if (f.env !== undefined) env.MARVEEN_PG_URL = f.env
  if (f.marker) env.MARVEEN_PG_CONFIGURED = '1'
  const script = `${fn}\npg_configured "${installRoot}" && echo PG || echo SQLite\n`
  const run = spawnSync('bash', ['-c', script], { env, encoding: 'utf-8' })
  return run.stdout.trim()
}

/** The app's answer: a URL resolves through the app's own layers, or the marker (which the boot guard refuses on). */
async function appAnswer(f: Fixture, mountDir: string, installRoot: string): Promise<string> {
  vi.resetModules()
  process.env.SECRET_MOUNT_DIR = mountDir
  process.env.CLAUDECLAW_ENV_DIR = installRoot
  if (f.env !== undefined) process.env.MARVEEN_PG_URL = f.env
  else delete process.env.MARVEEN_PG_URL
  if (f.marker) process.env.MARVEEN_PG_CONFIGURED = '1'
  else delete process.env.MARVEEN_PG_CONFIGURED
  const url = await import('../db/pg/url.js')
  const resolved = url.resolvePgUrl() !== undefined
  const marker = process.env.MARVEEN_PG_CONFIGURED === '1'
  return resolved || marker ? 'PG' : 'SQLite'
}

describe('the stale-SQLite guard: every shell copy agrees with the app', () => {
  for (const f of FIXTURES) {
    it(`fixture "${f.name}"`, async () => {
      const { mountDir, installRoot } = materialise(f)
      const app = await appAnswer(f, mountDir, installRoot)
      for (const copy of COPIES) {
        const shell = shellAnswer(copy.file, copy.extract, f, mountDir, installRoot)
        expect(shell, `${copy.file} on "${f.name}"`).toBe(app)
      }
    })
  }

  it('the fixture table is not vacuous: it contains both PostgreSQL and SQLite answers', async () => {
    const answers = new Set<string>()
    for (const f of FIXTURES) {
      const { mountDir, installRoot } = materialise(f)
      answers.add(await appAnswer(f, mountDir, installRoot))
    }
    expect([...answers].sort()).toEqual(['PG', 'SQLite'])
  })

  it('backup.sh and restore-drill.sh source the one reference and hold no copy of the function', () => {
    for (const name of ['backup.sh', 'restore-drill.sh']) {
      const text = readFileSync(join(INSTALL, 'scripts', name), 'utf-8')
      expect(text, name).toContain('. "${REPO_ROOT}/scripts/pg-configured.sh"')
      expect(text, name).not.toMatch(/^pg_configured\(\) \{/m)
    }
  })
})

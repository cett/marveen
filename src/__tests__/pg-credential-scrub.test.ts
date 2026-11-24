// capturePgCredentials() (db/pg/url.ts): the two PostgreSQL URL keys leave process.env at process start, and the resolvers
// still return the same values afterwards, in the same precedence (secret mount, then captured/env, then the .env file).
//
// Privacy: neutral fixtures only (host-a.invalid, user-a, placeholder-a).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ENV = 'postgresql://user-a:placeholder-a@host-a.invalid:5432/db-a'
const URL_MIGRATE = 'postgresql://owner-b:placeholder-b@host-b.invalid:5432/db-b'
const URL_MOUNT = 'postgresql://user-c:placeholder-c@host-c.invalid:5432/db-c'
const URL_FILE = 'postgresql://user-d:placeholder-d@host-d.invalid:5432/db-d'

let root: string
let envDir: string
let secretDir: string

/** A fresh module graph: the directories are read when the modules load. */
async function load() {
  vi.resetModules()
  return await import('../db/pg/url.js')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pg-credential-scrub-'))
  envDir = join(root, 'env')
  secretDir = join(root, 'secrets')
  mkdirSync(envDir)
  mkdirSync(secretDir)
  vi.stubEnv('CLAUDECLAW_ENV_DIR', envDir)
  vi.stubEnv('SECRET_MOUNT_DIR', secretDir)
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.stubEnv('MARVEEN_PG_MIGRATE_URL', '')
  // the marker is set by the capture: stubbed so the teardown restores the environment of the worker
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const writeEnvFile = (lines: string) => writeFileSync(join(envDir, '.env'), `${lines}\n`)
const writeSecret = (value: string) => writeFileSync(join(secretDir, 'MARVEEN_PG_URL'), value)

describe('capturePgCredentials', () => {
  it('removes both keys from process.env and the resolvers still return their values', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', URL_MIGRATE)
    const url = await load()
    url.capturePgCredentials()
    expect(process.env.MARVEEN_PG_URL).toBeUndefined()
    expect(process.env.MARVEEN_PG_MIGRATE_URL).toBeUndefined()
    expect(url.resolvePgUrl()).toBe(URL_ENV)
    expect(url.resolvePgMigrateUrl()).toBe(URL_MIGRATE)
  })

  it('an env-only install is not turned into "no URL" by the scrub', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    const url = await load()
    expect(url.resolvePgUrl()).toBe(URL_ENV)
    url.capturePgCredentials()
    expect(url.resolvePgUrl()).toBe(URL_ENV)
    expect(url.resolvePgUrl()).toBe(URL_ENV)
  })

  it('is idempotent: a second call keeps the captured values', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    const url = await load()
    url.capturePgCredentials()
    url.capturePgCredentials()
    expect(url.resolvePgUrl()).toBe(URL_ENV)
  })

  it('an empty or whitespace-only value is not captured, but the key is still removed from process.env', async () => {
    vi.stubEnv('MARVEEN_PG_URL', '   ')
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', '')
    writeEnvFile(`MARVEEN_PG_URL=${URL_FILE}`)
    const url = await load()
    url.capturePgCredentials()
    expect(process.env.MARVEEN_PG_URL).toBeUndefined()
    expect(process.env.MARVEEN_PG_MIGRATE_URL).toBeUndefined()
    // the whitespace capture did not shadow the .env layer
    expect(url.resolvePgUrl()).toBe(URL_FILE)
    expect(url.resolvePgMigrateUrl()).toBeUndefined()
  })

  it('the secret mount still beats the captured value', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    writeSecret(`${URL_MOUNT}\n`)
    const url = await load()
    url.capturePgCredentials()
    expect(url.resolvePgUrl()).toBe(URL_MOUNT)
  })

  it('the captured value beats the .env file of the install', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    writeEnvFile(`MARVEEN_PG_URL=${URL_FILE}`)
    const url = await load()
    url.capturePgCredentials()
    expect(url.resolvePgUrl()).toBe(URL_ENV)
  })

  it('the migrate key is captured on its own, not read from the serving key', async () => {
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', URL_MIGRATE)
    const url = await load()
    url.capturePgCredentials()
    expect(url.resolvePgMigrateUrl()).toBe(URL_MIGRATE)
    expect(url.resolvePgUrl()).toBeUndefined()
  })

  it('a test reset forgets the capture, so the next resolve reads process.env again', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    const url = await load()
    url.capturePgCredentials()
    url.resetPgCredentialCaptureForTests()
    expect(url.resolvePgUrl()).toBeUndefined()
  })
})

/** The environment keys a real child process sees (node -e prints them; no shell, no tmux). */
const childEnvKeys = (env?: NodeJS.ProcessEnv): string[] =>
  spawnSync(process.execPath, ['-e', 'process.stdout.write(Object.keys(process.env).join("\\n"))'], {
    env,
    encoding: 'utf-8',
  })
    .stdout.split('\n')
    .filter(Boolean)

describe('a child process does not inherit the URLs', () => {
  it('control: without the capture, a child sees the key (so the cells below are not vacuous)', () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    expect(childEnvKeys()).toContain('MARVEEN_PG_URL')
  })

  it('a spawn with the default environment sees neither key, and the resolver still returns the URL', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', URL_MIGRATE)
    const url = await load()
    url.capturePgCredentials()
    const keys = childEnvKeys()
    expect(keys).toContain('PATH')
    expect(keys).not.toContain('MARVEEN_PG_URL')
    expect(keys).not.toContain('MARVEEN_PG_MIGRATE_URL')
    expect(url.resolvePgUrl()).toBe(URL_ENV)
    expect(url.resolvePgMigrateUrl()).toBe(URL_MIGRATE)
  })

  it('a spawn with an explicit copy of process.env (the agent-side pattern) sees neither key', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', URL_MIGRATE)
    const url = await load()
    url.capturePgCredentials()
    const keys = childEnvKeys({ ...process.env, EXTRA_FLAG: '1' })
    expect(keys).toContain('EXTRA_FLAG')
    expect(keys).not.toContain('MARVEEN_PG_URL')
    expect(keys).not.toContain('MARVEEN_PG_MIGRATE_URL')
  })

  it('the tmux wrapper the agent launch uses (runTmux) runs tmux with neither key in its environment', async () => {
    const fakeTmux = join(root, 'fake-tmux')
    const seenEnv = join(root, 'tmux-env.txt')
    writeFileSync(fakeTmux, '#!/bin/sh\nenv > "$STUB_OUT"\n')
    chmodSync(fakeTmux, 0o755)
    vi.stubEnv('TMUX_BIN', fakeTmux)
    vi.stubEnv('STUB_OUT', seenEnv)
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', URL_MIGRATE)
    const url = await load()
    url.capturePgCredentials()
    // config.ts refuses a PostgreSQL URL without a snapshot; the wrapper module loads config.ts, so set the same empty one
    ;(await import('../config-snapshot.js')).setConfigSnapshot({})
    const { runTmux } = await import('../web/agent-process-session.js')
    runTmux(null, ['list-sessions'])
    const names = readFileSync(seenEnv, 'utf-8')
      .split('\n')
      .map((line) => line.split('=')[0])
    expect(names).toContain('STUB_OUT')
    expect(names).not.toContain('MARVEEN_PG_URL')
    expect(names).not.toContain('MARVEEN_PG_MIGRATE_URL')
  })
})

describe('the marker for the SQLite entry guard', () => {
  it('the capture sets the non-secret marker when a serving URL was captured', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_ENV)
    const url = await load()
    url.capturePgCredentials()
    expect(process.env.MARVEEN_PG_CONFIGURED).toBe('1')
  })

  it('the capture does not set the marker when no serving URL was captured', async () => {
    const url = await load()
    url.capturePgCredentials()
    expect(process.env.MARVEEN_PG_CONFIGURED).toBeFalsy()
  })

  it('a child-like process with the marker and no readable URL refuses the SQLite entry, and says where the URL goes', async () => {
    vi.stubEnv('MARVEEN_PG_CONFIGURED', '1')
    const url = await load()
    expect(() => url.assertSqliteEntryAllowed('scheduled-task')).toThrow(/cannot read MARVEEN_PG_URL/)
    expect(() => url.assertSqliteEntryAllowed('scheduled-task')).toThrow(/0600 \.env file/)
  })

  it('no marker and no URL: the SQLite entry is allowed (a SQLite install)', async () => {
    const url = await load()
    expect(() => url.assertSqliteEntryAllowed('scheduled-task')).not.toThrow()
  })

  it('the marker with a URL in the .env file: the standard refusal', async () => {
    writeEnvFile(`MARVEEN_PG_URL=${URL_FILE}`)
    vi.stubEnv('MARVEEN_PG_CONFIGURED', '1')
    const url = await load()
    expect(() => url.assertSqliteEntryAllowed('scheduled-task')).toThrow(/MARVEEN_PG_URL is set/)
  })
})

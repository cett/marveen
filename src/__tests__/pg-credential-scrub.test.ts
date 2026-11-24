// capturePgCredentials() (db/pg/url.ts): the two PostgreSQL URL keys leave process.env at process start, and the resolvers
// still return the same values afterwards, in the same precedence (secret mount, then captured/env, then the .env file).
//
// Privacy: neutral fixtures only (host-a.invalid, user-a, placeholder-a).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

// MARVEEN_PG_MIGRATE_URL (db/pg/url.ts): the second URL of the boot split, resolved through the same three layers as
// MARVEEN_PG_URL (the secret mount, process.env, the .env file of the install), first non-empty wins, and never mixed up with
// the serving URL.
//
// Privacy: neutral fixtures only (host-a, user-a, secret-a, db-a).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER_A = 'postgresql://owner-a:secret-a@host-a:5432/db-a'
const OWNER_B = 'postgres://owner-b:secret-b@host-b:5432/db-b'
const OWNER_C = 'postgresql://owner-c:secret-c@host-c:5432/db-c'
const APP_A = 'postgresql://app-a:secret-app@host-a:5432/db-a'

let root: string
let envDir: string
let secretDir: string

async function load() {
  vi.resetModules()
  return import('../db/pg/url.js')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pg-migrate-url-'))
  envDir = join(root, 'env')
  secretDir = join(root, 'secrets')
  for (const d of [envDir, secretDir]) mkdirSync(d)
  vi.stubEnv('CLAUDECLAW_ENV_DIR', envDir)
  vi.stubEnv('SECRET_MOUNT_DIR', secretDir)
  vi.stubEnv('MARVEEN_PG_URL', '')
  vi.stubEnv('MARVEEN_PG_MIGRATE_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const writeEnvFile = (line: string) => writeFileSync(join(envDir, '.env'), `${line}\n`)
const writeSecret = (key: string, value: string) => writeFileSync(join(secretDir, key), value)

describe('resolvePgMigrateUrl', () => {
  it('names its own key', async () => {
    const url = await load()
    expect(url.PG_MIGRATE_URL_KEY).toBe('MARVEEN_PG_MIGRATE_URL')
    expect(url.PG_MIGRATE_URL_KEY).not.toBe(url.PG_URL_KEY)
  })

  it('is undefined when no layer has a value (the boot then only checks the schema)', async () => {
    const url = await load()
    expect(url.resolvePgMigrateUrl()).toBeUndefined()
  })

  it('reads the .env file of the install', async () => {
    writeEnvFile(`MARVEEN_PG_MIGRATE_URL=${OWNER_C}`)
    const url = await load()
    expect(url.resolvePgMigrateUrl()).toBe(OWNER_C)
  })

  it('process.env beats the .env file, and the secret mount beats both (its trailing newline is trimmed)', async () => {
    writeEnvFile(`MARVEEN_PG_MIGRATE_URL=${OWNER_C}`)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', OWNER_B)
    expect((await load()).resolvePgMigrateUrl()).toBe(OWNER_B)
    writeSecret('MARVEEN_PG_MIGRATE_URL', `${OWNER_A}\n`)
    expect((await load()).resolvePgMigrateUrl()).toBe(OWNER_A)
  })

  it('an empty or whitespace-only value counts as absent and falls through to the next layer', async () => {
    writeEnvFile(`MARVEEN_PG_MIGRATE_URL=${OWNER_C}`)
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', '   ')
    writeSecret('MARVEEN_PG_MIGRATE_URL', '\n')
    expect((await load()).resolvePgMigrateUrl()).toBe(OWNER_C)
  })

  it('the two keys are independent: the serving URL is never taken for the migration URL, or the other way round', async () => {
    vi.stubEnv('MARVEEN_PG_URL', APP_A)
    const only = await load()
    expect(only.resolvePgMigrateUrl()).toBeUndefined()
    expect(only.resolvePgUrl()).toBe(APP_A)
    vi.stubEnv('MARVEEN_PG_URL', '')
    vi.stubEnv('MARVEEN_PG_MIGRATE_URL', OWNER_A)
    const other = await load()
    expect(other.resolvePgUrl()).toBeUndefined()
    expect(other.resolvePgMigrateUrl()).toBe(OWNER_A)
  })
})

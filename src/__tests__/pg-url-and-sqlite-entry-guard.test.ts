// MARVEEN_PG_URL (db/pg/url.ts): where it is read from, in which order, and the guard that keeps a SQLite-only entry
// point (initDatabase() without a database of its own) from opening the old file of an install configured for PostgreSQL.
//
// Privacy: neutral fixtures only (host-a, user-a, secret-a, db-a).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_A = 'postgresql://user-a:secret-a@host-a:5432/db-a'
const URL_B = 'postgres://user-b:secret-b@host-b:5432/db-b'
const URL_C = 'postgresql://user-c:secret-c@host-c:5432/db-c'

let root: string
let envDir: string
let secretDir: string
let storeDir: string

/** A fresh module graph: SECRET_MOUNT_DIR, CLAUDECLAW_ENV_DIR and MARVEEN_STORE_DIR are read when the modules load. */
async function load() {
  vi.resetModules()
  // the bootstrap (src/index.ts) sets the snapshot before config.ts is read; these cells load the modules directly, so they set
  // the same empty snapshot first (config.ts refuses a PostgreSQL URL without one)
  ;(await import('../config-snapshot.js')).setConfigSnapshot({})
  const url = await import('../db/pg/url.js')
  const db = await import('../db.js')
  const conn = await import('../db/connection.js')
  return { url, db, conn }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pg-url-guard-'))
  envDir = join(root, 'env')
  secretDir = join(root, 'secrets')
  storeDir = join(root, 'store')
  for (const d of [envDir, secretDir, storeDir]) mkdirSync(d)
  vi.stubEnv('CLAUDECLAW_ENV_DIR', envDir)
  vi.stubEnv('SECRET_MOUNT_DIR', secretDir)
  vi.stubEnv('MARVEEN_STORE_DIR', storeDir)
  vi.stubEnv('MARVEEN_PG_URL', '')
  // the marker is inherited from a PostgreSQL-configured parent: stubbed empty so these cells see the unmarked install
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const writeEnvFile = (line: string) => writeFileSync(join(envDir, '.env'), `${line}\n`)
const writeSecret = (value: string) => writeFileSync(join(secretDir, 'MARVEEN_PG_URL'), value)

describe('resolvePgUrl', () => {
  it('is undefined when no layer has a value', async () => {
    const { url } = await load()
    expect(url.resolvePgUrl()).toBeUndefined()
  })

  it('reads the .env file of the install', async () => {
    writeEnvFile(`MARVEEN_PG_URL=${URL_C}`)
    const { url } = await load()
    expect(url.resolvePgUrl()).toBe(URL_C)
  })

  it('process.env beats the .env file', async () => {
    writeEnvFile(`MARVEEN_PG_URL=${URL_C}`)
    vi.stubEnv('MARVEEN_PG_URL', URL_B)
    const { url } = await load()
    expect(url.resolvePgUrl()).toBe(URL_B)
  })

  it('the secret mount beats both, and its trailing newline is trimmed', async () => {
    writeEnvFile(`MARVEEN_PG_URL=${URL_C}`)
    vi.stubEnv('MARVEEN_PG_URL', URL_B)
    writeSecret(`${URL_A}\n`)
    const { url } = await load()
    expect(url.resolvePgUrl()).toBe(URL_A)
  })

  it('an empty or whitespace-only layer counts as absent and falls through to the next one', async () => {
    writeEnvFile(`MARVEEN_PG_URL=${URL_C}`)
    writeSecret('   \n')
    vi.stubEnv('MARVEEN_PG_URL', '  ')
    const { url } = await load()
    expect(url.resolvePgUrl()).toBe(URL_C)
  })

  it('an empty value in the only layer that has one is absent (a half-edited .env line does not switch the backend)', async () => {
    writeEnvFile('MARVEEN_PG_URL=')
    const { url } = await load()
    expect(url.resolvePgUrl()).toBeUndefined()
  })

  it('never reads the URL from anywhere but those three layers (a similarly named key is not it)', async () => {
    writeEnvFile(`MARVEEN_PG_TEST_URL=${URL_A}\nMARVEEN_PG_EVAL_URL=${URL_B}`)
    vi.stubEnv('MARVEEN_PG_TEST_URL', URL_C)
    const { url } = await load()
    expect(url.resolvePgUrl()).toBeUndefined()
  })
})

describe('the SQLite entry guard', () => {
  it('with a URL configured, initDatabase() without a database of its own throws and names the variable', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_A)
    const { db, url } = await load()
    expect(() => db.initDatabase()).toThrow(url.SqliteEntryRefusedError)
    expect(() => db.initDatabase()).toThrow(/MARVEEN_PG_URL is set/)
  })

  it('the message never carries the URL or its password', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_A)
    const { db } = await load()
    let message = ''
    try { db.initDatabase() } catch (err) { message = (err as Error).message }
    expect(message).not.toBe('')
    expect(message).not.toContain('secret-a')
    expect(message).not.toContain('host-a')
  })

  it('the guard sits in the connection layer: the connection initialiser called directly refuses too', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_A)
    const { conn, url } = await load()
    expect(() => conn.initDatabase()).toThrow(url.SqliteEntryRefusedError)
  })

  it('it refuses BEFORE anything is opened or created: the store directory stays empty', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_A)
    const { db } = await load()
    expect(() => db.initDatabase()).toThrow()
    expect(readdirSync(storeDir)).toEqual([])
  })

  it('a URL that only the .env file or the secret mount holds switches the guard on as well', async () => {
    writeEnvFile(`MARVEEN_PG_URL=${URL_C}`)
    const first = await load()
    expect(() => first.db.initDatabase()).toThrow(first.url.SqliteEntryRefusedError)
    rmSync(join(envDir, '.env'))
    writeSecret(URL_A)
    const second = await load()
    expect(() => second.db.initDatabase()).toThrow(second.url.SqliteEntryRefusedError)
  })

  it('a caller that names its own database (a test, a throwaway file) is not an entry point: ":memory:" still opens', async () => {
    vi.stubEnv('MARVEEN_PG_URL', URL_A)
    const { db, conn } = await load()
    expect(() => db.initDatabase(':memory:')).not.toThrow()
    expect(conn.db).toBeDefined()
    conn.closeDatabase()
  })

  it('without a URL the guard lets the entry point through', async () => {
    const { url } = await load()
    expect(() => url.assertSqliteEntryAllowed('initDatabase()')).not.toThrow()
  })
})

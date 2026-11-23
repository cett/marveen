// config.ts reads its system_config overrides from a PostgreSQL snapshot when MARVEEN_PG_URL is set (phase 3, step 6c-3).
// The snapshot is set once per process before config.ts evaluates (config-snapshot.ts), and a PostgreSQL install never reads
// the SQLite file: without a snapshot it refuses (ConfigSnapshotMissingError). The SQLite path is unchanged.
//
// Each cell imports config.ts fresh (vi.resetModules) against a throwaway store, so module state cannot leak between cells.
// Privacy: neutral fixtures only (a store under a temp directory, a placeholder URL with no real host).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

let root: string
let storeFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'carl-config-snapshot-'))
  mkdirSync(join(root, 'store'))
  storeFile = join(root, 'store', 'claudeclaw.db')
  process.env.MARVEEN_STORE_DIR = join(root, 'store')
  delete process.env.MARVEEN_PG_URL
  delete process.env.SCHEDULER_TZ
  delete process.env.CLAUDECLAW_ENV_DIR
  vi.resetModules()
})

afterEach(() => {
  vi.doUnmock('better-sqlite3')
  delete process.env.MARVEEN_STORE_DIR
  delete process.env.MARVEEN_PG_URL
  delete process.env.SCHEDULER_TZ
  delete process.env.CLAUDECLAW_ENV_DIR
  rmSync(root, { recursive: true, force: true })
})

// A SQLite file with one system_config row: the value the SQLite path would read.
function writeStaleSqlite(key: string, value: string): void {
  const db = new Database(storeFile)
  db.exec('CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run(key, value)
  db.close()
}

const PG_URL = 'postgres://user:secret-placeholder@db.invalid:5432/marveen'

describe('config.ts without a PostgreSQL URL: the SQLite path is unchanged', () => {
  it('reads system_config from the SQLite file', async () => {
    writeStaleSqlite('SCHEDULER_TZ', 'Europe/Berlin')
    const config = await import('../config.js')
    expect(config.APP_TZ).toBe('Europe/Berlin')
  })

  it('a missing SQLite file is tolerated: the defaults apply, no throw', async () => {
    const config = await import('../config.js')
    expect(typeof config.APP_TZ).toBe('string')
  })
})

describe('config.ts with a PostgreSQL URL', () => {
  it('without a snapshot it refuses: ConfigSnapshotMissingError, and the stale SQLite value is not used', async () => {
    writeStaleSqlite('SCHEDULER_TZ', 'Europe/Berlin')
    process.env.MARVEEN_PG_URL = PG_URL
    const { ConfigSnapshotMissingError } = await import('../config-snapshot.js')
    await expect(import('../config.js')).rejects.toThrow(ConfigSnapshotMissingError)
  })

  // The refusal above does not prove the SQLite file stayed closed (a read before the check would still throw afterwards):
  // this cell counts the better-sqlite3 constructor itself, and it must not be called at all.
  it('without a snapshot the SQLite file is never opened: zero better-sqlite3 constructor calls', async () => {
    writeStaleSqlite('SCHEDULER_TZ', 'Europe/Berlin')
    process.env.MARVEEN_PG_URL = PG_URL
    const constructed: unknown[] = []
    vi.doMock('better-sqlite3', async () => {
      const actual = await vi.importActual<{ default: new (...args: unknown[]) => object }>('better-sqlite3')
      const Real = actual.default
      class CountingDatabase {
        constructor(...args: unknown[]) {
          constructed.push(args[0])
          return Reflect.construct(Real, args) as object
        }
      }
      return { default: CountingDatabase }
    })
    vi.resetModules()
    const { ConfigSnapshotMissingError: Missing } = await import('../config-snapshot.js')
    await expect(import('../config.js')).rejects.toThrow(Missing)
    expect(constructed).toEqual([])
  })

  it('with a snapshot the snapshot value wins over a stale SQLite file with a different value', async () => {
    writeStaleSqlite('SCHEDULER_TZ', 'Europe/Berlin')
    process.env.MARVEEN_PG_URL = PG_URL
    const snapshot = await import('../config-snapshot.js')
    snapshot.setConfigSnapshot({ SCHEDULER_TZ: 'Asia/Tokyo' })
    const config = await import('../config.js')
    expect(config.APP_TZ).toBe('Asia/Tokyo')
  })

  it('a snapshot is enough: no SQLite file exists and the boot still reads the snapshot value', async () => {
    process.env.MARVEEN_PG_URL = PG_URL
    const snapshot = await import('../config-snapshot.js')
    snapshot.setConfigSnapshot({ SCHEDULER_TZ: 'Asia/Tokyo' })
    const config = await import('../config.js')
    expect(config.APP_TZ).toBe('Asia/Tokyo')
  })

  // The environment layer of cfg() is the .env file (readEnvFile, in CLAUDECLAW_ENV_DIR), not process.env: the file is written
  // here, and the snapshot value must still win over it.
  it('the precedence is unchanged: a snapshot value beats the .env file of the same key', async () => {
    process.env.MARVEEN_PG_URL = PG_URL
    const envDir = join(root, 'envdir')
    mkdirSync(envDir)
    writeFileSync(join(envDir, '.env'), 'SCHEDULER_TZ=Europe/Paris\n')
    process.env.CLAUDECLAW_ENV_DIR = envDir
    const snapshot = await import('../config-snapshot.js')
    snapshot.setConfigSnapshot({ SCHEDULER_TZ: 'Asia/Tokyo' })
    const config = await import('../config.js')
    expect(config.APP_TZ).toBe('Asia/Tokyo')
  })

  it('control for that cell: without a snapshot the .env value is the one read (the env layer is live on the SQLite path)', async () => {
    const envDir = join(root, 'envdir')
    mkdirSync(envDir)
    writeFileSync(join(envDir, '.env'), 'SCHEDULER_TZ=Europe/Paris\n')
    process.env.CLAUDECLAW_ENV_DIR = envDir
    const config = await import('../config.js')
    expect(config.APP_TZ).toBe('Europe/Paris')
  })
})

describe('the snapshot itself', () => {
  it('is set once per process: a second set throws and keeps the first value', async () => {
    const snapshot = await import('../config-snapshot.js')
    snapshot.setConfigSnapshot({ SCHEDULER_TZ: 'Asia/Tokyo' })
    expect(() => snapshot.setConfigSnapshot({ SCHEDULER_TZ: 'Europe/Paris' })).toThrow()
    expect(snapshot.getConfigSnapshot()).toEqual({ SCHEDULER_TZ: 'Asia/Tokyo' })
  })

  it('is frozen: a write to the returned object is refused', async () => {
    const snapshot = await import('../config-snapshot.js')
    snapshot.setConfigSnapshot({ SCHEDULER_TZ: 'Asia/Tokyo' })
    const got = snapshot.getConfigSnapshot() as Record<string, string>
    expect(Object.isFrozen(got)).toBe(true)
    expect(() => { got.SCHEDULER_TZ = 'Europe/Paris' }).toThrow()
  })

  it('is a copy: a later change of the input object does not reach the snapshot', async () => {
    const snapshot = await import('../config-snapshot.js')
    const input: Record<string, string> = { SCHEDULER_TZ: 'Asia/Tokyo' }
    snapshot.setConfigSnapshot(input)
    input.SCHEDULER_TZ = 'Europe/Paris'
    expect(snapshot.getConfigSnapshot()).toEqual({ SCHEDULER_TZ: 'Asia/Tokyo' })
  })

  it('getConfigSnapshot returns undefined before any set', async () => {
    const snapshot = await import('../config-snapshot.js')
    expect(snapshot.getConfigSnapshot()).toBeUndefined()
  })
})

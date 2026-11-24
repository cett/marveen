// The NEWER state under the override (db-migrations-pg.ts, pg-boot.ts; the cutover plan's G3). A fake pool records every
// statement, so the cells prove what the runner did and did not run: a NEWER database with the override starts with no
// file applied and no DDL at all. No database is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPgMigrations, assertPgSchemaCurrent, loadPgMigrationFiles } from '../db-migrations-pg.js'
import { allowNewerFromEnv, PG_ALLOW_NEWER_KEY } from '../db/pg-boot.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-newer-'))
  writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a_t (id bigint);')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A pool whose schema_version holds the given rows; every statement is recorded. */
function fakePool(dir: string, applied: Array<{ version: number; checksum: string | null | 'file' }>) {
  const files = loadPgMigrationFiles(dir)
  const rows = applied.map((a) => ({
    version: a.version,
    checksum: a.checksum === 'file' ? (files.find((f) => f.version === a.version)?.checksum ?? null) : a.checksum,
  }))
  const statements: string[] = []
  const answer = (sql: string): { rows: unknown[] } => {
    if (sql.includes("to_regclass('schema_version')")) return { rows: [{ t: 'schema_version' }] }
    if (sql.startsWith('SELECT version, checksum FROM schema_version')) {
      return { rows: rows.map((a) => ({ version: String(a.version), checksum: a.checksum })) }
    }
    if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ previous: '0' }] }
    return { rows: [] }
  }
  const query = (sql: string): Promise<{ rows: unknown[] }> => {
    statements.push(sql)
    return Promise.resolve(answer(sql))
  }
  const client = { query, release: () => undefined }
  const pool = { connect: () => Promise.resolve(client), query }
  return { statements, pool }
}

const ddl = (statements: string[]) => statements.filter((s) => /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i.test(s))

describe('a NEWER database (applied migrations this build does not ship)', () => {
  it('without the override the runner refuses, names the version, and runs nothing', async () => {
    const { pool, statements } = fakePool(dir, [{ version: 1, checksum: 'file' }, { version: 2, checksum: null }])
    await expect(applyPgMigrations(pool as never, { dir })).rejects.toThrow(/PG migration 2 is applied but its file is gone/)
    await expect(applyPgMigrations(pool as never, { dir })).rejects.toThrow(/the database is at migration 2, this build ships up to 1/)
    expect(ddl(statements)).toEqual([])
  })

  it('with the override the runner starts with nothing applied and no DDL, and reports both versions', async () => {
    const { pool, statements } = fakePool(dir, [{ version: 1, checksum: 'file' }, { version: 2, checksum: null }])
    const r = await applyPgMigrations(pool as never, { dir, allowNewer: true })
    expect(r.state).toBe('NEWER')
    expect(r.applied).toEqual([])
    expect(r.newer).toEqual({ appliedMax: 2, shippedMax: 1 })
    expect(ddl(statements)).toEqual([])
  })

  it('the schema check without a migration URL: refused without the override, passes with it, no DDL either way', async () => {
    const { pool, statements } = fakePool(dir, [{ version: 1, checksum: 'file' }, { version: 2, checksum: null }])
    await expect(assertPgSchemaCurrent(pool as never, { dir })).rejects.toThrow(/PG migration 2 is applied but its file is gone/)
    const r = await assertPgSchemaCurrent(pool as never, { dir, allowNewer: true })
    expect(r.state).toBe('NEWER')
    expect(ddl(statements)).toEqual([])
  })

  it('the override does not let a DIVERGED database through (a changed checksum stays refused)', async () => {
    const { pool, statements } = fakePool(dir, [{ version: 1, checksum: 'not-the-file-checksum' }, { version: 2, checksum: null }])
    await expect(applyPgMigrations(pool as never, { dir, allowNewer: true })).rejects.toThrow(/changed after it was applied/)
    expect(ddl(statements)).toEqual([])
  })

  it('the schema check: a DIVERGED checksum is refused even with the override on', async () => {
    const { pool, statements } = fakePool(dir, [{ version: 1, checksum: 'not-the-file-checksum' }])
    await expect(assertPgSchemaCurrent(pool as never, { dir, allowNewer: true })).rejects.toThrow(/changed after it was applied/)
    expect(ddl(statements)).toEqual([])
  })

  it('the schema check: an orphan AND a missing shipped migration is refused even with the override on', async () => {
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b_t (id bigint);')
    const { pool, statements } = fakePool(dir, [{ version: 3, checksum: null }])
    await expect(assertPgSchemaCurrent(pool as never, { dir, allowNewer: true })).rejects.toThrow(/is applied but its file is gone/)
    expect(ddl(statements)).toEqual([])
  })

  it('the override does not let a BEHIND database through: the schema check still refuses a missing file', async () => {
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b_t (id bigint);')
    const { pool } = fakePool(dir, [{ version: 1, checksum: 'file' }])
    await expect(assertPgSchemaCurrent(pool as never, { dir, allowNewer: true })).rejects.toThrow(/the schema is behind/)
  })
})

describe('the override is read from the process environment only', () => {
  it('only the value 1 turns it on', () => {
    for (const v of ['0', '', 'true', 'yes', ' 1']) {
      expect(allowNewerFromEnv({ [PG_ALLOW_NEWER_KEY]: v })).toBe(false)
    }
    expect(allowNewerFromEnv({ [PG_ALLOW_NEWER_KEY]: '1' })).toBe(true)
    expect(allowNewerFromEnv({})).toBe(false)
  })

  it('a .env file of the install that carries the override does not turn it on', () => {
    const envRoot = mkdtempSync(join(tmpdir(), 'newer-dotenv-'))
    writeFileSync(join(envRoot, '.env'), `${PG_ALLOW_NEWER_KEY}=1\n`)
    vi.stubEnv('CLAUDECLAW_ENV_DIR', envRoot)
    // undefined, not '': the variable is really absent from the process environment
    vi.stubEnv(PG_ALLOW_NEWER_KEY, undefined)
    expect(allowNewerFromEnv()).toBe(false)
    rmSync(envRoot, { recursive: true, force: true })
  })

  it('a secret mount file that carries the override does not turn it on', async () => {
    const mountRoot = mkdtempSync(join(tmpdir(), 'newer-mount-'))
    writeFileSync(join(mountRoot, PG_ALLOW_NEWER_KEY), '1\n')
    vi.stubEnv('SECRET_MOUNT_DIR', mountRoot)
    vi.stubEnv(PG_ALLOW_NEWER_KEY, undefined)
    // the secret resolver reads its directory when it loads: load the boot module again under the stubbed mount
    vi.resetModules()
    const fresh = await import('../db/pg-boot.js')
    expect(fresh.allowNewerFromEnv()).toBe(false)
    rmSync(mountRoot, { recursive: true, force: true })
  })

  it('the key name is the documented one', () => {
    expect(PG_ALLOW_NEWER_KEY).toBe('MARVEEN_PG_ALLOW_NEWER_DATABASE')
  })
})

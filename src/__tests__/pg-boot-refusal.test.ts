// The PostgreSQL boot (db/pg-boot.ts, db/index.ts initDatabaseAsync): the cells that need no server. A URL that is not
// a PostgreSQL URL, a server that cannot be reached, and the URL-absent path that must stay exactly as it was. The
// steps that need a live server (schema, preflight, caches, the success path) are in pg/pg-boot.pg.test.ts.
//
// Privacy: neutral fixtures only (host-a, user-a, secret-a, db-a).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// nothing listens on port 1: the connection is refused at once, with no server involved
const DEAD_URL = 'postgresql://user-a:secret-a@127.0.0.1:1/db-a'
const MIGRATE_URL = 'postgresql://user-m:secret-m@127.0.0.1:1/db-a'

let root: string
let storeDir: string
let pgLoaded: boolean

async function load() {
  vi.resetModules()
  // the bootstrap (src/index.ts) sets the snapshot before anything reads config.ts; these cells boot without it, so they set
  // the same empty snapshot first (config.ts refuses a PostgreSQL URL without one)
  ;(await import('../config-snapshot.js')).setConfigSnapshot({})
  const boot = await import('../db/pg-boot.js')
  const db = await import('../db.js')
  const facade = await import('../db/facade.js')
  return { boot, db, facade }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pg-boot-refusal-'))
  storeDir = join(root, 'store')
  mkdirSync(storeDir)
  vi.stubEnv('CLAUDECLAW_ENV_DIR', join(root, 'env'))
  vi.stubEnv('SECRET_MOUNT_DIR', join(root, 'secrets'))
  vi.stubEnv('MARVEEN_STORE_DIR', storeDir)
  vi.stubEnv('MARVEEN_PG_URL', '')
  // the marker is inherited from a PostgreSQL-configured parent: stubbed empty so these cells see the unmarked install
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
  vi.stubEnv('MARVEEN_PG_MIGRATE_URL', '')
  pgLoaded = false
})

afterEach(() => {
  for (const mod of [
    'pg',
    '../db-migrations-pg.js',
    '../db/pg/preflight.js',
    '../db/pg/dbx.js',
    '../db/pg/pool.js',
    '../db/config-cache.js',
    '../db/model-profile-map-cache.js',
    '../db/agent-settings-cache.js',
  ]) vi.doUnmock(mod)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('bootPgBackend: the url step', () => {
  it.each([
    ['a value that is not a URL', 'not a url at all'],
    ['another database scheme', 'mysql://user-a:secret-a@host-a:3306/db-a'],
    ['a file URL', 'file:///tmp/db-a'],
  ])('refuses %s at step "url", never echoing the value, and never loads the driver', async (_label, value) => {
    vi.doMock('pg', () => { pgLoaded = true; return { default: {} } })
    const { boot } = await load()
    const err = await boot.bootPgBackend({ url: value }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
    expect(err).toBeInstanceOf(boot.PgBootError)
    expect(err!.step).toBe('url')
    expect(err!.message).toContain('MARVEEN_PG_URL')
    expect(err!.message).not.toContain('secret-a')
    expect(err!.message).not.toContain(value)
    expect(pgLoaded).toBe(false)
  })

  it('refuses at step "url" when no URL is configured at all', async () => {
    const { boot } = await load()
    await expect(boot.bootPgBackend()).rejects.toMatchObject({ name: 'PgBootError', step: 'url' })
  })
})

describe('bootPgBackend: the pool step', () => {
  it('a server that cannot be reached refuses at step "pool", leaves the facade on SQLite, and never echoes the password', async () => {
    const { boot, facade } = await load()
    const err = await boot.bootPgBackend({ url: DEAD_URL }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
    expect(err).toBeInstanceOf(boot.PgBootError)
    expect(err!.step).toBe('pool')
    expect(err!.message).toMatch(/step "pool"/)
    expect(err!.message).not.toContain('secret-a')
    expect(err!.message).not.toContain(DEAD_URL)
    expect(facade.dbxDialect()).toBe('sqlite')
  })

  it('a refused boot leaves nothing registered: the next boot attempt is a fresh one, not "already booted"', async () => {
    const { boot } = await load()
    await expect(boot.bootPgBackend({ url: DEAD_URL })).rejects.toMatchObject({ step: 'pool' })
    await expect(boot.bootPgBackend({ url: DEAD_URL })).rejects.toMatchObject({ step: 'pool' })
  })

  it('closePgBackend with nothing booted is a no-op that keeps the facade on SQLite', async () => {
    const { boot, facade } = await load()
    await boot.closePgBackend()
    await boot.closePgBackend()
    expect(facade.dbxDialect()).toBe('sqlite')
  })
})

describe('what a boot error exposes to the logger', () => {
  const serialized = async (err: unknown): Promise<string> => {
    const { default: pino } = await import('pino')
    return JSON.stringify(pino.stdSerializers.err(err as Error))
  }

  it('redactUrl masks the whole URL, the password as written, and the decoded password (also when the escape is malformed)', async () => {
    const { boot } = await load()
    const url = 'postgresql://user-a:p%40ss-a@host-a:5432/db-a'
    const text = `bad ${url} / ${'p%40ss-a'} / ${'p@ss-a'}`
    const out = boot.redactUrl(text, url)
    expect(out).not.toContain('p@ss-a')
    expect(out).not.toContain('p%40ss-a')
    expect(out).not.toContain('host-a')
    const broken = 'postgresql://user-a:p%zz-a@host-a:5432/db-a'
    expect(boot.redactUrl('x p%zz-a y', broken)).not.toContain('p%zz-a')
  })

  it('sanitizeError is a copy: message and stack redacted, the driver code kept, never the raw error', async () => {
    const { boot } = await load()
    const raw = Object.assign(new Error(`cannot connect to ${DEAD_URL}`), { code: 'ECONNREFUSED' })
    const copy = boot.sanitizeError(raw, DEAD_URL)
    expect(copy).not.toBe(raw)
    expect(copy.message).not.toContain('secret-a')
    expect(copy.stack).not.toContain('secret-a')
    expect((copy as { code?: string }).code).toBe('ECONNREFUSED')
  })

  it('a driver error that quotes the connection string does not reach the serialised boot error, cause chain included', async () => {
    vi.doMock('../db/pg/pool.js', () => ({
      pgPoolConfig: () => { throw Object.assign(new Error(`Invalid connection string ${DEAD_URL}`), { input: DEAD_URL }) },
    }))
    const { boot } = await load()
    const err = await boot.bootPgBackend({ url: DEAD_URL }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
    expect(err).toBeInstanceOf(boot.PgBootError)
    expect(err!.step).toBe('pool')
    expect(err!.cause).toBeInstanceOf(Error)
    const json = await serialized(err)
    expect(json).toContain('PgBootError')
    expect(json).not.toContain('secret-a')
    expect(json).not.toContain('user-a')
    vi.doUnmock('../db/pg/pool.js')
  })

  // The refuse() branch wraps the error of EVERY step after the pool is built, so each of them is a cell of its own: the
  // step throws an error that quotes the URL in its message and in an `input` property (as Node's invalid-URL errors do),
  // and the serialised boot error (cause chain included, as the logger writes it) must carry neither the password nor the
  // user. Mutant: `cause: err` in refuse() instead of sanitizeError(err, url) fails every row (the raw error keeps `input`).
  // The earlier steps are stubbed to pass, so each row reaches exactly the step it names.
  it.each(['pool', 'role', 'schema', 'preflight', 'caches'] as const)(
    'a driver error that quotes the connection string at step "%s" does not reach the serialised boot error, cause chain included',
    async (step) => {
      const quoting = () => Object.assign(new Error(`cannot connect to ${DEAD_URL}`), { input: DEAD_URL })
      vi.doMock('pg', () => {
        class Pool {
          on() { return this }
          query() { return step === 'pool' ? Promise.reject(quoting()) : Promise.resolve({ rows: [] }) }
          end() { return Promise.resolve() }
        }
        return { default: { Pool, types: { setTypeParser: () => undefined, builtins: {} } }, Pool }
      })
      // no migration URL here: the schema step is the read-only check of the serving pool
      vi.doMock('../db-migrations-pg.js', () => ({
        applyPgMigrations: () => Promise.resolve({ applied: [], alreadyApplied: 0 }),
        assertPgSchemaCurrent: () => (step === 'schema' ? Promise.reject(quoting()) : Promise.resolve({ applied: [], alreadyApplied: 0 })),
      }))
      vi.doMock('../db/pg/preflight.js', () => ({
        pgRolePreflight: () => (step === 'role' ? Promise.reject(quoting()) : Promise.resolve()),
        pgPreflight: () => (step === 'preflight' ? Promise.reject(quoting()) : Promise.resolve({ warnings: [] })),
      }))
      vi.doMock('../db/pg/dbx.js', () => ({ createPgDbx: () => ({}) }))
      vi.doMock('../db/config-cache.js', () => ({
        loadSystemConfigCacheAsync: () => (step === 'caches' ? Promise.reject(quoting()) : Promise.resolve()),
      }))
      vi.doMock('../db/model-profile-map-cache.js', () => ({ loadModelProfileMapCacheAsync: () => Promise.resolve() }))
      vi.doMock('../db/agent-settings-cache.js', () => ({ loadAgentSettingsCacheAsync: () => Promise.resolve() }))
      const { boot, facade } = await load()
      const err = await boot.bootPgBackend({ url: DEAD_URL }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
      expect(err).toBeInstanceOf(boot.PgBootError)
      expect(err!.step).toBe(step)
      expect(err!.cause).toBeInstanceOf(Error)
      expect(err!.message).not.toContain('secret-a')
      expect(err!.message).not.toContain('user-a')
      const json = await serialized(err)
      expect(json).toContain('PgBootError')
      expect(json).not.toContain('secret-a')
      expect(json).not.toContain('user-a')
      // a refused boot at any step leaves the facade back on SQLite
      expect(facade.dbxDialect()).toBe('sqlite')
    },
  )

  // The migration URL carries a password of its own (the owner role's). A failure of the schema step that quotes IT must
  // not reach the serialised boot error either. Mutant: refuse() redacting only the serving URL fails this cell.
  it('a driver error that quotes the MIGRATION url at the schema step does not reach the serialised boot error', async () => {
    const quotingMigrate = () => Object.assign(new Error(`cannot connect to ${MIGRATE_URL}`), { input: MIGRATE_URL })
    vi.doMock('pg', () => {
      class Pool {
        on() { return this }
        query() { return Promise.resolve({ rows: [] }) }
        end() { return Promise.resolve() }
      }
      return { default: { Pool, types: { setTypeParser: () => undefined, builtins: {} } }, Pool }
    })
    // the role step is judged on a server in pg-boot.pg.test.ts; here it is stubbed to pass so the cell reaches the schema step
    vi.doMock('../db/pg/preflight.js', () => ({ pgRolePreflight: () => Promise.resolve(), pgPreflight: () => Promise.resolve({ warnings: [] }) }))
    vi.doMock('../db-migrations-pg.js', () => ({
      applyPgMigrations: () => Promise.reject(quotingMigrate()),
      assertPgSchemaCurrent: () => Promise.resolve({ applied: [], alreadyApplied: 0 }),
    }))
    const { boot, facade } = await load()
    const err = await boot.bootPgBackend({ url: DEAD_URL, migrateUrl: MIGRATE_URL }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
    expect(err).toBeInstanceOf(boot.PgBootError)
    expect(err!.step).toBe('schema')
    for (const text of [err!.message, await serialized(err)]) {
      expect(text).not.toContain('secret-m')
      expect(text).not.toContain('user-m')
      expect(text).not.toContain('secret-a')
    }
    expect(facade.dbxDialect()).toBe('sqlite')
  })

  it('a migration URL that is not a postgres URL refuses at the schema step, and the message names the key, not the value', async () => {
    vi.doMock('pg', () => {
      class Pool {
        on() { return this }
        query() { return Promise.resolve({ rows: [] }) }
        end() { return Promise.resolve() }
      }
      return { default: { Pool, types: { setTypeParser: () => undefined, builtins: {} } }, Pool }
    })
    vi.doMock('../db/pg/preflight.js', () => ({ pgRolePreflight: () => Promise.resolve(), pgPreflight: () => Promise.resolve({ warnings: [] }) }))
    const { boot } = await load()
    const bad = 'mysql://user-m:secret-m@127.0.0.1:1/db-m'
    const err = await boot.bootPgBackend({ url: DEAD_URL, migrateUrl: bad }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
    expect(err!.step).toBe('schema')
    expect(err!.message).toContain('MARVEEN_PG_MIGRATE_URL')
    expect(err!.message).not.toContain('secret-m')
    expect(err!.message).not.toContain('user-m')
  })
})

// The role preflight on a server that answers oddly (no server needed: a fake queryable). The verdict of a role that cannot be
// read is a refusal, never an acceptance (fail closed). The three real conditions are judged on a live server in pg/pg-boot.pg.test.ts.
describe('pgRolePreflight: what it cannot read it refuses', () => {
  // the query answers one row per judged name: current_user and session_user (the same row for both unless a cell says otherwise)
  // (`null` for the session row = no row for the login role; an omitted argument = the same row as current_user)
  const answering = (row: Record<string, unknown> | undefined, session: Record<string, unknown> | null | undefined = row) => ({
    query: () => Promise.resolve({
      rows: [row === undefined ? null : { which: 'current', ...row }, session === undefined || session === null ? null : { which: 'session', ...session }].filter((r) => r !== null),
    }),
  })
  const GOOD = { rolsuper: false, rolbypassrls: false, owned: 0, member_of_privileged: 0, rolcreaterole: false, member_of_server_reach: 0 }

  it('accepts exactly the clean row', async () => {
    const { pgRolePreflight } = await import('../db/pg/preflight.js')
    await expect(pgRolePreflight(answering(GOOD))).resolves.toBeUndefined()
  })

  it.each([
    ['no row for the role (not visible in pg_roles)', undefined, /not visible in pg_roles/],
    ['rolsuper true', { ...GOOD, rolsuper: true }, /superuser/],
    ['rolsuper null (not exactly false)', { ...GOOD, rolsuper: null }, /superuser/],
    ['rolbypassrls true', { ...GOOD, rolbypassrls: true }, /BYPASSRLS/],
    ['rolbypassrls missing (not exactly false)', { rolsuper: false, owned: 0 }, /BYPASSRLS/],
    ['one owned table', { ...GOOD, owned: 1 }, /owns a table/],
    ['an owned count that is not a number', { ...GOOD, owned: 'many' }, /owns a table/],
    ['an owned count that is missing', { rolsuper: false, rolbypassrls: false, member_of_privileged: 0 }, /owns a table/],
    ['one membership of a privileged role', { ...GOOD, member_of_privileged: 1 }, /member of a role that is a superuser or has BYPASSRLS/],
    ['a membership count that is not a number', { ...GOOD, member_of_privileged: 'some' }, /member of a role that is a superuser/],
    ['a membership count that is missing', { rolsuper: false, rolbypassrls: false, owned: 0 }, /member of a role that is a superuser/],
    ['rolcreaterole true', { ...GOOD, rolcreaterole: true }, /has CREATEROLE/],
    ['rolcreaterole null (not exactly false)', { ...GOOD, rolcreaterole: null }, /has CREATEROLE/],
    ['rolcreaterole missing', { rolsuper: false, rolbypassrls: false, owned: 0, member_of_privileged: 0, member_of_server_reach: 0 }, /has CREATEROLE/],
    ['one membership of a host-reaching built-in role', { ...GOOD, member_of_server_reach: 1 }, /reaches the server host/],
    ['a host-reach count that is not a number', { ...GOOD, member_of_server_reach: 'some' }, /reaches the server host/],
    ['a host-reach count that is missing', { rolsuper: false, rolbypassrls: false, owned: 0, member_of_privileged: 0, rolcreaterole: false }, /reaches the server host/],
  ] as const)('refuses on %s', async (_name, row, message) => {
    const { pgRolePreflight } = await import('../db/pg/preflight.js')
    await expect(pgRolePreflight(answering(row))).rejects.toThrow(message)
  })

  // the LOGIN role (session_user) is judged with the same conditions, after current_user, and says so in the message
  it.each([
    ['the login role is a superuser', { ...GOOD, rolsuper: true }, /login role of the session is a superuser/],
    ['the login role has BYPASSRLS', { ...GOOD, rolbypassrls: true }, /login role of the session has BYPASSRLS/],
    ['the login role owns a table', { ...GOOD, owned: 1 }, /login role of the session owns a table/],
    ['the login role is a member of a privileged role', { ...GOOD, member_of_privileged: 1 }, /login role of the session is a member of a role that is a superuser/],
    ['the login role has CREATEROLE', { ...GOOD, rolcreaterole: true }, /login role of the session has CREATEROLE/],
    ['the login role reaches the server host', { ...GOOD, member_of_server_reach: 1 }, /login role of the session is a member of a built-in role that reaches the server host/],
    ['the login role row is missing', null, /login role of the session is not visible in pg_roles/],
  ] as const)('with a clean current_user, refuses when %s', async (_name, session, message) => {
    const { pgRolePreflight } = await import('../db/pg/preflight.js')
    await expect(pgRolePreflight(answering(GOOD, session))).rejects.toThrow(message)
  })

  it('current_user is judged first: both roles bad, the message is the connected role\'s', async () => {
    const { pgRolePreflight } = await import('../db/pg/preflight.js')
    await expect(pgRolePreflight(answering({ ...GOOD, rolsuper: true }, { ...GOOD, rolsuper: true }))).rejects.toThrow(/^the connected role is a superuser/)
  })

  it('a refused role never reaches the schema step: the migration functions are not called', async () => {
    const migrate = vi.fn(() => Promise.resolve({ applied: [], alreadyApplied: 0 }))
    const assertCurrent = vi.fn(() => Promise.resolve({ applied: [], alreadyApplied: 0 }))
    vi.doMock('pg', () => {
      class Pool {
        on() { return this }
        query() { return Promise.resolve({ rows: [] }) }
        end() { return Promise.resolve() }
      }
      return { default: { Pool, types: { setTypeParser: () => undefined, builtins: {} } }, Pool }
    })
    vi.doMock('../db-migrations-pg.js', () => ({ applyPgMigrations: migrate, assertPgSchemaCurrent: assertCurrent }))
    vi.doMock('../db/pg/preflight.js', () => ({
      pgRolePreflight: () => Promise.reject(new Error('the connected role is a superuser')),
      pgPreflight: () => Promise.resolve({ warnings: [] }),
    }))
    const { boot, facade } = await load()
    for (const migrateUrl of ['', MIGRATE_URL]) {
      const err = await boot.bootPgBackend({ url: DEAD_URL, migrateUrl }).then(() => null, (e: unknown) => e as InstanceType<typeof boot.PgBootError>)
      expect(err!.step).toBe('role')
    }
    expect(migrate).not.toHaveBeenCalled()
    expect(assertCurrent).not.toHaveBeenCalled()
    expect(facade.dbxDialect()).toBe('sqlite')
  })
})

describe('initDatabaseAsync', () => {
  it('with a URL configured it refuses the boot (no SQLite fallback): the rejection names the step, and no SQLite file appears', async () => {
    vi.stubEnv('MARVEEN_PG_URL', DEAD_URL)
    const { db } = await load()
    await expect(db.initDatabaseAsync()).rejects.toMatchObject({ name: 'PgBootError', step: 'pool' })
    expect(readdirSync(storeDir)).toEqual([])
  })

  it('without a URL it is the unchanged SQLite boot, and the pg driver is never loaded', async () => {
    vi.doMock('pg', () => { pgLoaded = true; return { default: {} } })
    const { db, facade, boot } = await load()
    expect(await db.initDatabaseAsync()).toBe('sqlite')
    expect(facade.dbxDialect()).toBe('sqlite')
    expect(pgLoaded).toBe(false)
    expect(readdirSync(storeDir)).toContain('claudeclaw.db')
    await boot.closePgBackend()
    db.closeDatabase()
  })
})

describe('the process boot (src/main.ts)', () => {
  const src = readFileSync(new URL('../main.ts', import.meta.url), 'utf-8')

  it('awaits initDatabaseAsync before anything that listens, and a rejection there ends the process through main().catch', () => {
    // the database boot lives in bootProcessDatabase (src/process-db-boot.ts), which awaits initDatabaseAsync; main() awaits it
    const boot = src.indexOf('await bootProcessDatabase()')
    expect(boot).toBeGreaterThan(0)
    expect(boot).toBeLessThan(src.indexOf('startWebServer(WEB_PORT)'))
    const procBoot = readFileSync(new URL('../process-db-boot.ts', import.meta.url), 'utf-8')
    expect(procBoot).toMatch(/await initDatabaseAsync\(\)/)
    expect(src.indexOf('startWebServer(WEB_PORT)')).toBeGreaterThan(0)
    expect(src).toMatch(/main\(\)\.catch\(\(err\) => \{[\s\S]*shutdown\(\)/)
  })

  it('no longer calls the synchronous initDatabase() itself (it would bypass the PostgreSQL choice)', () => {
    expect(src).not.toMatch(/^[ \t]*initDatabase\(\)/m)
  })

  it('has no PostgreSQL refusal left: main() does not call refuseProcessOnPg, and pg-boot no longer defines the refusal', () => {
    // A1 (guard removal, the LAST commit of the PG process PR). Mutant: the refusal call restored in main() turns this red.
    const bootSrc = readFileSync(new URL('../db/pg-boot.ts', import.meta.url), 'utf-8')
    expect(src).not.toMatch(/refuseProcessOnPg/)
    expect(bootSrc).not.toMatch(/refuseProcessOnPg|PgProcessNotSupportedError/)
  })

  it('ends the PostgreSQL pool at shutdown', () => {
    expect(src).toContain('closePgBackend()')
  })
})

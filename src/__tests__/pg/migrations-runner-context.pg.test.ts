// The PG migration runner and row-level security: the owner is bound by FORCE policies, so the runner has to run each
// file's transaction as the `system` context or its own schema_version row (and any data step of a later file) is refused
// or silently touches nothing. Real server (MARVEEN_PG_TEST_URL, `npm run test:pg`); the files are synthetic, 0009 is not
// involved. The mutants are listed in the PR description.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { applyPgMigrations, PG_MIGRATION_JOB } from '../../db-migrations-pg.js'
import { createPgTestDb, PG_TEST_OWNER_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'

// The privileged-only test: the `system` role, read the way the real helper reads it (empty string is no role).
const PRIV = "NULLIF(current_setting('app.role', true), '') = 'system'"

// A file that creates schema_version itself (the way the baseline does) and puts it under FORCE with a privileged-only
// write policy: the shape 0009 gives it, so the runner's bookkeeping INSERT is bound.
const SCHEMA_VERSION_FORCED = `
CREATE TABLE schema_version (
  version bigint, applied_at bigint NOT NULL, description text NOT NULL, checksum text, PRIMARY KEY (version)
);
ALTER TABLE schema_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_version FORCE ROW LEVEL SECURITY;
CREATE POLICY sv_read ON schema_version FOR SELECT USING (true);
CREATE POLICY sv_write ON schema_version FOR ALL USING (${PRIV}) WITH CHECK (${PRIV});
`

const PRIV_TABLE = `
CREATE TABLE priv_t (id bigint PRIMARY KEY, v text NOT NULL);
ALTER TABLE priv_t ENABLE ROW LEVEL SECURITY;
ALTER TABLE priv_t FORCE ROW LEVEL SECURITY;
CREATE POLICY priv_all ON priv_t FOR ALL USING (${PRIV}) WITH CHECK (${PRIV});
`

const SETTINGS = ['app.tenant_id', 'app.role', 'app.agent_id', 'app.job', 'app.user_id'] as const

let db: PgTestDb
let owner: pg.Pool // the owner role, ONE connection: a leaked session setting would be seen by the next query
let dir: string

const put = (name: string, sql: string): void => { writeFileSync(path.join(dir, name), sql) }
const versions = async (): Promise<number[]> =>
  (await db.pool.query<{ version: string }>('SELECT version FROM schema_version ORDER BY version')).rows.map((r) => Number(r.version))
/** The five settings as the next statement on the single owner connection sees them. */
async function settingsNow(): Promise<Record<string, string | null>> {
  const cols = SETTINGS.map((s) => `current_setting('${s}', true) AS "${s}"`).join(', ')
  return (await owner.query(`SELECT ${cols}`)).rows[0]
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'pg-runner-ctx-'))
  // an empty baseline: no table, no grants of any file; the cells build what they need through the runner itself
  const emptyBaseline = mkdtempSync(path.join(tmpdir(), 'pg-runner-ctx-empty-'))
  try { db = await createPgTestDb({ migrationsDir: emptyBaseline }) } finally { rmSync(emptyBaseline, { recursive: true, force: true }) }
  owner = new pg.Pool({ connectionString: db.ownerUrl, max: 1 })
})

afterEach(async () => {
  await owner.end().catch(() => undefined)
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('construction (the cells below prove nothing without it)', () => {
  it('the runner connection is the owner role: not a superuser, not BYPASSRLS', async () => {
    const who = await owner.query<{ me: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user AS me, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user')
    expect(who.rows[0]).toEqual({ me: PG_TEST_OWNER_ROLE, rolsuper: false, rolbypassrls: false })
  })

  it('FORCE binds the owner: with an empty context a schema_version INSERT is refused (42501) and an UPDATE touches nothing', async () => {
    put('0001_sv.sql', SCHEMA_VERSION_FORCED + PRIV_TABLE)
    await applyPgMigrations(owner, { dir })
    const flags = await db.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('schema_version', 'priv_t') ORDER BY relname")
    expect(flags.rows).toEqual([
      { relname: 'priv_t', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'schema_version', relrowsecurity: true, relforcerowsecurity: true },
    ])
    await expect(owner.query("INSERT INTO schema_version (version, applied_at, description) VALUES (99, 1, 'x')"))
      .rejects.toMatchObject({ code: '42501' })
    await db.pool.query("INSERT INTO priv_t (id, v) VALUES (1, 'seed')") // the superuser skips the policy
    const upd = await owner.query("UPDATE priv_t SET v = 'owner-no-context' WHERE id = 1")
    expect(upd.rowCount).toBe(0) // the silent failure a data migration would hit
    expect((await db.pool.query('SELECT v FROM priv_t WHERE id = 1')).rows[0].v).toBe('seed')
  })
})

describe('a file applied by the owner under FORCE', () => {
  it('the schema_version row is written (the bookkeeping INSERT is privileged-only) and the second run changes nothing', async () => {
    put('0001_sv.sql', SCHEMA_VERSION_FORCED)
    const first = await applyPgMigrations(owner, { dir })
    expect(first.applied).toEqual([1])
    expect(await versions()).toEqual([1])
    const again = await applyPgMigrations(owner, { dir })
    expect(again).toEqual({ applied: [], alreadyApplied: 1 })
    expect(await versions()).toEqual([1])
  })

  it('the file\'s own INSERT into a privileged-only table applies, in the same transaction as the version row', async () => {
    put('0001_sv.sql', SCHEMA_VERSION_FORCED + PRIV_TABLE + "INSERT INTO priv_t (id, v) VALUES (1, 'from-file');")
    await applyPgMigrations(owner, { dir })
    expect((await db.pool.query('SELECT id, v FROM priv_t')).rows).toEqual([{ id: 1, v: 'from-file' }])
    expect(await versions()).toEqual([1])
  })

  it('a data migration UPDATE of a seeded privileged-only row changes it (it does not silently match zero rows)', async () => {
    put('0001_sv.sql', SCHEMA_VERSION_FORCED + PRIV_TABLE)
    await applyPgMigrations(owner, { dir })
    await db.pool.query("INSERT INTO priv_t (id, v) VALUES (1, 'before'), (2, 'keep')") // seeded by the oracle
    put('0002_backfill.sql', "UPDATE priv_t SET v = 'after' WHERE id = 1;")
    await applyPgMigrations(owner, { dir })
    expect((await db.pool.query('SELECT id, v FROM priv_t ORDER BY id')).rows).toEqual([
      { id: 1, v: 'after' }, { id: 2, v: 'keep' },
    ])
    expect(await versions()).toEqual([1, 2])
  })

  it('the transaction carries the system context: role and job set, tenant, agent and user empty', async () => {
    put('0001_probe.sql', `
      CREATE TABLE ctx_probe (k text PRIMARY KEY, v text);
      INSERT INTO ctx_probe VALUES ${SETTINGS.map((s) => `('${s}', current_setting('${s}', true))`).join(', ')};`)
    await applyPgMigrations(owner, { dir })
    const seen = Object.fromEntries((await db.pool.query<{ k: string; v: string }>('SELECT k, v FROM ctx_probe')).rows.map((r) => [r.k, r.v]))
    expect(seen).toEqual({ 'app.tenant_id': '', 'app.role': 'system', 'app.agent_id': '', 'app.job': PG_MIGRATION_JOB, 'app.user_id': '' })
  })
})

describe('the context dies with the transaction (it never stays on the pooled connection)', () => {
  it('after a successful run the next statement on the same connection sees no setting', async () => {
    put('0001_sv.sql', SCHEMA_VERSION_FORCED)
    await applyPgMigrations(owner, { dir })
    expect(await settingsNow()).toEqual({ 'app.tenant_id': '', 'app.role': '', 'app.agent_id': '', 'app.job': '', 'app.user_id': '' })
  })

  it('after a failed file (rolled back) the same holds, and no version row was written', async () => {
    put('0001_sv.sql', SCHEMA_VERSION_FORCED)
    put('0002_broken.sql', 'SELECT 1 / 0;')
    await expect(applyPgMigrations(owner, { dir })).rejects.toThrow(/PG migration 2 .*rolled back/s)
    expect(await settingsNow()).toEqual({ 'app.tenant_id': '', 'app.role': '', 'app.agent_id': '', 'app.job': '', 'app.user_id': '' })
    expect(await versions()).toEqual([1])
    // and the connection is bound again: a privileged-only write without a context is refused
    await expect(owner.query("INSERT INTO schema_version (version, applied_at, description) VALUES (99, 1, 'x')"))
      .rejects.toMatchObject({ code: '42501' })
  })
})

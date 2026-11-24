// The unique-violation matcher (web/unique-violation.ts) against a real server, as the app role. PostgreSQL withholds the
// `detail` of a unique violation from a role that row-level security applies to, so a lost race on a username or a device key
// answered 500 instead of 409. The matcher now also reads the named constraint; the catalog cell pins that every
// constraint it names exists on the server under exactly that name (a rename must fail here, not in production).
//
// Privacy: neutral fixtures only.
import { afterAll, describe, expect, it } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { isUniqueViolationOn, PG_UNIQUE_CONSTRAINTS } from '../../web/unique-violation.js'

const made: PgTestDb[] = []
afterAll(async () => { for (const d of made) await d.close() })
async function freshDb(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  return d
}
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e)

describe('a duplicate written as the app role is recognised', () => {
  it('a device key hash: the app role gets no detail, the matcher still answers true; the admin pool gets the detail', async () => {
    const db = await freshDb()
    const sql = "INSERT INTO device_keys (key_hash, name, created_at, tenant_id) VALUES ('hash-a', 'key-a', 1, 'default')"
    await db.pool.query(sql)
    const asAdmin = await failure(db.pool.query(sql))
    expect((asAdmin as { detail?: string }).detail).toContain('hash-a') // the oracle: a superuser sees the detail
    const dbx = db.appDbx()
    const asApp = await runAs.system('unique-probe', () => failure(dbx.run(sql)))
    expect((asApp as { detail?: unknown }).detail).toBeUndefined() // the premise of this cell: the detail is withheld
    expect(isUniqueViolationOn(asApp, 'device_keys.key_hash')).toBe(true)
    expect(isUniqueViolationOn(asApp, 'device_keys.name')).toBe(false)
  })

  it('a username that differs only by case (the unique index is on lower(username)), as the admin and as the app role', async () => {
    const db = await freshDb()
    const ins = (name: string) => `INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role, tenant_id) VALUES ('${name}', 'x', 1, 1, 'viewer', 'tenant-a')`
    await db.pool.query(ins('user-a'))
    const asAdmin = await failure(db.pool.query(ins('USER-A')))
    expect(isUniqueViolationOn(asAdmin, 'dashboard_users.username')).toBe(true)
    const asApp = await runAs.system('unique-probe', () => failure(db.appDbx().run(ins('User-A'))))
    expect((asApp as { detail?: unknown }).detail).toBeUndefined()
    expect(isUniqueViolationOn(asApp, 'dashboard_users.username')).toBe(true)
  })
})

// The negative side. The cells above prove a real duplicate is matched; these prove the matcher does not over-match once the
// `detail` is gone (the app role), where only the table and the constraint name are left to tell one violation from another.
// Each cell is red on its own against one mutant of the matcher: "the constraint name is not compared" (the same table, a
// different constraint) and "the table is not compared" (the same constraint name, a different table).
describe('a duplicate of another key is not mistaken for the named one (app role, no detail)', () => {
  it('the same table, a different constraint: a duplicate primary key is not a duplicate key_hash / username', async () => {
    const db = await freshDb()
    const dbx = db.appDbx()
    const insKey = "INSERT INTO device_keys (id, key_hash, name, created_at, tenant_id) VALUES (7, 'hash-b', 'key-b', 1, 'default')"
    await db.pool.query(insKey)
    // same id, a hash that is free: only device_keys_pkey fails, key_hash is not involved
    const keyDup = await runAs.system('unique-probe', () => failure(dbx.run(insKey.replace("'hash-b'", "'hash-c'"))))
    expect((keyDup as { code?: string }).code).toBe('23505')
    expect((keyDup as { table?: string }).table).toBe('device_keys')
    expect((keyDup as { constraint?: string }).constraint).toBe('device_keys_pkey') // the premise: another constraint of the same table
    expect((keyDup as { detail?: unknown }).detail).toBeUndefined() // the premise: nothing but table and constraint to go on
    expect(isUniqueViolationOn(keyDup, 'device_keys.key_hash')).toBe(false)

    const insUser = (id: number, name: string) => `INSERT INTO dashboard_users (id, username, password_hash, created_at, updated_at, role, tenant_id) VALUES (${id}, '${name}', 'x', 1, 1, 'viewer', 'tenant-a')`
    await db.pool.query(insUser(7, 'user-b'))
    const userDup = await runAs.system('unique-probe', () => failure(dbx.run(insUser(7, 'user-c'))))
    expect((userDup as { constraint?: string }).constraint).toBe('dashboard_users_pkey')
    expect((userDup as { detail?: unknown }).detail).toBeUndefined()
    expect(isUniqueViolationOn(userDup, 'dashboard_users.username')).toBe(false)
  })

  it('another table that carries the SAME constraint name (a scratch schema): not a device_keys.key_hash duplicate', async () => {
    const db = await freshDb()
    // An index name is unique inside one schema, so a second table can only share the name from another schema. The scratch
    // table has no RLS and the app role gets INSERT only (no SELECT): that withholds the detail the way RLS does on the real tables.
    await db.ownerPool.query('CREATE SCHEMA scratch_other')
    await db.ownerPool.query('CREATE TABLE scratch_other.other_t (k text NOT NULL, CONSTRAINT device_keys_key_hash_key UNIQUE (k))')
    await db.ownerPool.query('GRANT USAGE ON SCHEMA scratch_other TO marveen_app')
    await db.ownerPool.query('GRANT INSERT ON scratch_other.other_t TO marveen_app')
    const ins = "INSERT INTO scratch_other.other_t (k) VALUES ('k-a')"
    const dbx = db.appDbx()
    await runAs.system('unique-probe', () => dbx.run(ins))
    const dup = await runAs.system('unique-probe', () => failure(dbx.run(ins)))
    expect((dup as { code?: string }).code).toBe('23505')
    expect((dup as { table?: string }).table).toBe('other_t')
    expect((dup as { constraint?: string }).constraint).toBe('device_keys_key_hash_key') // the premise: the same name, another table
    expect((dup as { detail?: unknown }).detail).toBeUndefined()
    expect(isUniqueViolationOn(dup, 'device_keys.key_hash')).toBe(false)
  })
})

describe('the constraint names the matcher relies on exist on the server', () => {
  it('every entry of PG_UNIQUE_CONSTRAINTS is a unique index (or constraint) of its table under exactly that name', async () => {
    const db = await freshDb()
    for (const [column, { table, constraint }] of Object.entries(PG_UNIQUE_CONSTRAINTS)) {
      const found = await db.pool.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
          WHERE c.relname = $1 AND t.relname = $2 AND i.indisunique`, [constraint, table])
      expect(found.rowCount, `${column}: ${constraint} on ${table}`).toBe(1)
      expect(column.startsWith(`${table}.`), `${column} names its own table`).toBe(true)
    }
  })
})

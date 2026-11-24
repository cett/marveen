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

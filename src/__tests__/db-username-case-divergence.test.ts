// An ACCEPTED divergence between the two engines (docs/db-facade.md, "Accepted divergences"): the unique rule on
// dashboard_users.username. SQLite says `UNIQUE COLLATE NOCASE`, which folds ASCII letters only; the PostgreSQL baseline says
// `UNIQUE (lower(username))`, and lower() of a UTF-8 server folds non-ASCII letters too. This is the SQLite half: it pins today's
// behavior so that a change of either engine is a decision, not a surprise. The PG half is in
// src/__tests__/pg/baseline-parity.pg.test.ts ("dashboard_users: a non-ASCII username ...").
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, db, dbx } from '../db.js'
import { isUniqueViolationOn } from '../web/unique-violation.js'
import { resetDbTestState } from './helpers/with-test-db.js'

// SQLite only by subject: the file opens its own in-memory database instead of calling useTestDb, so it is not in the
// PostgreSQL module run (the PG half of the pair is pg/baseline-parity.pg.test.ts) and the excluded count does not grow.
beforeEach(() => {
  resetDbTestState()
  initDatabase(':memory:')
})
afterEach(() => {
  try { db?.close() } catch { /* already closed */ }
  resetDbTestState()
})

const INSERT = "INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES (?, 'h', 1, 1)"
const insert = (username: string) => dbx.run(INSERT, username).then(() => null, (e: unknown) => e)

describe('dashboard_users.username on SQLite (COLLATE NOCASE)', () => {
  it('is unique regardless of ASCII case, the contract both engines share', async () => {
    expect(await insert('Agent-A')).toBeNull()
    expect(isUniqueViolationOn(await insert('agent-a'), 'dashboard_users.username')).toBe(true)
    expect(await insert('agent-b')).toBeNull()
  })

  it('does NOT fold a non-ASCII letter: two spellings that differ only in the case of one are two users (PostgreSQL refuses the second, see the PG cell)', async () => {
    expect(await insert('Émile')).toBeNull() // E acute, capital
    expect(await insert('émile')).toBeNull() // e acute, small: accepted here, a unique violation on PostgreSQL
    const rows = await dbx.all<{ username: string }>('SELECT username FROM dashboard_users ORDER BY id')
    expect(rows.map((r) => r.username)).toEqual(['Émile', 'émile'])
  })
})

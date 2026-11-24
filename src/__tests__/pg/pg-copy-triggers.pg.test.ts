// User triggers during the copy (P-G1, decided 2026-11-24) against the real baseline: the homoglyph AFTER INSERT
// triggers would add findings while the rows are written. The copy must write what SQLite holds, name the suspended
// triggers, and leave every trigger in its recorded state (H1-H4), refuse a copy role that does not own the tables by name
// (H5), and keep the foreign-key triggers on (H6). The titles are neutral fixtures: one Cyrillic letter.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { runCheck } from '../../db/pg-copy/check.js'
import { runCopy } from '../../db/pg-copy/copy.js'
import { PG_SET_CONTEXT_SQL, pgContextValues } from '../../db/pg/dbx.js'
import { restoreUserTriggers, suspendUserTriggers, TRIGGER_LOCK_TIMEOUT, TriggerRestoreError } from '../../db/pg-copy/triggers.js'
import { createPgTestDb, PG_TEST_APP_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

let target: PgTestDb | undefined
afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

/** The SQLite source: one look-alike card, one plain card, and (H4) one look-alike comment on a second trigger table. */
function buildSqlite(withComment = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-triggers-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const db = new Database(file)
  applyMigrations(db)
  db.exec(`
    INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES
      ('kc-look', 'fast with one Cyrillic a: fаst', 'planned', 'normal', 0, 1, 1),
      ('kc-plain', 'plain title', 'planned', 'normal', 0, 1, 1);
  `)
  if (withComment) {
    db.exec("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('kc-look', 'agent-a', 'a comment with о once', 1)")
  }
  // the SQLite side has its own homoglyph triggers: the findings above are the source's, written by SQLite
  db.close()
  return file
}

describe('user triggers during the copy: the source is copied, the triggers are restored', () => {
  it('H1: the findings in PostgreSQL are exactly the source findings; the suspended triggers are named', async () => {
    target = await createPgTestDb()
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: target.ownerUrl, dryRun: false })
    expect(report.failure).toBeUndefined()
    expect(report.committed).toBe(true)
    expect(report.suspendedTriggers).toEqual(expect.arrayContaining([
      { table: 'kanban_cards', triggers: expect.arrayContaining(['homoglyph_kanban_cards_ai']) },
      { table: 'kanban_comments', triggers: ['homoglyph_kanban_comments_ai'] },
    ]))
    const findings = await target.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM homoglyph_findings')
    expect(Number(findings.rows[0]?.n)).toBe(1)
  })

  it('H2: after the copy every trigger is alive: an insert of a look-alike title afterwards writes a new finding', async () => {
    target = await createPgTestDb()
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: target.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const states = await target.pool.query<{ name: string; enabled: string }>(
      "SELECT tgname::text AS name, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'homoglyph_%' ORDER BY tgname",
    )
    expect(states.rows.map((r) => r.enabled)).toEqual(['O', 'O'])
    await target.pool.query("INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES ('kc-after', 'after: а', 'planned', 'normal', 0, 1, 1)")
    const after = await target.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM homoglyph_findings WHERE src_id = 'kc-after'")
    expect(Number(after.rows[0]?.n)).toBe(1)
  })

  it('H3: a trigger recorded DISABLED stays disabled, one recorded ENABLE ALWAYS comes back ALWAYS, the origin ones come back ORIGIN', async () => {
    target = await createPgTestDb()
    await target.pool.query("CREATE FUNCTION noop_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$")
    await target.pool.query('CREATE TRIGGER kc_off AFTER INSERT ON kanban_cards FOR EACH ROW EXECUTE FUNCTION noop_trg()')
    await target.pool.query('CREATE TRIGGER kc_always AFTER INSERT ON kanban_cards FOR EACH ROW EXECUTE FUNCTION noop_trg()')
    await target.pool.query('ALTER TABLE kanban_cards DISABLE TRIGGER kc_off')
    await target.pool.query('ALTER TABLE kanban_cards ENABLE ALWAYS TRIGGER kc_always')
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: target.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const states = await target.pool.query<{ name: string; enabled: string }>(
      "SELECT tgname::text AS name, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'kanban_cards'::regclass ORDER BY tgname",
    )
    expect(states.rows).toEqual([
      { name: 'homoglyph_kanban_cards_ai', enabled: 'O' },
      { name: 'kanban_cards_status_bumps_updated_at', enabled: 'O' },
      { name: 'kc_always', enabled: 'A' },
      { name: 'kc_off', enabled: 'D' },
    ])
  })

  it('H4: every trigger table is covered: the findings per table equal the source on both tables with a trigger', async () => {
    target = await createPgTestDb()
    const sqlitePath = buildSqlite(true)
    const source = new Database(sqlitePath, { readonly: true })
    const expected = source.prepare('SELECT src_table, count(*) AS n FROM homoglyph_findings GROUP BY src_table ORDER BY src_table').all() as Array<{ src_table: string; n: number }>
    source.close()
    const report = await runCopy({ sqlitePath, pgUrl: target.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const pg = await target.pool.query<{ src_table: string; n: string }>(
      'SELECT src_table, count(*)::text AS n FROM homoglyph_findings GROUP BY src_table ORDER BY src_table',
    )
    expect(pg.rows.map((r) => ({ src_table: r.src_table, n: Number(r.n) }))).toEqual(expected)
    expect(expected.map((r) => r.src_table)).toEqual(['kanban_cards', 'kanban_comments'])
  })
})

describe('the restore asserts the catalog equals the record (M7 cell)', () => {
  it('a recorded state the catalog does not show after the restore: the restore stops by name (TriggerRestoreError)', async () => {
    target = await createPgTestDb()
    const client = await target.ownerPool.connect()
    try {
      await client.query('BEGIN')
      // kc_on is ORIGIN in the catalog; the record says DISABLED, which the restore never applies: the assert must see it
      await target.pool.query("CREATE FUNCTION noop_m7() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$")
      await target.pool.query('CREATE TRIGGER kc_on AFTER INSERT ON kanban_cards FOR EACH ROW EXECUTE FUNCTION noop_m7()')
      await expect(
        restoreUserTriggers(client, [{ table: 'kanban_cards', name: 'kc_on', enabled: 'D' }], ['kanban_cards']),
      ).rejects.toThrow(TriggerRestoreError)
      await expect(
        restoreUserTriggers(client, [{ table: 'kanban_cards', name: 'kc_on', enabled: 'D' }], ['kanban_cards']),
      ).rejects.toThrow(/the state is O, recorded D/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})

describe('the trigger states beyond the origin, the extra and the missing trigger, the lock wait (H7-H10)', () => {
  it('H7: a trigger recorded ENABLE REPLICA comes back REPLICA (R), not ORIGIN', async () => {
    target = await createPgTestDb()
    await target.pool.query("CREATE FUNCTION noop_h7() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$")
    await target.pool.query('CREATE TRIGGER kc_replica AFTER INSERT ON kanban_cards FOR EACH ROW EXECUTE FUNCTION noop_h7()')
    await target.pool.query('ALTER TABLE kanban_cards ENABLE REPLICA TRIGGER kc_replica')
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: target.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const states = await target.pool.query<{ name: string; enabled: string }>(
      "SELECT tgname::text AS name, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'kanban_cards'::regclass AND tgname = 'kc_replica'",
    )
    expect(states.rows).toEqual([{ name: 'kc_replica', enabled: 'R' }])
  })

  it('H8: a trigger that appears during the write (not recorded) stops the restore by name', async () => {
    target = await createPgTestDb()
    const client = await target.ownerPool.connect()
    try {
      await client.query('BEGIN')
      await target.pool.query("CREATE FUNCTION noop_h8() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$")
      await target.pool.query('CREATE TRIGGER kc_h8_on AFTER INSERT ON kanban_cards FOR EACH ROW EXECUTE FUNCTION noop_h8()')
      await target.pool.query('CREATE TRIGGER kc_h8_extra AFTER INSERT ON kanban_cards FOR EACH ROW EXECUTE FUNCTION noop_h8()')
      // only kc_h8_on was recorded: the catalog holds one more trigger than the record, and the restore must say so
      await expect(
        restoreUserTriggers(client, [{ table: 'kanban_cards', name: 'kc_h8_on', enabled: 'O' }], ['kanban_cards']),
      ).rejects.toThrow(/a trigger that was not recorded appeared/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('H9: a recorded trigger that is missing at restore is an error, and the transaction rolls back (nothing is committed)', async () => {
    target = await createPgTestDb()
    const client = await target.ownerPool.connect()
    try {
      await client.query('BEGIN')
      // kc_h9_gone was never created: the restore's ENABLE names it and PostgreSQL refuses before the catalog check runs
      await expect(
        restoreUserTriggers(client, [{ table: 'kanban_cards', name: 'kc_h9_gone', enabled: 'O' }], ['kanban_cards']),
      ).rejects.toThrow(/kc_h9_gone/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('H10: the lock wait is set for the suspension transaction only: inside it the timeout is the bounded one, after the rollback it is not', async () => {
    target = await createPgTestDb()
    const client = await target.ownerPool.connect()
    try {
      await client.query('BEGIN')
      await suspendUserTriggers(client, ['kanban_cards'])
      const inside = await client.query<{ v: string }>("SELECT current_setting('lock_timeout') AS v")
      expect(inside.rows[0]?.v).toBe(TRIGGER_LOCK_TIMEOUT)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const outside = await target.pool.query<{ v: string }>("SELECT current_setting('lock_timeout') AS v")
    expect(outside.rows[0]?.v).not.toBe(TRIGGER_LOCK_TIMEOUT)
  })
})

describe('the copy role must own the tables that carry triggers (H5)', () => {
  it('H5: a copy role that does not own the table is refused by name, with the trigger names, and the check says nothing raw', async () => {
    target = await createPgTestDb()
    const report = await runCheck({ sqlitePath: buildSqlite(), pgUrl: target.appUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'kanban_cards',
        reason: expect.stringMatching(new RegExp(`${PG_TEST_APP_ROLE} does not own kanban_cards, which has triggers: .*homoglyph_kanban_cards_ai`)),
      }),
    ]))
    expect(JSON.stringify(report)).not.toContain('42501')
  })
})

describe('the foreign-key triggers stay on during the suspension (H6)', () => {
  it('H6: an orphan written while the user triggers are suspended is still refused by PostgreSQL (23503)', async () => {
    target = await createPgTestDb()
    const client = await target.ownerPool.connect()
    try {
      await client.query('BEGIN')
      // the copy's own system context: under row-level security the policy would refuse the row first (42501), before the
      // foreign-key trigger is reached; the cell needs the foreign key to be the one that refuses
      await client.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'system', name: 'pg-copy' }) })
      await suspendUserTriggers(client, ['kanban_cards'])
      await expect(
        client.query("INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, parent_id) VALUES ('kc-orphan', 'orphan', 'planned', 'normal', 0, 1, 1, 'no-such-card')"),
      ).rejects.toMatchObject({ code: '23503' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    const internal = await target.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_trigger WHERE tgisinternal AND tgrelid = 'kanban_cards'::regclass AND tgenabled = 'D'",
    )
    expect(Number(internal.rows[0]?.n)).toBe(0)
  })
})

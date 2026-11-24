// `copy` of the SQLite -> PostgreSQL copy tool (P-G1) against a real PostgreSQL 16 target. The SQLite side is built by the
// real migration chain and given a few rows; the copy writes them into a clone of the baseline. Every anomaly class has its
// own cell and the run must write nothing; a clean run must leave every copied table equal to its SQLite count.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { runCopy, type CopyReport } from '../../db/pg-copy/copy.js'
import { runCheck } from '../../db/pg-copy/check.js'
import { SEED_TABLES, skipReason } from '../../db/pg-copy/schema.js'
import { createPgTestDb, PG_TEST_BACKUP_ROLE, pgTestRoleUrl, pgTestUrl, type PgTestDb } from '../helpers/pg-test-db.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/**
 * A SQLite database built by the migration chain with a few rows. Constraints are switched off while the fixture is written
 * (the anomaly cells need values the SQLite side would refuse); `extra` runs last.
 */
function buildSqlite(extra?: (db: Database.Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-copy-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const db = new Database(file)
  applyMigrations(db)
  db.pragma('foreign_keys = OFF')
  db.pragma('ignore_check_constraints = ON')
  db.exec(`
    INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'entity-a', 'action-a'), ('agent-a', 'entity-b', 'action-b');
    INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES ('kanban-one', 'first card', 1, 1), ('kanban-two', 'second card', 2, 2);
    INSERT INTO memories (chat_id, content, sector, created_at, accessed_at) VALUES ('chat-a', 'a remembered thing', 'semantic', 1, 1);
  `)
  extra?.(db)
  db.close()
  return file
}

const quoteIdentForTest = (name: string): string => `"${name.replace(/"/g, '""')}"`

let target: PgTestDb | undefined

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

async function freshTarget(): Promise<PgTestDb> {
  target = await createPgTestDb()
  return target
}

/** Rows of every non-seed copied table, summed: 0 on a target the copy did not write into. */
async function nonSeedRows(t: PgTestDb): Promise<number> {
  const r = await t.pool.query<{ n: string }>(`
    SELECT (SELECT count(*) FROM agent_audit_log) + (SELECT count(*) FROM kanban_cards) + (SELECT count(*) FROM memories) AS n`)
  return Number(r.rows[0]?.n)
}

/** The sequence values of every identity column, as the catalog reports them: a dry run must leave them where they were. */
async function sequenceState(t: PgTestDb): Promise<string> {
  const r = await t.pool.query<{ seq: string; last: string | null; called: boolean | null }>(`
    SELECT sequencename AS seq, last_value::text AS last, NULL::boolean AS called FROM pg_sequences ORDER BY sequencename`)
  return JSON.stringify(r.rows)
}

describe('a clean copy: every copied table equals its SQLite count, and the identity sequences continue', () => {
  it('the rows arrive, the counts match the SQLite side, and a row inserted after the copy gets a fresh id', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite()
    const report: CopyReport = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false })
    expect(report.refusals).toEqual([])
    expect(report.anomalies).toEqual([])
    expect(report.failure).toBeUndefined()
    expect(report.committed).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.seedsCleared.sort()).toEqual([...SEED_TABLES].sort())
    expect(report.tables.length).toBeGreaterThan(70)

    // every SQLite table that is not on the skip list is compared with its PostgreSQL count (not only the tables the report
    // names: a table the copy forgot would otherwise be invisible here)
    const source = new Database(sqlitePath, { readonly: true })
    try {
      const names = (source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((r) => r.name)
        .filter((n) => skipReason(n) === undefined)
      expect(names.length).toBeGreaterThan(70)
      for (const name of names) {
        const sqliteCount = Number((source.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number | bigint }).n)
        const pg = await t.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${name}"`)
        expect(Number(pg.rows[0]?.n), name).toBe(sqliteCount)
      }
    } finally {
      source.close()
    }
    for (const tbl of report.tables) expect(tbl.writtenRows, tbl.name).toBe(tbl.sourceRows)

    const kanban = await t.pool.query<{ seq: string; title: string }>("SELECT seq::text AS seq, title FROM kanban_cards WHERE id = 'kanban-two'")
    expect(kanban.rows[0]).toEqual({ seq: '2', title: 'second card' })

    const inserted = await t.pool.query<{ id: string }>(
      "INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'after', 'copy') RETURNING id::text AS id",
    )
    expect(Number(inserted.rows[0]!.id)).toBe(3)
    const idSetting = report.identity.find((i) => i.table === 'agent_audit_log' && i.column === 'id')
    expect(idSetting?.next).toBe('3')
  })

  it('the copied seed tables are the SQLite rows (the baseline seed is replaced, not merged)', async () => {
    const t = await freshTarget()
    const sqlite = new Database(buildSqlite(), { readonly: true })
    const sqliteTenants = (sqlite.prepare('SELECT count(*) AS n FROM tenants').get() as { n: number | bigint }).n
    sqlite.close()
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const pgTenants = await t.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM tenants')
    expect(Number(pgTenants.rows[0]!.n)).toBe(Number(sqliteTenants))
  })
})

describe('a dry run ends in a rollback: the target is as it was, byte for byte in its counts and sequences', () => {
  it('the same report, committed false, and nothing written', async () => {
    const t = await freshTarget()
    const before = await sequenceState(t)
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: true })
    expect(report.ok).toBe(true)
    expect(report.committed).toBe(false)
    expect(report.dryRun).toBe(true)
    expect(report.tables.reduce((n, x) => n + x.writtenRows, 0)).toBeGreaterThan(0)
    expect(await nonSeedRows(t)).toBe(0)
    expect(await sequenceState(t)).toBe(before)
  })
})

describe('every anomaly class: detected before the first write, nothing written, named by table and column', () => {
  const cases: Array<{ name: string; extra: (db: Database.Database) => void; expect: (r: CopyReport) => void }> = [
    {
      name: 'text in a bigint column',
      extra: (db) => { db.exec("UPDATE memories SET accessed_at = 'not-a-number'") },
      expect: (r) => expect(r.anomalies).toEqual([expect.objectContaining({ table: 'memories', column: 'accessed_at', sqliteType: 'text' })]),
    },
    {
      name: 'a NUL byte in a text column',
      extra: (db) => { db.exec("UPDATE memories SET content = 'a' || char(0) || 'b'") },
      expect: (r) => expect(r.anomalies).toEqual([expect.objectContaining({ table: 'memories', column: 'content', reason: expect.stringMatching(/NUL/) })]),
    },
    {
      name: 'a flag of 2 against the 0/1 check',
      extra: (db) => { db.exec('UPDATE memories SET auto_generated = 2') },
      expect: (r) => expect(r.anomalies).toEqual([expect.objectContaining({ table: 'memories', column: 'auto_generated', reason: expect.stringMatching(/flag is 2/) })]),
    },
    {
      name: 'text that is not valid UTF-8',
      extra: (db) => { db.exec("UPDATE kanban_cards SET title = CAST(x'FF' AS TEXT) WHERE id = 'kanban-one'") },
      expect: (r) => expect(r.anomalies).toEqual([expect.objectContaining({ table: 'kanban_cards', column: 'title', reason: expect.stringMatching(/UTF-8/) })]),
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const t = await freshTarget()
      const report = await runCopy({ sqlitePath: buildSqlite(c.extra), pgUrl: t.ownerUrl, dryRun: false })
      expect(report.ok).toBe(false)
      expect(report.committed).toBe(false)
      c.expect(report)
      expect(await nonSeedRows(t)).toBe(0)
    })
  }

  it('a foreign-key orphan is refused before the first write: the constraint is named, the row key is the rowid, nothing is written', async () => {
    const t = await freshTarget()
    const seqBefore = await sequenceState(t)
    const report = await runCopy({
      sqlitePath: buildSqlite((db) => { db.exec("UPDATE kanban_cards SET parent_id = 'no-such-card-marker' WHERE id = 'kanban-two'") }),
      pgUrl: t.ownerUrl,
      dryRun: false,
    })
    expect(report.ok).toBe(false)
    expect(report.failure).toBeUndefined()
    expect(report.refusals).toEqual([expect.objectContaining({ table: 'kanban_cards', column: 'parent_id', reason: expect.stringMatching(/kanban_cards_parent_id_fkey.*1 orphan row\(s\).*rowids: 2/) })])
    expect(await nonSeedRows(t)).toBe(0)
    expect(await sequenceState(t)).toBe(seqBefore)
    expect(JSON.stringify(report)).not.toContain('no-such-card-marker')
  })

  it('a CHECK violation of the target is refused by its constraint name', async () => {
    const t = await freshTarget()
    const seqBefore = await sequenceState(t)
    const report = await runCopy({
      sqlitePath: buildSqlite((db) => { db.exec("UPDATE kanban_cards SET status = 'bogus-status' WHERE id = 'kanban-one'") }),
      pgUrl: t.ownerUrl,
      dryRun: false,
    })
    expect(report.failure).toEqual(expect.objectContaining({ table: 'kanban_cards', constraint: 'kanban_cards_status_check', rowid: '1' }))
    expect(await nonSeedRows(t)).toBe(0)
    expect(await sequenceState(t)).toBe(seqBefore)
  })

  it('a case-only duplicate username is refused by the lower-case unique index, nothing written', async () => {
    const t = await freshTarget()
    const report = await runCopy({
      // SQLite's own username constraint is UNIQUE COLLATE NOCASE and cannot hold this pair; the source table is rebuilt
      // without it (a source written by an older build, say), so the copy meets the case-only pair on PostgreSQL
      sqlitePath: buildSqlite((db) => {
        // the first row goes in while the unique constraint still exists; the table is then rebuilt with its values (a
        // CREATE TABLE AS keeps the values and drops the defaults, so the second row is a copy of the first, in full)
        db.exec("INSERT INTO dashboard_users (id, username, password_hash, created_at, updated_at) VALUES (1, 'Admin', 'h1', 1, 1)")
        db.exec('ALTER TABLE dashboard_users RENAME TO dashboard_users_old')
        db.exec('CREATE TABLE dashboard_users AS SELECT * FROM dashboard_users_old')
        const cols = (db.prepare('PRAGMA table_info(dashboard_users)').all() as Array<{ name: string }>).map((c) => c.name)
        const select = cols.map((c) => (c === 'id' ? '2' : c === 'username' ? "'admin'" : quoteIdentForTest(c))).join(', ')
        db.exec(`INSERT INTO dashboard_users (${cols.map(quoteIdentForTest).join(', ')}) SELECT ${select} FROM dashboard_users WHERE id = 1`)
        db.exec('DROP TABLE dashboard_users_old')
      }),
      pgUrl: t.ownerUrl,
      dryRun: false,
    })
    expect(report.failure?.table).toBe('dashboard_users')
    expect(report.failure?.sqlstate).toBe('23505')
    const users = await t.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dashboard_users')
    expect(users.rows[0]!.n).toBe('0')
  })
})

describe('the precondition gate: a copy never starts from a red plan', () => {
  it('a target that already holds a row is refused: nothing is written, the existing row is the only row', async () => {
    const t = await freshTarget()
    await t.pool.query("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-a', 'existing', 'a')")
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.ok).toBe(false)
    expect(report.committed).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/not empty/) })]))
    expect(await nonSeedRows(t)).toBe(1)
  })

  it('a superuser is refused: nothing is written', async () => {
    const t = await freshTarget()
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.url, dryRun: false })
    expect(report.ok).toBe(false)
    expect(report.committed).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: '(role)', reason: expect.stringMatching(/superuser/) })]))
    expect(await nonSeedRows(t)).toBe(0)
  })

  it('a BYPASSRLS role that can read the tables is refused: nothing is written', async () => {
    const t = await freshTarget()
    await t.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PG_TEST_BACKUP_ROLE}`)
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: pgTestRoleUrl(pgTestUrl(), t.name, PG_TEST_BACKUP_ROLE), dryRun: false })
    expect(report.ok).toBe(false)
    expect(report.committed).toBe(false)
    expect(report.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: '(role)', reason: expect.stringMatching(/bypasses row-level security/) })]))
    expect(await nonSeedRows(t)).toBe(0)
  })
})

describe('batching: more rows than one chunk and one keyset batch', () => {
  it('a table with 2602 rows is copied whole: the count and the content sums match the SQLite side', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      db.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 2600) INSERT INTO agent_audit_log (agent_id, entity, action) SELECT 'agent-b', 'entity-' || i, 'action-' || i FROM c")
    })
    const report = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const src = new Database(sqlitePath, { readonly: true })
    const sumsSql = 'SELECT count(*) AS n, sum(id) AS ids, sum(length(entity)) AS len, max(entity) AS last FROM agent_audit_log'
    const expected = src.prepare(sumsSql).get() as Record<string, unknown>
    src.close()
    const pg = await t.pool.query<Record<string, string | null>>(
      'SELECT count(*)::text AS n, sum(id)::text AS ids, sum(length(entity))::text AS len, max(entity) AS last FROM agent_audit_log',
    )
    expect(pg.rows[0]!.n).toBe(String(expected.n))
    expect(pg.rows[0]!.ids).toBe(String(expected.ids))
    expect(pg.rows[0]!.len).toBe(String(expected.len))
    expect(pg.rows[0]!.last).toBe(String(expected.last))
    expect(Number(pg.rows[0]!.n)).toBe(2602)
  })
})

describe('a failing run moves no identity sequence', () => {
  it('a row refused late in the run (a check constraint on memories): the identity sequences are as they were before the run', async () => {
    const t = await freshTarget()
    // a constraint, not a trigger: the copy suspends the user triggers, and a check constraint is not one of them (c2 fixup)
    await t.pool.query('ALTER TABLE memories ADD CONSTRAINT boom_c2 CHECK (false) NOT VALID')
    const before = await sequenceState(t)
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.committed).toBe(false)
    expect(report.failure).toBeDefined()
    expect(await sequenceState(t)).toBe(before)
    expect(await nonSeedRows(t)).toBe(0)
  })
})

describe('the report carries names and counts, never a value (c3)', () => {
  it('a NUL anomaly on a row with a marker value: the marker is nowhere in the report, and nothing is written', async () => {
    const t = await freshTarget()
    const report = await runCopy({
      sqlitePath: buildSqlite((db) => {
        db.exec("INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('secret-marker-c3', 'bad' || char(0) || 'entity', 'a')")
      }),
      pgUrl: t.ownerUrl,
      dryRun: false,
    })
    expect(report.committed).toBe(false)
    expect(report.anomalies).toEqual([expect.objectContaining({ table: 'agent_audit_log', column: 'entity' })])
    expect(JSON.stringify(report)).not.toContain('secret-marker-c3')
    expect(await nonSeedRows(t)).toBe(0)
  })
})

describe('the read-back: a target row that reads back different from what was written stops the run (c3)', () => {
  it('a rule changes the row on insert: the count matches, the fingerprint does not; nothing committed, the table named', async () => {
    const t = await freshTarget()
    // a rule, not a trigger: the copy suspends the user triggers, and a rule is not one of them (c3 fixup)
    await ruleOnInsert(t, 'agent_audit_log', 'tamper_c3', "NEW.entity NOT LIKE '%-tampered'", 'v.entity := v.entity || \'-tampered\';')
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.committed).toBe(false)
    expect(report.failure).toEqual(expect.objectContaining({ table: 'agent_audit_log', reason: expect.stringMatching(/do not match/) }))
    expect(JSON.stringify(report)).not.toContain('entity-a')
    expect(await nonSeedRows(t)).toBe(0)
  })
})

describe('identity: every identity column continues after the copied maximum (c3)', () => {
  it('for every identity column with rows, the next value is above the largest copied value', async () => {
    const t = await freshTarget()
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    const cols = await t.pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND is_identity = 'YES' ORDER BY 1, 2",
    )
    let checked = 0
    for (const { table_name, column_name } of cols.rows) {
      const max = await t.pool.query<{ max: string | null }>(`SELECT max(${quoteIdentForTest(column_name)})::text AS max FROM ${quoteIdentForTest(table_name)}`)
      if (max.rows[0]!.max === null) continue
      const seq = await t.pool.query<{ seq: string }>('SELECT pg_get_serial_sequence($1, $2) AS seq', [quoteIdentForTest(table_name), column_name])
      const next = await t.pool.query<{ next: string }>('SELECT nextval($1::regclass)::text AS next', [seq.rows[0]!.seq])
      expect(BigInt(next.rows[0]!.next), `${table_name}.${column_name}`).toBeGreaterThan(BigInt(max.rows[0]!.max!))
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

/**
 * A drift by rule, not by trigger: the copy suspends the user triggers, and a rule is not one of them (decided 2026-11-24).
 * PostgreSQL refuses a rule that inserts into its own table (infinite recursion), so the rewritten row goes in through a
 * function. `guard` is the rule's condition on NEW; it must be false for the rewritten row, so the rule does not fire again.
 * `body` edits the row variable v before the function inserts it. The insert names the stored columns only: a generated
 * column (the fts of memories) is not inserted.
 */
async function ruleOnInsert(t: PgTestDb, table: string, name: string, guard: string, body: string): Promise<void> {
  const cols = await t.pool.query<{ column_name: string }>(
    `SELECT column_name::text AS column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    [table],
  )
  const names = cols.rows.map((r) => quoteIdentForTest(r.column_name))
  await t.pool.query(
    `CREATE FUNCTION ${name}_fn(r ${table}) RETURNS void LANGUAGE plpgsql AS $$ DECLARE v ${table}%ROWTYPE; BEGIN v := r; ${body} INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((n) => `v.${n}`).join(', ')}); END $$`,
  )
  await t.pool.query(`CREATE RULE ${name} AS ON INSERT TO ${table} WHERE ${guard} DO INSTEAD SELECT ${name}_fn(NEW)`)
}

// The value classes the read-back must tell apart, each on a real column of memories (c3 fixup): a NULL, a bytea, a double and
// a bigint above 2^53. One fixture row carries one of each. A rule drifts one column on insert, and the run must stop.
const VALUE_CLASS_ROW = `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, salience, topic_key, keywords, embedding_blob)
  VALUES ('chat-vc', 'value class row', 'semantic', 9007199254740993, 1, 0.1234567890123456, NULL, 'kw', X'00112233445566778899aabbccddeeff')`

// guard: the rule's condition on NEW (true for the fixture row); the drift makes the guard false for the row it writes.
const DRIFTS: Array<{ name: string; guard: string; body: string }> = [
  { name: 'NULL read back as an empty string', guard: 'NEW.topic_key IS NULL', body: "IF v.topic_key IS NULL THEN v.topic_key := ''; END IF;" },
  { name: 'a bytea byte changed, the length kept', guard: 'get_byte(NEW.embedding_blob, 0) = 0', body: 'v.embedding_blob := set_byte(v.embedding_blob, 0, 1);' },
  { name: 'a double rounded to float4', guard: 'NEW.salience <> NEW.salience::real::double precision', body: 'v.salience := v.salience::real::double precision;' },
  { name: 'a bigint above 2^53 changed by one', guard: 'NEW.created_at > 9007199254740992', body: 'v.created_at := v.created_at - 1;' },
]

function valueClassSqlite(): string {
  return buildSqlite((db) => {
    db.exec(VALUE_CLASS_ROW)
  })
}

async function driftOnInsert(t: PgTestDb, drift: { guard: string; body: string }): Promise<void> {
  await ruleOnInsert(t, 'memories', 'drift_vc', drift.guard, drift.body)
}

describe('the read-back tells every value class apart (c3 fixup)', () => {
  it('the value-class fixture copies clean and reads back with the values it was written with', async () => {
    const t = await freshTarget()
    const report = await runCopy({ sqlitePath: valueClassSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.failure).toBeUndefined()
    expect(report.committed).toBe(true)
    const r = await t.pool.query(
      "SELECT topic_key, salience, created_at::text AS created, encode(embedding_blob, 'hex') AS blob FROM memories WHERE chat_id = 'chat-vc'",
    )
    expect(r.rows[0]).toEqual({ topic_key: null, salience: 0.1234567890123456, created: '9007199254740993', blob: '00112233445566778899aabbccddeeff' })
  })

  for (const drift of DRIFTS) {
    it(`${drift.name}: the run stops, names memories, commits nothing and moves no identity sequence`, async () => {
      const t = await freshTarget()
      await driftOnInsert(t, drift)
      const before = await sequenceState(t)
      const report = await runCopy({ sqlitePath: valueClassSqlite(), pgUrl: t.ownerUrl, dryRun: false })
      expect(report.committed).toBe(false)
      expect(report.failure).toEqual(expect.objectContaining({ table: 'memories', reason: expect.stringMatching(/do not match/) }))
      expect(JSON.stringify(report)).not.toContain('value class row')
      expect(await nonSeedRows(t)).toBe(0)
      expect(await sequenceState(t)).toBe(before)
    })
  }

  it('a dry run verifies too: the drift is reported by the dry run, nothing is committed, the sequences do not move', async () => {
    const t = await freshTarget()
    await driftOnInsert(t, DRIFTS[0]!)
    const before = await sequenceState(t)
    const report = await runCopy({ sqlitePath: valueClassSqlite(), pgUrl: t.ownerUrl, dryRun: true })
    expect(report.committed).toBe(false)
    expect(report.failure).toEqual(expect.objectContaining({ table: 'memories' }))
    expect(await sequenceState(t)).toBe(before)
  })
})

describe('the order the check reports is the order the copy writes', () => {
  it('report.tables is the check writeOrder, and the policy edge holds: kanban_cards is written before kanban_card_events (a policy, no foreign key)', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite()
    const checkReport = await runCheck({ sqlitePath, pgUrl: t.ownerUrl })
    expect(checkReport.ok).toBe(true)
    const planned = checkReport.plan.writeOrder ?? []
    const report = await runCopy({ sqlitePath, pgUrl: t.ownerUrl, dryRun: false })
    expect(report.committed).toBe(true)
    expect(report.tables.map((x) => x.name)).toEqual(planned)
    expect(planned.indexOf('kanban_cards')).toBeLessThan(planned.indexOf('kanban_card_events'))
  })
})

describe('the report never quotes a refused row: the driver detail of a constraint error carries the values (d)', () => {
  it('a row refused by a unique index: the sentinel from the row is nowhere in the report, the constraint is named', async () => {
    const t = await freshTarget()
    // The driver detail of a unique violation is "Key (action)=(...) already exists.": it carries the value of the refused row.
    // A CHECK violation carries no value in its detail, so the earlier CHECK version of this cell could not see a leak at
    // all. PostgreSQL shows the key to a role that
    // may read the column; every baseline table is FORCE RLS, so this cell lifts FORCE on the one table it uses (the
    // owner, which the copy runs as, is then not subject to the policy). The report must still not carry the value.
    await t.pool.query('ALTER TABLE agent_audit_log NO FORCE ROW LEVEL SECURITY')
    await t.pool.query('CREATE UNIQUE INDEX uq_d ON agent_audit_log (action)')
    const report = await runCopy({
      sqlitePath: buildSqlite((db) => {
        // two rows with the same action: the second one is refused by the index, the first one is written
        db.exec(
          "INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('agent-d', 'entity-d-1', 'sentinel-d-value'), ('agent-d', 'entity-d-2', 'sentinel-d-value')",
        )
      }),
      pgUrl: t.ownerUrl,
      dryRun: false,
    })
    expect(report.committed).toBe(false)
    expect(report.failure).toEqual(expect.objectContaining({ table: 'agent_audit_log', constraint: 'uq_d', sqlstate: '23505' }))
    expect(JSON.stringify(report)).not.toContain('sentinel-d-value')
    expect(await nonSeedRows(t)).toBe(0)
  })
})

describe('the copy sets its own statement timeout to 0 for its transaction (e)', () => {
  it('a slow target CHECK under a 50 ms database statement timeout: the copy still commits', async () => {
    const t = await freshTarget()
    await t.pool.query(
      "CREATE FUNCTION slow_e(v text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN true; END $$",
    )
    await t.pool.query('ALTER TABLE agent_audit_log ADD CONSTRAINT slow_e CHECK (slow_e(entity))')
    // the owner's sessions pick the database setting up at connect; the copy's own transaction must turn it off
    await t.pool.query(`ALTER DATABASE ${quoteIdentForTest(t.name)} SET statement_timeout = '50ms'`)
    const report = await runCopy({ sqlitePath: buildSqlite(), pgUrl: t.ownerUrl, dryRun: false })
    expect(report.failure).toBeUndefined()
    expect(report.committed).toBe(true)
    const r = await t.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM agent_audit_log')
    expect(Number(r.rows[0]!.n)).toBe(2)
  })
})

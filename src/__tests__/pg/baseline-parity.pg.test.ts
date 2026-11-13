// The PostgreSQL baseline (src/migrations-pg/0001_baseline.sql) against the SQLite migration chain it was cut from.
//
// Runs through `npm run test:pg` / the pg-parity CI job against a throwaway server (MARVEEN_PG_TEST_URL). The
// comparison and its documented exceptions live in helpers/pg-parity.ts; this file holds the verdict, the behaviour
// the CHECKs and triggers were ported for, and the mutants: a test of a parity check is only worth something if a
// baseline that is wrong in a known way makes it fail. Every mutant is a DDL change run inside a transaction that is
// rolled back, on the database cloned from the real baseline; the comparison must then report the difference.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import pg from 'pg'
import { applyMigrations } from '../../db-migrations.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import {
  FLAG_COLUMNS, OMITTED_TRIGGERS, actualFromPg, blankSetDisagreement, diffSchemas, expectedFromSqlite,
  type SchemaModel,
} from '../helpers/pg-parity.js'

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

let db: PgTestDb
let probe: pg.Client
let sqlite: Database.Database
let expected: SchemaModel
let actual: SchemaModel
let problems: string[]

interface Constraint { table: string; name: string; kind: string; def: string }
let constraints: Constraint[]

beforeAll(async () => {
  db = await createPgTestDb()
  probe = new pg.Client({ connectionString: db.url })
  await probe.connect()
  sqlite = new Database(':memory:')
  applyMigrations(sqlite)
  const e = await expectedFromSqlite(sqlite, probe)
  expected = e.model
  problems = e.problems
  actual = await actualFromPg(probe)
  const cr = await probe.query(`
    SELECT c.relname AS "table", con.conname AS name, con.contype AS kind, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f', 'c') ORDER BY 1, 2`)
  constraints = cr.rows as Constraint[]
}, 60000)

afterAll(async () => {
  if (probe) await probe.end()
  if (sqlite) sqlite.close()
  if (db) await db.close()
})

// ── the verdict ─────────────────────────────────────────────────────────────

describe('PG baseline parity with the SQLite chain', () => {
  it('the SQLite side of the comparison is something the model understands', () => {
    expect(problems).toEqual([])
  })

  it('the PostgreSQL baseline equals the SQLite end state, apart from the documented exceptions', () => {
    expect(diffSchemas(expected, actual)).toEqual([])
  })

  it('the comparison is not vacuous: it covers every kind of object it claims to', () => {
    const tables = Object.values(expected.tables)
    expect(tables.length).toBeGreaterThanOrEqual(85)
    expect(tables.reduce((n, t) => n + Object.keys(t.columns).length, 0)).toBeGreaterThanOrEqual(740)
    expect(tables.reduce((n, t) => n + t.checks.length, 0)).toBeGreaterThanOrEqual(65)
    expect(tables.reduce((n, t) => n + t.fks.length, 0)).toBeGreaterThanOrEqual(17)
    expect(tables.reduce((n, t) => n + t.uniques.length, 0)).toBeGreaterThanOrEqual(14)
    expect(Object.keys(expected.indexes).length).toBeGreaterThanOrEqual(117)
    expect(Object.values(expected.indexes).filter((i) => i.where !== null).length).toBeGreaterThanOrEqual(10)
    expect(expected.triggers.length).toBe(5)
    expect(Object.keys(OMITTED_TRIGGERS).length).toBe(13)
    expect(FLAG_COLUMNS.length).toBe(18)
  })

  it('every 0/1 flag column is a smallint with a CHECK, and every other bigint column is not one', () => {
    for (const [name, t] of Object.entries(expected.tables)) {
      for (const [col, c] of Object.entries(t.columns)) {
        expect(c.type === 'smallint', `${name}.${col}`).toBe(FLAG_COLUMNS.includes(`${name}.${col}`))
      }
    }
    for (const f of FLAG_COLUMNS) {
      const [t, c] = f.split('.')
      expect(actual.tables[t].columns[c].type, f).toBe('smallint')
      expect(actual.tables[t].checks.some((d) => d.includes(c) && /ANY \(ARRAY\[0, 1\]\)|ARRAY\[\(?0\)?(::smallint)?, \(?1\)?(::smallint)?\]/.test(d)), `${f} CHECK`).toBe(true)
    }
  })

  it('the memories not-blank CHECK blanks exactly the code points isBlankContent does', async () => {
    expect(await blankSetDisagreement(probe)).toEqual([])
  })
})

// ── behaviour the CHECKs and triggers were ported for ───────────────────────

const ZWSP = String.fromCharCode(0x200b)
const NBSP = String.fromCharCode(0x00a0)
const BOM = String.fromCharCode(0xfeff)
const BLANKS: Record<string, string> = {
  empty: '',
  spaces: '   ',
  'tab and newlines': '\t\r\n \n',
  'no-break space': NBSP,
  'zero width space': ZWSP,
  'zero width run': ZWSP.repeat(5) + String.fromCharCode(0x200d),
  'byte order mark': BOM,
  'mixed whitespace and invisible': ` ${ZWSP}\n${NBSP}${BOM}`,
}

async function sqlstate(c: pg.ClientBase, text: string, values: unknown[] = []): Promise<string | null> {
  await c.query('BEGIN')
  try {
    await c.query(text, values)
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown'
  } finally {
    await c.query('ROLLBACK')
  }
}

const INSERT_MEMORY = "INSERT INTO memories (chat_id, sector, agent_id, category, content, tenant_id, created_at, accessed_at) VALUES ('c', 'semantic', 'agent-a', 'warm', $1, 'default', 1, 1)"

describe('PG twins of the SQLite behaviour', () => {
  it.each(Object.entries(BLANKS))('memories: a blank content (%s) is refused on insert and on update, a visible one is not', async (_name, text) => {
    expect(await sqlstate(probe, INSERT_MEMORY, [text])).toBe('23514')
    await probe.query('BEGIN')
    try {
      await probe.query(INSERT_MEMORY, ['x'])
      expect(await sqlstate2(probe, 'UPDATE memories SET content = $1', [text])).toBe('23514')
      expect(await sqlstate2(probe, 'UPDATE memories SET content = $1', [`${ZWSP}x${NBSP}`])).toBeNull()
    } finally {
      await probe.query('ROLLBACK')
    }
    expect(await sqlstate(probe, INSERT_MEMORY, ['x'])).toBeNull()
  })

  it('flag columns take 0 and 1 and nothing else', async () => {
    const base = "INSERT INTO memories (chat_id, sector, agent_id, category, content, tenant_id, created_at, accessed_at, auto_generated) VALUES ('c', 'semantic', 'agent-a', 'warm', 'x', 'default', 1, 1, $1)"
    expect(await sqlstate(probe, base, [0])).toBeNull()
    expect(await sqlstate(probe, base, [1])).toBeNull()
    expect(await sqlstate(probe, base, [2])).toBe('23514')
    expect(await sqlstate(probe, base, [-1])).toBe('23514')
  })

  it('agent_messages: closing a message as delivered without a timestamp is repaired, as the SQLite trigger does', async () => {
    await probe.query('BEGIN')
    try {
      await probe.query("INSERT INTO agent_messages (from_agent, to_agent, content, created_at) VALUES ('agent-a', 'agent-b', 'm', 1)")
      await probe.query("UPDATE agent_messages SET status = 'delivered'")
      const r = await probe.query('SELECT delivered_at, result FROM agent_messages')
      const row = r.rows[0] as { delivered_at: string; result: string }
      expect(Number(row.delivered_at)).toBeGreaterThan(1_700_000_000)
      expect(row.result).toBe('closed-without-delivery')
      // a delivery that carries its own timestamp and result is left alone
      await probe.query("INSERT INTO agent_messages (from_agent, to_agent, content, created_at) VALUES ('agent-a', 'agent-b', 'n', 1)")
      await probe.query("UPDATE agent_messages SET status = 'delivered', delivered_at = 7, result = 'ok' WHERE content = 'n'")
      const own = await probe.query("SELECT delivered_at, result FROM agent_messages WHERE content = 'n'")
      expect(own.rows[0]).toEqual({ delivered_at: '7', result: 'ok' })
    } finally {
      await probe.query('ROLLBACK')
    }
  })

  it('kanban_cards: a status change bumps updated_at unless the caller moved it, and seq runs in insertion order', async () => {
    await probe.query('BEGIN')
    try {
      await probe.query("INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES ('k1', 't1', 100, 100), ('k2', 't2', 100, 100), ('k3', 't3', 100, 100)")
      await probe.query("UPDATE kanban_cards SET status = 'done' WHERE id = 'k1'")
      await probe.query("UPDATE kanban_cards SET status = 'done', updated_at = 150 WHERE id = 'k2'")
      await probe.query("UPDATE kanban_cards SET title = 't3b' WHERE id = 'k3'")
      const r = await probe.query('SELECT id, seq, updated_at FROM kanban_cards ORDER BY seq')
      const rows = r.rows as { id: string; seq: string; updated_at: string }[]
      expect(rows.map((x) => x.id)).toEqual(['k1', 'k2', 'k3'])
      expect(rows.map((x) => Number(x.seq))).toEqual([1, 2, 3])
      expect(Number(rows[0].updated_at)).toBeGreaterThan(1_700_000_000)
      expect(Number(rows[1].updated_at)).toBe(150)
      expect(Number(rows[2].updated_at)).toBe(100)
      // a seq is never reused, even after a delete
      await probe.query("DELETE FROM kanban_cards WHERE id = 'k3'")
      await probe.query("INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES ('k4', 't4', 1, 1)")
      const s = await probe.query("SELECT seq FROM kanban_cards WHERE id = 'k4'")
      expect(Number((s.rows[0] as { seq: string }).seq)).toBe(4)
    } finally {
      await probe.query('ROLLBACK')
    }
  })

  it('otel_spans: seq is the insertion order (the stand-in for the SQLite rowid), kept by an upsert and never reused', async () => {
    await probe.query('BEGIN')
    try {
      // inserted out of start_ms order on purpose: seq follows the insertion, not the time
      await probe.query("INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms) VALUES ('t1', 's1', 'agent-a', 'tool.x', 300), ('t1', 's2', 'agent-a', 'tool.y', 100), ('t1', 's3', 'agent-a', 'tool.z', 200)")
      await probe.query("INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status) VALUES ('t1', 's1', 'agent-a', 'tool.x', 300, 'ok') ON CONFLICT (trace_id, span_id) DO UPDATE SET status = excluded.status")
      const r = await probe.query('SELECT span_id, seq FROM otel_spans ORDER BY seq')
      const rows = r.rows as { span_id: string; seq: string }[]
      expect(rows.map((x) => x.span_id)).toEqual(['s1', 's2', 's3'])
      expect(rows.map((x) => Number(x.seq))).toEqual([1, 2, 3])
      await probe.query("DELETE FROM otel_spans WHERE span_id = 's3'")
      await probe.query("INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms) VALUES ('t1', 's4', 'agent-a', 'tool.w', 1)")
      const s = await probe.query("SELECT seq FROM otel_spans WHERE span_id = 's4'")
      // later than every earlier row, not "exactly 4": an upsert that hits the conflict has already drawn a number, so
      // the sequence has gaps (only the order matters to the reader)
      expect(Number((s.rows[0] as { seq: string }).seq)).toBeGreaterThan(3)
    } finally {
      await probe.query('ROLLBACK')
    }
  })

  it('artifacts: updated_at is bumped on every update, even one that sets it, as the SQLite trigger does', async () => {
    await probe.query('BEGIN')
    try {
      await probe.query("INSERT INTO artifacts (agent_id, title, kind, content) VALUES ('agent-a', 't', 'text', '\\x00')")
      await probe.query("UPDATE artifacts SET title = 'u', updated_at = 5")
      const r = await probe.query('SELECT updated_at, length(id) AS idlen FROM artifacts')
      const row = r.rows[0] as { updated_at: string; idlen: number }
      expect(Number(row.updated_at)).toBeGreaterThan(1_700_000_000)
      expect(row.idlen).toBe(36)
    } finally {
      await probe.query('ROLLBACK')
    }
  })

  it('homoglyph findings: a Cyrillic look-alike in a card title or a comment is recorded, Latin text is not', async () => {
    await probe.query('BEGIN')
    try {
      await probe.query("INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES ('h1', $1, 1, 1), ('h2', 'plain', 1, 1)", [`p${String.fromCharCode(0x0430)}y`])
      await probe.query("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('h2', 'agent-a', $1, 1), ('h2', 'agent-a', 'plain', 1)", [`${String.fromCharCode(0x043e)}k`])
      const r = await probe.query('SELECT src_table, src_id FROM homoglyph_findings ORDER BY src_table')
      expect((r.rows as { src_table: string; src_id: string }[]).map((x) => x.src_table)).toEqual(['kanban_cards', 'kanban_comments'])
      expect((r.rows[0] as { src_id: string }).src_id).toBe('h1')
    } finally {
      await probe.query('ROLLBACK')
    }
  })

  it('dashboard_users: the username is unique regardless of case, as COLLATE NOCASE made it', async () => {
    await probe.query('BEGIN')
    try {
      const ins = "INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ($1, 'h', 1, 1)"
      await probe.query(ins, ['Agent-A'])
      expect(await sqlstate2(probe, ins, ['agent-a'])).toBe('23505')
      expect(await sqlstate2(probe, ins, ['agent-b'])).toBeNull()
    } finally {
      await probe.query('ROLLBACK')
    }
  })
})

/** Like sqlstate, but inside the caller's transaction: a savepoint keeps one failed statement from aborting it. */
async function sqlstate2(c: pg.ClientBase, text: string, values: unknown[] = []): Promise<string | null> {
  await c.query('SAVEPOINT s2')
  try {
    await c.query(text, values)
    await c.query('RELEASE SAVEPOINT s2')
    return null
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT s2')
    return (err as { code?: string }).code ?? 'unknown'
  }
}

// ── mutants: a baseline that is wrong in a known way must fail the comparison ─

interface Mutant { label: string; ddl: string[]; expect?: RegExp }
const tally = { ran: 0, refused: 0 }

/** Applies the DDL in a transaction, compares, rolls back. applied=false when PostgreSQL itself refuses the change. */
async function mutate(c: pg.ClientBase, ddl: string[]): Promise<{ applied: boolean; diff: string[] }> {
  await c.query('BEGIN')
  try {
    // The baseline now carries seed rows. PostgreSQL checks a new NOT NULL / CHECK against the rows already there and refuses
    // the ones the seed violates, which would turn those mutants into "refused" instead of judged. The mutants are about the
    // schema, so they run on empty tables as before the seed existed (the seed has its own test: seed-parity.pg.test.ts).
    await c.query('DELETE FROM egress_allowlist; DELETE FROM autonomy_categories; DELETE FROM model_profile_map; DELETE FROM system_config; DELETE FROM otel_metrics_export_state; DELETE FROM tenants')
    try {
      for (const s of ddl) await c.query(s)
    } catch {
      return { applied: false, diff: [] }
    }
    return { applied: true, diff: diffSchemas(expected, await actualFromPg(c)) }
  } finally {
    await c.query('ROLLBACK')
  }
}

/** Runs every mutant; returns the ones that were not detected (or detected with the wrong message) and the ones PostgreSQL refused. */
async function runMutants(c: pg.ClientBase, mutants: Mutant[]): Promise<{ survivors: string[]; refused: string[]; ran: number }> {
  const survivors: string[] = []
  const refused: string[] = []
  tally.ran += mutants.length
  for (const m of mutants) {
    const r = await mutate(c, m.ddl)
    if (!r.applied) { refused.push(m.label); tally.refused++; continue }
    if (r.diff.length === 0) survivors.push(`${m.label} (not detected)`)
    else if (m.expect && !r.diff.some((d) => m.expect!.test(d))) survivors.push(`${m.label} (detected as: ${r.diff[0]})`)
  }
  return { survivors, refused, ran: mutants.length }
}

const find = (table: string, kind: string, re: RegExp): Constraint => {
  const c = constraints.find((x) => x.table === table && x.kind === kind && re.test(x.def))
  if (!c) throw new Error(`no ${kind} constraint on ${table} matching ${re}`)
  return c
}
const dropAdd = (c: Constraint, body: string): string[] => [`ALTER TABLE ${q(c.table)} DROP CONSTRAINT ${q(c.name)}`, `ALTER TABLE ${q(c.table)} ADD CONSTRAINT ${q(c.name)} CHECK ${body}`]
const arrayElements = (def: string): string[] | null => {
  const m = /ARRAY\[(.*?)\]/s.exec(def)
  return m ? m[1].split(', ') : null
}
const withElements = (def: string, els: string[]): string => def.replace(/^CHECK /, '').replace(/ARRAY\[(.*?)\]/s, `ARRAY[${els.join(', ')}]`)

describe('PG baseline parity: the comparison catches the known mistakes (mandatory mutants)', () => {
  it('skill_revisions.author_kind CHECK without the value operator fails', async () => {
    const c = find('skill_revisions', 'c', /author_kind/)
    expect(arrayElements(c.def)).toContain("'operator'::text")
    const els = arrayElements(c.def)!.filter((e) => !e.includes("'operator'"))
    const r = await mutate(probe, dropAdd(c, withElements(c.def, els)))
    expect(r.applied).toBe(true)
    expect(r.diff.some((d) => d.startsWith('CHECK of skill_revisions') && d.includes('operator'))).toBe(true)
  })

  it('skill_revisions.action CHECK list: dropping any one value fails (the 0091 list and the 0092 additions)', async () => {
    const c = find('skill_revisions', 'c', /action/)
    const els = arrayElements(c.def)!
    expect(els.length).toBe(12)
    const mutants: Mutant[] = els.map((e) => ({
      label: `action without ${e}`,
      ddl: dropAdd(c, withElements(c.def, els.filter((x) => x !== e))),
      expect: new RegExp(`CHECK of skill_revisions.*${e.replace(/'::text$/, '')}`),
    }))
    mutants.push({ label: 'action with an extra value', ddl: dropAdd(c, withElements(c.def, [...els, "'zzz'::text"])), expect: /CHECK of skill_revisions/ })
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused).toEqual([])
  })

  it('skill_revisions UNIQUE (skill_id, seq) dropped fails', async () => {
    const c = find('skill_revisions', 'u', /skill_id, seq/)
    const r = await mutate(probe, [`ALTER TABLE skill_revisions DROP CONSTRAINT ${q(c.name)}`])
    expect(r.applied).toBe(true)
    expect(r.diff).toContain('UNIQUE of skill_revisions: missing in PG: skill_id,seq')
  })

  it('idx_skill_revisions_pending dropped, with its columns swapped, or made unique fails', async () => {
    expect(actual.indexes.idx_skill_revisions_pending.keys).toEqual(['status', 'skill_id'])
    for (const ddl of [
      ['DROP INDEX idx_skill_revisions_pending'],
      ['DROP INDEX idx_skill_revisions_pending', 'CREATE INDEX idx_skill_revisions_pending ON skill_revisions (skill_id, status)'],
      ['DROP INDEX idx_skill_revisions_pending', 'CREATE UNIQUE INDEX idx_skill_revisions_pending ON skill_revisions (status, skill_id)'],
      ['DROP INDEX idx_skill_revisions_pending', "CREATE INDEX idx_skill_revisions_pending ON skill_revisions (status, skill_id) WHERE status = 'pending'"],
    ]) {
      const r = await mutate(probe, ddl)
      expect(r.applied, ddl.join('; ')).toBe(true)
      expect(r.diff.some((d) => d.includes('idx_skill_revisions_pending')), ddl.join('; ')).toBe(true)
    }
  })

  it('skill_revisions.prev_state_sha256 missing fails', async () => {
    const r = await mutate(probe, ['ALTER TABLE skill_revisions DROP COLUMN prev_state_sha256'])
    expect(r.applied).toBe(true)
    expect(r.diff).toContain('columns of skill_revisions: missing in PG: prev_state_sha256')
  })

  it('memories not-blank CHECK: a character list that drifts from isBlankContent fails the code-point sweep', async () => {
    const c = find('memories', 'c', /btrim\(content,/)
    const set = /btrim\(content, '([^']*)'::text\)/s.exec(c.def)![1]
    const chars = [...set]
    const without = (ch: string): string => chars.filter((x) => x !== ch).join('')
    const body = (s: string): string => `(btrim(content, '${s.replace(/'/g, "''")}') <> '')`
    const cases: { label: string; set: string; differs: number }[] = [
      { label: 'zero width space missing', set: without(ZWSP), differs: 0x200b },
      { label: 'soft hyphen missing', set: without(String.fromCharCode(0x00ad)), differs: 0x00ad },
      { label: 'byte order mark missing', set: without(BOM), differs: 0xfeff },
      { label: 'tab missing', set: without('\t'), differs: 0x09 },
      { label: 'a visible letter added', set: set + 'x', differs: 'x'.charCodeAt(0) },
      { label: 'braille blank added', set: set + String.fromCharCode(0x2800), differs: 0x2800 },
    ]
    expect(await blankSetDisagreement(probe)).toEqual([])
    for (const m of cases) {
      await probe.query('BEGIN')
      try {
        for (const s of dropAdd(c, body(m.set))) await probe.query(s)
        const d = await blankSetDisagreement(probe)
        expect(d, m.label).toEqual([m.differs])
        // the structural comparison alone does not see a changed character list: the sweep is what holds it
        expect(diffSchemas(expected, await actualFromPg(probe)), m.label).toEqual([])
      } finally {
        await probe.query('ROLLBACK')
      }
    }
  })
})

describe('PG baseline parity: every object of the baseline is held (systematic mutants)', () => {
  const MAX_REFUSED = 12

  it('a table renamed away fails', async () => {
    const mutants: Mutant[] = Object.keys(expected.tables).map((t) => ({
      label: `rename ${t}`, ddl: [`ALTER TABLE ${q(t)} RENAME TO ${q(`${t}_mut`)}`], expect: new RegExp(`^tables: missing in PG: ${t}$`),
    }))
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused).toEqual([])
  }, 120000)

  it('an extra table, an extra column, an extra index and an extra trigger fail', async () => {
    const mutants: Mutant[] = [{ label: 'extra table', ddl: ['CREATE TABLE zz_extra (id bigint)'], expect: /^tables: only in PG: zz_extra$/ }]
    for (const [t, tm] of Object.entries(expected.tables)) {
      mutants.push({ label: `extra column on ${t}`, ddl: [`ALTER TABLE ${q(t)} ADD COLUMN zz_extra text`], expect: new RegExp(`^columns of ${t}: only in PG: zz_extra$`) })
      mutants.push({ label: `extra index on ${t}`, ddl: [`CREATE INDEX zz_extra_ix ON ${q(t)} (${q(Object.keys(tm.columns)[0])})`], expect: /^indexes: only in PG: zz_extra_ix$/ })
    }
    mutants.push({ label: 'extra trigger', ddl: ['CREATE TRIGGER zz_extra AFTER INSERT ON memories FOR EACH ROW EXECUTE FUNCTION marveen_artifacts_updated_at()'], expect: /^triggers: only in PG: zz_extra@memories$/ })
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused).toEqual([])
  }, 120000)

  it('a column dropped fails', async () => {
    const mutants: Mutant[] = []
    for (const [t, tm] of Object.entries(expected.tables)) {
      for (const col of Object.keys(tm.columns)) {
        mutants.push({ label: `drop ${t}.${col}`, ddl: [`ALTER TABLE ${q(t)} DROP COLUMN ${q(col)} CASCADE`], expect: new RegExp(`^columns of ${t}: missing in PG: ${col}$`) })
      }
    }
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused).toEqual([])
    expect(r.ran).toBeGreaterThanOrEqual(740)
  }, 300000)

  it('a column of another type fails', async () => {
    const alt: Record<string, string> = { text: 'varchar(255)', bigint: 'integer', smallint: 'integer', 'double precision': 'real', bytea: 'text' }
    const mutants: Mutant[] = []
    for (const [t, tm] of Object.entries(expected.tables)) {
      for (const [col, c] of Object.entries(tm.columns)) {
        const using = c.type === 'bytea' ? ` USING encode(${q(col)}, 'hex')` : ''
        mutants.push({ label: `${t}.${col} as ${alt[c.type]}`, ddl: [`ALTER TABLE ${q(t)} ALTER COLUMN ${q(col)} TYPE ${alt[c.type]}${using}`], expect: new RegExp(`^column ${t}\\.${col}: type`) })
      }
    }
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    // PostgreSQL refuses a type change on a column a trigger definition names (UPDATE OF col): those cannot be mutated this way
    expect(r.refused.length, r.refused.join(', ')).toBeLessThanOrEqual(MAX_REFUSED)
  }, 300000)

  it('a changed NOT NULL, default or identity fails', async () => {
    const mutants: Mutant[] = []
    for (const [t, tm] of Object.entries(expected.tables)) {
      for (const [col, c] of Object.entries(tm.columns)) {
        const isPk = tm.pk.includes(col)
        if (c.notNull && !isPk && !c.identity) mutants.push({ label: `${t}.${col} nullable`, ddl: [`ALTER TABLE ${q(t)} ALTER COLUMN ${q(col)} DROP NOT NULL`], expect: new RegExp(`^column ${t}\\.${col}: NOT NULL`) })
        if (!c.notNull) mutants.push({ label: `${t}.${col} not null`, ddl: [`ALTER TABLE ${q(t)} ALTER COLUMN ${q(col)} SET NOT NULL`], expect: new RegExp(`^column ${t}\\.${col}: NOT NULL`) })
        if (c.default !== null) mutants.push({ label: `${t}.${col} without default`, ddl: [`ALTER TABLE ${q(t)} ALTER COLUMN ${q(col)} DROP DEFAULT`], expect: new RegExp(`^column ${t}\\.${col}: default`) })
        else if (!c.identity) {
          const lit = c.type === 'text' ? "''" : c.type === 'bytea' ? "'\\x00'" : '7'
          mutants.push({ label: `${t}.${col} with a default`, ddl: [`ALTER TABLE ${q(t)} ALTER COLUMN ${q(col)} SET DEFAULT ${lit}`], expect: new RegExp(`^column ${t}\\.${col}: default`) })
        }
        if (c.identity) mutants.push({ label: `${t}.${col} not identity`, ddl: [`ALTER TABLE ${q(t)} ALTER COLUMN ${q(col)} DROP IDENTITY`], expect: new RegExp(`^column ${t}\\.${col}: identity`) })
      }
    }
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused, r.refused.join(', ')).toEqual([])
  }, 300000)

  it('a dropped primary key, UNIQUE constraint, foreign key or CHECK fails', async () => {
    const mutants: Mutant[] = constraints.map((c) => ({
      label: `drop ${c.kind} ${c.table}.${c.name}`,
      ddl: [`ALTER TABLE ${q(c.table)} DROP CONSTRAINT ${q(c.name)} CASCADE`],
      expect: new RegExp(c.kind === 'p' ? `^primary key of ${c.table}` : c.kind === 'u' ? `^UNIQUE of ${c.table}` : c.kind === 'f' ? `^FOREIGN KEY of ${c.table}` : `^CHECK of ${c.table}`),
    }))
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused).toEqual([])
    expect(r.ran).toBeGreaterThanOrEqual(85 + 14 + 17 + 65)
  }, 300000)

  it('a CHECK with a value dropped, a value added or a number moved fails', async () => {
    const mutants: Mutant[] = []
    for (const c of constraints.filter((x) => x.kind === 'c')) {
      const els = arrayElements(c.def)
      const re = new RegExp(`^CHECK of ${c.table}`)
      if (els) {
        for (const e of els) mutants.push({ label: `${c.table}.${c.name} without ${e}`, ddl: dropAdd(c, withElements(c.def, els.filter((x) => x !== e))), expect: re })
        mutants.push({ label: `${c.table}.${c.name} with an extra value`, ddl: dropAdd(c, withElements(c.def, [...els, els[0].startsWith("'") ? "'zzz'::text" : '9'])), expect: re })
      }
      const body = c.def.replace(/^CHECK /, '')
      const numbers = [...body.matchAll(/(?<![\w'.])(\d+)(?![\w'])/g)].filter((m) => !els || !/ARRAY\[[^\]]*$/.test(body.slice(0, m.index)))
      for (const m of numbers) {
        const moved = body.slice(0, m.index) + String(Number(m[1]) + 1) + body.slice((m.index ?? 0) + m[1].length)
        mutants.push({ label: `${c.table}.${c.name} number ${m[1]} moved`, ddl: dropAdd(c, moved), expect: re })
      }
    }
    expect(mutants.length).toBeGreaterThan(150)
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused, r.refused.join(', ')).toEqual([])
  }, 300000)

  it('an index dropped, made unique or not, reversed in its first key, or without its predicate fails', async () => {
    const mutants: Mutant[] = []
    for (const [name, ix] of Object.entries(actual.indexes)) {
      const re = new RegExp(`^(indexes: missing in PG: ${name}|index ${name}:)`)
      const quoteKey = (k: string): string => (k.includes('(') ? k : k.replace(/^([a-z_][a-z0-9_]*)/, '"$1"'))
      const cols = (keys: string[]): string => keys.map(quoteKey).join(', ')
      const where = ix.where ? ` WHERE ${ix.where}` : ''
      const flip = (k: string): string => (k.endsWith(' DESC') ? k.slice(0, -5) : `${k} DESC`)
      mutants.push({ label: `drop ${name}`, ddl: [`DROP INDEX ${q(name)}`], expect: new RegExp(`^indexes: missing in PG: ${name}$`) })
      mutants.push({ label: `${name} unique toggled`, ddl: [`DROP INDEX ${q(name)}`, `CREATE ${ix.unique ? '' : 'UNIQUE '}INDEX ${q(name)} ON ${q(ix.table)} (${cols(ix.keys)})${where}`], expect: re })
      mutants.push({ label: `${name} first key flipped`, ddl: [`DROP INDEX ${q(name)}`, `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(ix.table)} (${cols([flip(ix.keys[0]), ...ix.keys.slice(1)])})${where}`], expect: re })
      if (ix.where) mutants.push({ label: `${name} without predicate`, ddl: [`DROP INDEX ${q(name)}`, `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(ix.table)} (${cols(ix.keys)})`], expect: re })
      if (ix.keys.length > 1) mutants.push({ label: `${name} keys reversed`, ddl: [`DROP INDEX ${q(name)}`, `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(ix.table)} (${cols([...ix.keys].reverse())})${where}`], expect: re })
    }
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused, r.refused.join(', ')).toEqual([])
  }, 300000)

  it('a trigger dropped fails, and so does a PG-only index that stops being on lower(username)', async () => {
    const mutants: Mutant[] = expected.triggers.map((t) => {
      const [name, table] = t.split('@')
      return { label: `drop trigger ${name}`, ddl: [`DROP TRIGGER ${q(name)} ON ${q(table)}`], expect: new RegExp(`^triggers: missing in PG: ${name}@${table}$`) }
    })
    mutants.push({ label: 'username index on the plain column', ddl: ['DROP INDEX dashboard_users_username_key', 'CREATE UNIQUE INDEX dashboard_users_username_key ON dashboard_users (username)'], expect: /^index dashboard_users_username_key: keys/ })
    mutants.push({ label: 'username index dropped', ddl: ['DROP INDEX dashboard_users_username_key'], expect: /^indexes: missing in PG: dashboard_users_username_key$/ })
    mutants.push({ label: 'kanban seq not unique', ddl: ['ALTER TABLE kanban_cards DROP CONSTRAINT kanban_cards_seq_key'], expect: /^UNIQUE of kanban_cards/ })
    const r = await runMutants(probe, mutants)
    expect(r.survivors).toEqual([])
    expect(r.refused).toEqual([])
  }, 120000)
})

describe('PG baseline parity: the mutant run itself', () => {
  it('ran a few thousand mutants, and PostgreSQL refused only a handful (a type change on a column a trigger names)', () => {
    expect(tally.ran).toBeGreaterThan(2500)
    expect(tally.refused).toBeLessThanOrEqual(12)
  })
})

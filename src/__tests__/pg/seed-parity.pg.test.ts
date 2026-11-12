// The seed rows and the unixepoch() function of the PostgreSQL baseline (src/migrations-pg/0001_baseline.sql).
//
// The SQLite migration chain inserts rows into six tables; a fresh PostgreSQL install built from the baseline must hold the
// same rows. The block that does it is generated (scripts/generate-pg-baseline-seed.ts); this file is the independent check:
// it reads the rows out of an empty SQLite end state itself and compares, per table, the row count and a content hash,
// keyed by the unique key and not by insertion order. A parity check is only worth something if a baseline that is wrong
// in a known way fails it, so every mutant below changes the data (inside a rolled-back transaction) or the baseline file
// text (on a scratch template) and must make the comparison report exactly that difference.
//
// Runs through `npm run test:pg` / the pg-parity CI job against a throwaway server (MARVEEN_PG_TEST_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import pg from 'pg'
import { applyMigrations } from '../../db-migrations.js'
import { createPgTestDb, dropPgTemplate, type PgTestDb } from '../helpers/pg-test-db.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PG_MIGRATIONS = path.join(ROOT, 'src', 'migrations-pg')
const BASELINE_FILE = path.join(PG_MIGRATIONS, '0001_baseline.sql')
const BEGIN_MARK = '-- BEGIN GENERATED SEED'
const END_MARK = '-- END GENERATED SEED'

// The unique key of each seed table. Rows are matched by it, never by position or identity value.
const KEY: Record<string, string[]> = {
  tenants: ['id'],
  system_config: ['key'],
  autonomy_categories: ['key'],
  model_profile_map: ['profile_id'],
  egress_allowlist: ['value', 'type', 'tenant_id'],
  otel_metrics_export_state: ['id'],
}
// Columns that are not compared: the ones the SQLite default fills with the time of the migration run (it differs between
// two runs, so it cannot be seed content), found by their default; and the one identity column the seed leaves to the
// server (egress_allowlist.id: assigned in insertion order).
const IDENTITY_NOT_SEEDED = new Set(['egress_allowlist.id'])
// Tables that hold rows after the chain without being seed data.
const NOT_SEED = new Set(['schema_version'])

interface TableSeed { cols: string[]; rows: Map<string, string> }
type Seeds = Record<string, TableSeed>

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`
const canon = (values: unknown[]): string => JSON.stringify(values.map((v) => (v === null || v === undefined ? null : String(v))))

function sqliteSeeds(sdb: Database.Database): Seeds {
  const tables = (sdb.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT LIKE '%\\_fts%' ESCAPE '\\' AND name NOT LIKE 'vec\\_%' ESCAPE '\\' ORDER BY name`,
  ).all() as { name: string }[]).map((r) => r.name).filter((t) => !NOT_SEED.has(t))
  const out: Seeds = {}
  for (const t of tables) {
    const info = sdb.prepare(`SELECT name, dflt_value FROM pragma_table_info('${t}') ORDER BY cid`).all() as { name: string; dflt_value: string | null }[]
    const cols = info.filter((c) => c.dflt_value !== 'unixepoch()' && !IDENTITY_NOT_SEEDED.has(`${t}.${c.name}`)).map((c) => c.name)
    const rows = sdb.prepare(`SELECT ${cols.map(q).join(', ')} FROM ${q(t)}`).all() as Record<string, unknown>[]
    if (rows.length === 0) continue
    out[t] = { cols, rows: rowMap(t, cols, rows.map((r) => cols.map((c) => r[c]))) }
  }
  return out
}

function rowMap(table: string, cols: string[], rows: unknown[][]): Map<string, string> {
  const keyCols = KEY[table] ?? cols
  const idx = keyCols.map((k) => cols.indexOf(k))
  const m = new Map<string, string>()
  for (const r of rows) {
    const key = canon(idx.map((i) => r[i]))
    if (m.has(key)) throw new Error(`${table}: duplicate key ${key}`)
    m.set(key, canon(r))
  }
  return m
}

/** The rows of every table that holds any (compared columns of the expected side where it has the table), as text. */
async function pgSeeds(c: pg.ClientBase, expected: Seeds): Promise<Seeds> {
  const tables = (await c.query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
  )).rows.map((r: { t: string }) => r.t).filter((t: string) => !NOT_SEED.has(t))
  const out: Seeds = {}
  for (const t of tables) {
    const n = Number((await c.query(`SELECT count(*) AS n FROM ${q(t)}`)).rows[0].n)
    if (n === 0) continue
    // a table SQLite leaves empty has no column list to compare on: take all of them, the table-level difference is what is reported
    const cols = expected[t]?.cols ?? (await c.query(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [t],
    )).rows.map((r: { c: string }) => r.c)
    const res = await c.query({ text: `SELECT ${cols.map((x) => `${q(x)}::text AS ${q(x)}`).join(', ')} FROM ${q(t)}`, rowMode: 'array' })
    out[t] = { cols, rows: rowMap(t, cols, res.rows as unknown[][]) }
  }
  return out
}

/** Per table: the row count and one hash over the rows sorted by key (the order of the rows in either database is irrelevant). */
function summarize(s: Seeds): Record<string, { count: number; hash: string }> {
  const out: Record<string, { count: number; hash: string }> = {}
  for (const [t, ts] of Object.entries(s)) {
    const h = createHash('sha256')
    for (const key of [...ts.rows.keys()].sort()) h.update(key).update('\0').update(ts.rows.get(key)!).update('\n')
    out[t] = { count: ts.rows.size, hash: h.digest('hex') }
  }
  return out
}

function diffSeeds(expected: Seeds, actual: Seeds): string[] {
  const out: string[] = []
  for (const t of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const e = expected[t]
    const a = actual[t]
    if (!e) { out.push(`${t}: ${a.rows.size} row(s) in PostgreSQL, none in the SQLite chain`); continue }
    if (!a) { out.push(`${t}: ${e.rows.size} row(s) in the SQLite chain, none in PostgreSQL`); continue }
    if (e.rows.size !== a.rows.size) out.push(`${t}: ${e.rows.size} row(s) in the SQLite chain, ${a.rows.size} in PostgreSQL`)
    for (const [key, row] of e.rows) {
      if (!a.rows.has(key)) out.push(`${t}: key ${key} missing in PostgreSQL`)
      else if (a.rows.get(key) !== row) out.push(`${t}: key ${key} differs: expected ${row}, got ${a.rows.get(key)}`)
    }
    for (const key of a.rows.keys()) if (!e.rows.has(key)) out.push(`${t}: key ${key} only in PostgreSQL`)
  }
  return out
}

const sameSummary = (e: Seeds, a: Seeds): boolean => JSON.stringify(summarize(e)) === JSON.stringify(summarize(a))

/** What the unixepoch() function has to be, as a list of broken promises (empty = fine). The caller provides the transaction. */
async function unixepochProblems(c: pg.ClientBase): Promise<string[]> {
  const out: string[] = []
  const meta = (await c.query(
    `SELECT p.provolatile AS vol, p.pronargs AS nargs, pg_get_function_result(p.oid) AS ret, l.lanname AS lang
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.proname = 'unixepoch' AND p.pronamespace = current_schema()::regnamespace`,
  )).rows
  if (meta.length !== 1) return [`expected exactly one unixepoch() in the schema, found ${meta.length}`]
  const m = meta[0]
  if (m.nargs !== 0) out.push(`takes ${m.nargs} argument(s)`)
  if (m.ret !== 'bigint') out.push(`returns ${m.ret}, not bigint`)
  if (m.vol !== 's') out.push(`volatility is ${m.vol}, not STABLE (s)`)
  if (m.lang !== 'sql') out.push(`language is ${m.lang}, not sql`)
  // STABLE like now(): the value does not move inside one transaction, like SQLite's inside one statement
  const first = (await c.query('SELECT unixepoch()::text AS u')).rows[0].u
  await c.query('SELECT pg_sleep(1.1)')
  const second = (await c.query('SELECT unixepoch()::text AS u, extract(epoch from now())::bigint::text AS n')).rows[0]
  if (first !== second.u) out.push(`moved inside a transaction: ${first} then ${second.u}`)
  if (second.u !== second.n) out.push(`${second.u} is not extract(epoch from now())::bigint = ${second.n}`)
  return out
}

let db: PgTestDb
let probe: pg.Client
let expected: Seeds
let baselineText: string

beforeAll(async () => {
  const sqlite = new Database(':memory:')
  applyMigrations(sqlite)
  expected = sqliteSeeds(sqlite)
  sqlite.close()
  baselineText = readFileSync(BASELINE_FILE, 'utf8')
  db = await createPgTestDb()
  probe = new pg.Client({ connectionString: db.url })
  await probe.connect()
})

afterAll(async () => {
  await probe?.end()
  await db?.close()
})

/** Runs `fn` inside a transaction that is rolled back whatever happens. */
async function rolledBack<T>(c: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN')
  try {
    return await fn()
  } finally {
    await c.query('ROLLBACK')
  }
}

// ── the verdict ─────────────────────────────────────────────────────────────

describe('seed parity: the baseline seeds what the SQLite migration chain seeds', () => {
  it('every seeded table has the same rows (count and content hash, by key) in PostgreSQL', async () => {
    const actual = await pgSeeds(probe, expected)
    expect(diffSeeds(expected, actual)).toEqual([])
    expect(sameSummary(expected, actual)).toBe(true)
  })

  it('the comparison is not vacuous: the six seeded tables, with the counts the chain produces', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(KEY).sort())
    const counts = Object.fromEntries(Object.entries(expected).map(([t, s]) => [t, s.rows.size]))
    expect(counts.tenants).toBe(1)
    expect(counts.system_config).toBe(1)
    expect(counts.autonomy_categories).toBe(15)
    expect(counts.model_profile_map).toBe(4)
    expect(counts.egress_allowlist).toBeGreaterThanOrEqual(206)
    expect(counts.otel_metrics_export_state).toBe(1)
    // the compared columns do not include the migration-run timestamps, and do include the content
    expect(expected.tenants.cols).toEqual(['id', 'display_name', 'disabled_at', 'main_agent_id'])
    expect(expected.egress_allowlist.cols).toEqual(['value', 'type', 'added_by', 'tenant_id'])
    expect(expected.autonomy_categories.cols).toContain('label')
    expect(expected.model_profile_map.cols).toContain('model_id')
  })

  it('the baseline holds no seed row for a table the SQLite chain leaves empty', async () => {
    const actual = await pgSeeds(probe, expected)
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  })

  it('the generated block in the baseline is what the generator produces from the chain now (not stale)', () => {
    // exit code 1 (stale) throws here; the generator prints which command refreshes it
    const out = execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'generate-pg-baseline-seed.ts'), '--check'], { cwd: ROOT, encoding: 'utf8' })
    expect(out).toContain('up to date')
  })
})

// ── behaviour the seed has to have ──────────────────────────────────────────

describe('seed behaviour', () => {
  const block = (): string => baselineText.slice(baselineText.indexOf(BEGIN_MARK), baselineText.indexOf(END_MARK))

  it('the block can run again: it neither fails nor duplicates, and it does not overwrite a row someone changed', async () => {
    await rolledBack(probe, async () => {
      await probe.query(`UPDATE tenants SET display_name = 'renamed' WHERE id = 'default'`)
      await probe.query(`DELETE FROM egress_allowlist WHERE id = (SELECT min(id) FROM egress_allowlist)`)
      await probe.query(block())
      await probe.query(block())
      const r = await probe.query(`SELECT display_name FROM tenants WHERE id = 'default'`)
      expect(r.rows[0].display_name).toBe('renamed')
      // the deleted allowlist row came back once, and nothing else was duplicated
      const diff = diffSeeds(expected, await pgSeeds(probe, expected))
      expect(diff.filter((d) => !d.startsWith('tenants:'))).toEqual([])
      expect(diff.filter((d) => d.startsWith('tenants:'))).toHaveLength(1) // the one change made on purpose, still there
    })
  })

  it('the egress allowlist identity is past the seeded rows: a new row does not collide with a seeded id', async () => {
    await rolledBack(probe, async () => {
      const r = await probe.query(`INSERT INTO egress_allowlist (value, type) VALUES ('example.invalid', 'domain') RETURNING id::int AS id`)
      expect(r.rows[0].id).toBeGreaterThan(expected.egress_allowlist.rows.size)
      const n = await probe.query(`SELECT count(DISTINCT id)::int AS d, count(*)::int AS n FROM egress_allowlist`)
      expect(n.rows[0].d).toBe(n.rows[0].n)
    })
  })

  it('the migration-run timestamp columns are filled by the server default, not NULL', async () => {
    const r = await probe.query(`
      SELECT (SELECT count(*) FROM tenants WHERE created_at IS NULL)::int AS a,
             (SELECT count(*) FROM egress_allowlist WHERE added_at IS NULL)::int AS b,
             (SELECT count(*) FROM autonomy_categories WHERE updated_at IS NULL)::int AS c,
             (SELECT count(*) FROM model_profile_map WHERE updated_at IS NULL)::int AS d,
             (SELECT count(*) FROM system_config WHERE updated_at IS NULL)::int AS e`)
    expect(r.rows[0]).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0 })
  })
})

// ── mutants: a baseline that is wrong in a known way must fail the comparison ─

const MUTANT_ROW: Record<string, { del: string; set: string; setWhat: string }> = {
  tenants: { del: `id = 'default'`, set: `UPDATE tenants SET display_name = 'x' WHERE id = 'default'`, setWhat: 'display_name' },
  system_config: { del: `key = 'schedule_last_tick_ms'`, set: `UPDATE system_config SET value = '1' WHERE key = 'schedule_last_tick_ms'`, setWhat: 'value' },
  autonomy_categories: { del: `key = 'payment'`, set: `UPDATE autonomy_categories SET level = 2, max_level = 3 WHERE key = 'payment'`, setWhat: 'level' },
  model_profile_map: { del: `profile_id = 'build_strong'`, set: `UPDATE model_profile_map SET model_id = 'other-model' WHERE profile_id = 'build_strong'`, setWhat: 'model_id' },
  egress_allowlist: { del: `id = (SELECT min(id) FROM egress_allowlist)`, set: `UPDATE egress_allowlist SET added_by = 'someone' WHERE id = (SELECT min(id) FROM egress_allowlist)`, setWhat: 'added_by' },
  otel_metrics_export_state: { del: `id = 1`, set: `UPDATE otel_metrics_export_state SET last_export_ms = 5 WHERE id = 1`, setWhat: 'last_export_ms' },
}

describe('mutants (data): the comparison reports a seed that is wrong in a known way', () => {
  for (const [table, m] of Object.entries(MUTANT_ROW)) {
    it(`${table}: a deleted row is reported`, async () => {
      await rolledBack(probe, async () => {
        await probe.query(`DELETE FROM ${table} WHERE ${m.del}`)
        const actual = await pgSeeds(probe, expected)
        const problems = diffSeeds(expected, actual)
        expect(problems.length).toBeGreaterThan(0)
        expect(problems.every((p) => p.startsWith(`${table}:`)), problems.join('\n')).toBe(true)
        expect(problems.some((p) => /row\(s\)|missing/.test(p))).toBe(true)
        expect(sameSummary(expected, actual)).toBe(false)
      })
    })

    it(`${table}: a changed value (${m.setWhat}) is reported as a difference, the count unchanged`, async () => {
      await rolledBack(probe, async () => {
        const r = await probe.query(m.set)
        expect(r.rowCount).toBe(1)
        const actual = await pgSeeds(probe, expected)
        const problems = diffSeeds(expected, actual)
        expect(problems.length).toBe(1)
        expect(problems[0]).toMatch(new RegExp(`^${table}: key .* differs`))
        expect(actual[table].rows.size).toBe(expected[table].rows.size)
        expect(sameSummary(expected, actual)).toBe(false)
      })
    })
  }

  it('an extra row in a seed table is reported', async () => {
    await rolledBack(probe, async () => {
      await probe.query(`INSERT INTO egress_allowlist (value, type) VALUES ('extra.invalid', 'domain')`)
      const problems = diffSeeds(expected, await pgSeeds(probe, expected))
      expect(problems.some((p) => p.startsWith('egress_allowlist:') && /only in PostgreSQL/.test(p))).toBe(true)
    })
  })

  it('a seed row in a table the SQLite chain leaves empty is reported', async () => {
    await rolledBack(probe, async () => {
      await probe.query(`INSERT INTO agent_blackboard_tier (agent_id) VALUES ('agent-a')`)
      expect(diffSeeds(expected, await pgSeeds(probe, expected))).toEqual(['agent_blackboard_tier: 1 row(s) in PostgreSQL, none in the SQLite chain'])
    })
  })

  it('a key column that differs (type of an allowlist row) shows as a missing and an extra row, not as a silent match', async () => {
    await rolledBack(probe, async () => {
      await probe.query(`UPDATE egress_allowlist SET type = 'prefix' WHERE id = (SELECT min(id) FROM egress_allowlist)`)
      const problems = diffSeeds(expected, await pgSeeds(probe, expected))
      expect(problems.some((p) => /missing in PostgreSQL/.test(p))).toBe(true)
      expect(problems.some((p) => /only in PostgreSQL/.test(p))).toBe(true)
    })
  })
})

describe('mutants (baseline file): a baseline text that loses or alters a seed row fails on a database built from it', () => {
  let dir: string | null = null
  let built: PgTestDb | null = null
  let builtProbe: pg.Client | null = null

  async function buildFrom(mutated: string): Promise<pg.Client> {
    dir = mkdtempSync(path.join(tmpdir(), 'marveen-seed-mutant-'))
    for (const f of ['0001_baseline.sql', '0002_schedules_author.sql']) copyFileSync(path.join(PG_MIGRATIONS, f), path.join(dir, f))
    writeFileSync(path.join(dir, '0001_baseline.sql'), mutated)
    built = await createPgTestDb({ migrationsDir: dir })
    builtProbe = new pg.Client({ connectionString: built.url })
    await builtProbe.connect()
    return builtProbe
  }

  /** Ends the mutant's connection, drops its database and its template, removes the scratch directory. Safe to call twice. */
  async function tearDown(): Promise<void> {
    const [b, p, d] = [built, builtProbe, dir]
    built = null; builtProbe = null; dir = null
    await p?.end().catch(() => undefined)
    await b?.close().catch(() => undefined)
    if (b) await dropPgTemplate(b.template).catch(() => undefined)
    if (d) rmSync(d, { recursive: true, force: true })
  }

  afterAll(tearDown)

  /** Runs one file-text mutant and tears its database down, so the next one starts clean. */
  async function runMutant(mutate: (text: string) => string): Promise<string[]> {
    const mutated = mutate(baselineText)
    expect(mutated).not.toBe(baselineText) // the mutation really hit something
    const c = await buildFrom(mutated)
    try {
      return diffSeeds(expected, await pgSeeds(c, expected))
    } finally {
      await tearDown()
    }
  }

  it('the unmodified text passes (the harness itself is sound)', async () => {
    expect(await runMutant((t) => t + '\n-- harmless trailing comment\n')).toEqual([])
  })

  it('a seed row removed from the baseline text is reported', async () => {
    const problems = await runMutant((t) => t.replace(/^  \('payment', .*\),\n/m, ''))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/^autonomy_categories: 15 row\(s\) in the SQLite chain, 14 in PostgreSQL/)
    expect(problems[1]).toMatch(/^autonomy_categories: key .*payment.* missing in PostgreSQL/)
  })

  it('a seed value changed in the baseline text is reported', async () => {
    const problems = await runMutant((t) => t.replace("'claude-opus-5'", "'claude-opus-4'"))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^model_profile_map: key .*premium_reasoning.* differs/)
  })

  it('the whole seed block removed from the baseline text is reported for all six tables', async () => {
    const problems = await runMutant((t) => t.slice(0, t.indexOf(BEGIN_MARK)) + t.slice(t.indexOf(END_MARK) + END_MARK.length))
    expect(problems.sort()).toEqual(Object.entries(expected).map(([t, s]) => `${t}: ${s.rows.size} row(s) in the SQLite chain, none in PostgreSQL`).sort())
  })

  it('the unixepoch() function removed from the baseline text is reported', async () => {
    const c = await buildFrom(baselineText.replace(/CREATE FUNCTION unixepoch\(\)[\s\S]*?\$\$;\n/, ''))
    try {
      expect(baselineText).toMatch(/CREATE FUNCTION unixepoch\(\)/)
      expect(await rolledBack(c, () => unixepochProblems(c))).toEqual(['expected exactly one unixepoch() in the schema, found 0'])
    } finally {
      await tearDown()
    }
  })

  it('an allowlist row removed from the baseline text is reported', async () => {
    const problems = await runMutant((t) => t.replace(/^  \('www\.github\.com', .*\),\n/m, ''))
    expect(problems.some((p) => /^egress_allowlist: .*missing in PostgreSQL/.test(p) && p.includes('www.github.com'))).toBe(true)
    expect(problems.some((p) => /^egress_allowlist: \d+ row\(s\) in the SQLite chain, \d+ in PostgreSQL/.test(p))).toBe(true)
  })
})

// ── unixepoch() ─────────────────────────────────────────────────────────────

describe('unixepoch()', () => {
  it('is one zero-argument SQL function returning bigint, STABLE, equal to the epoch of now() and fixed inside a transaction', async () => {
    await rolledBack(probe, async () => expect(await unixepochProblems(probe)).toEqual([]))
  })

  it('is close to the wall clock', async () => {
    const r = await probe.query('SELECT unixepoch()::text AS u')
    expect(Math.abs(Number(r.rows[0].u) - Date.now() / 1000)).toBeLessThan(5)
  })

  it('runs in the shapes the module SQL uses: as a value, in arithmetic, as an explicit column value', async () => {
    await rolledBack(probe, async () => {
      expect((await probe.query('SELECT (unixepoch() - 3600 < unixepoch()) AS ok')).rows[0].ok).toBe(true)
      await probe.query(`INSERT INTO tenants (id, display_name, created_at) VALUES ('tenant-a', 'Tenant A', unixepoch())`)
      const r = await probe.query(`SELECT (created_at = unixepoch()) AS ok FROM tenants WHERE id = 'tenant-a'`)
      expect(r.rows[0].ok).toBe(true)
    })
  })

  it('mutant: a VOLATILE clock-based unixepoch() is reported', async () => {
    await rolledBack(probe, async () => {
      await probe.query(`CREATE OR REPLACE FUNCTION unixepoch() RETURNS bigint LANGUAGE sql VOLATILE AS $$ SELECT extract(epoch from clock_timestamp())::bigint $$`)
      const problems = await unixepochProblems(probe)
      expect(problems.some((p) => /volatility is v/.test(p))).toBe(true)
      expect(problems.some((p) => /moved inside a transaction|not extract/.test(p))).toBe(true)
    })
  })

  it('mutant: a function that returns the wrong type or the wrong number is reported', async () => {
    await rolledBack(probe, async () => {
      await probe.query('DROP FUNCTION unixepoch()')
      await probe.query(`CREATE FUNCTION unixepoch() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 0 $$`)
      expect(await unixepochProblems(probe)).toContain('returns integer, not bigint')
    })
    await rolledBack(probe, async () => {
      await probe.query('DROP FUNCTION unixepoch()')
      expect(await unixepochProblems(probe)).toEqual(['expected exactly one unixepoch() in the schema, found 0'])
    })
  })
})

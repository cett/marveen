// Schema parity between the SQLite migration chain and the PostgreSQL baseline (src/migrations-pg/*.sql).
//
// Two models of the same schema, one read from an empty SQLite database after applyMigrations (what the chain builds)
// and one read from a PostgreSQL database built from the baseline, compared facet by facet: tables, columns (type,
// NOT NULL, identity, default), primary keys, UNIQUE constraints, foreign keys, CHECK constraints, indexes (key columns,
// direction, partial predicate) and triggers. The comparison is exact in both directions: an object on one side only
// is a difference, unless it is listed below with its reason.
//
// The SQLite side is never trusted to say what PostgreSQL will print. A CHECK expression or a partial-index
// predicate is turned into the expected PostgreSQL form by PostgreSQL itself: it is created on a scratch temp table
// with the mapped column types and read back (pg_get_constraintdef / pg_get_expr), so `x IN ('a','b')` and
// `= ANY (ARRAY[...])`, BETWEEN and the casts compare equal without a hand-written expression parser.
//
// Type map (documented in the baseline header): TEXT -> text, INTEGER -> bigint, REAL -> double precision, BLOB -> bytea;
// the FLAG_COLUMNS below -> smallint with a CHECK (col IN (0, 1)).
import type Database from 'better-sqlite3'
import type pg from 'pg'
import { blankCodePoints } from '../../blank-content.js'

/** 0/1 flag columns: smallint + CHECK (col IN (0, 1)), not boolean, because the code compares them with = 1. */
export const FLAG_COLUMNS: readonly string[] = [
  'approvals.human_only', 'autonomy_categories.human_only', 'autonomy_categories.locked',
  'claude_plans_registry.channels_allowed', 'cost_budgets.block_on_hard', 'cost_sources.active',
  'dashboard_users.disabled', 'import_sources.enabled', 'memories.auto_generated', 'restore_log.integrity_ok',
  'schedules.enabled', 'schedules.force_send', 'schedules.skip_if_busy', 'skill_revisions.has_scripts',
  'skill_revisions.touches_privilege', 'skills.is_global', 'store_file_audit.is_sensitive',
  'tenant_agent_availability.enabled',
]

/** INTEGER PRIMARY KEY without AUTOINCREMENT that the code lets SQLite assign (a rowid alias): an identity column in PG. */
export const ROWID_ALIAS_TABLES: readonly string[] = ['agent_audit_log', 'restore_log']

/** SQLite triggers that have no PostgreSQL twin in the baseline, with the reason. Every other SQLite trigger needs a twin of the same name. */
export const OMITTED_TRIGGERS: Readonly<Record<string, string>> = {
  artifacts_fts_ad: 'FTS5 sync (Phase 3: tsvector)',
  artifacts_fts_ai: 'FTS5 sync (Phase 3: tsvector)',
  artifacts_fts_au: 'FTS5 sync (Phase 3: tsvector)',
  memories_ad: 'FTS5 sync (Phase 3: tsvector)',
  memories_ai: 'FTS5 sync (Phase 3: tsvector)',
  memories_au: 'FTS5 sync (Phase 3: tsvector)',
  workspace_docs_fts_ad: 'FTS5 sync (Phase 3: tsvector)',
  workspace_docs_fts_ai: 'FTS5 sync (Phase 3: tsvector)',
  workspace_docs_fts_au: 'FTS5 sync (Phase 3: tsvector)',
  memories_content_not_blank_insert: 'one CHECK on memories.content in PG',
  memories_content_not_blank_update: 'one CHECK on memories.content in PG',
  kanban_cards_due_date_integer_ins: 'SQLite dynamic typing: due_date is a bigint in PG, the application passes an epoch',
  kanban_cards_due_date_integer_upd: 'SQLite dynamic typing: due_date is a bigint in PG, the application passes an epoch',
}

/** The FTS5 virtual tables (and so their shadow tables) the baseline leaves to Phase 3. */
export const OMITTED_VIRTUAL_TABLES: readonly string[] = ['artifacts_fts', 'memories_fts', 'workspace_docs_fts']

export interface ColumnModel { type: string; notNull: boolean; identity: boolean; default: string | null }
export interface IndexModel { table: string; unique: boolean; keys: string[]; where: string | null }
export interface TableModel {
  columns: Record<string, ColumnModel>
  pk: string[]
  /** UNIQUE constraints, each as 'a,b' (column order as declared), sorted. */
  uniques: string[]
  /** 'a,b -> table(c,d) ON DELETE CASCADE', sorted. */
  fks: string[]
  /** PostgreSQL's own rendering of each CHECK, sorted. */
  checks: string[]
}
export interface SchemaModel {
  tables: Record<string, TableModel>
  indexes: Record<string, IndexModel>
  /** 'trigger_name@table', sorted. */
  triggers: string[]
}

/** Stands for the memories not-blank CHECK on both sides: its character set is compared by blankSetDisagreement, not as text. */
export const NOT_BLANK_CHECK = 'NOT_BLANK_CHECK'

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`
const sortedUnique = (xs: string[]): string[] => [...new Set(xs)].sort()
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

const EPOCH_NOW = 'epoch_now'
const UUID_TEXT = 'uuid_text'

function canonSqliteDefault(d: string | null): string | null {
  if (d === null) return null
  if (d === 'unixepoch()') return EPOCH_NOW
  if (d.startsWith('lower(hex(randomblob(4))')) return UUID_TEXT
  return d
}

function canonPgDefault(d: string | null): string | null {
  if (d === null) return null
  // Only the floored form is unixepoch(): a bare ::bigint cast rounds half up and would be a second ahead of SQLite.
  if (/^\(floor\(EXTRACT\(epoch FROM now\(\)\)\)\)::bigint$/i.test(d)) return EPOCH_NOW
  if (d === '(gen_random_uuid())::text') return UUID_TEXT
  return d.replace(/::text$/, '')
}

/** The balanced-parenthesis bodies of every CHECK (...) in a CREATE TABLE text, in order. */
export function extractChecks(createSql: string): string[] {
  const out: string[] = []
  const re = /CHECK\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(createSql))) {
    let depth = 1
    let i = re.lastIndex
    while (depth && i < createSql.length) {
      if (createSql[i] === '(') depth++
      else if (createSql[i] === ')') depth--
      i++
    }
    out.push(collapse(createSql.slice(m.index + m[0].length, i - 1)))
  }
  return out
}

interface SqliteColumn { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }

/** The model PostgreSQL has to match, read from an empty SQLite database that applyMigrations has built. */
export async function expectedFromSqlite(sdb: Database.Database, probe: pg.ClientBase): Promise<{ model: SchemaModel; problems: string[] }> {
  const problems: string[] = []
  const all = sdb.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name).sort()
  if (JSON.stringify(virtual) !== JSON.stringify([...OMITTED_VIRTUAL_TABLES].sort())) {
    problems.push(`virtual tables in SQLite [${virtual.join(', ')}] differ from the ones the baseline leaves out [${OMITTED_VIRTUAL_TABLES.join(', ')}]`)
  }
  const isShadow = (n: string): boolean => virtual.some((v) => n.startsWith(`${v}_`) && /^(data|idx|content|docsize|config)$/.test(n.slice(v.length + 1)))
  const real = all.filter((t) => !virtual.includes(t.name) && !isShadow(t.name))

  const tables: Record<string, TableModel> = {}
  const colTypes: Record<string, { name: string; type: string }[]> = {}
  for (const t of real) {
    const cols = sdb.prepare(`PRAGMA table_xinfo(${JSON.stringify(t.name)})`).all() as SqliteColumn[]
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    const autoinc = /AUTOINCREMENT/i.test(t.sql)
    const model: TableModel = { columns: {}, pk, uniques: [], fks: [], checks: [] }
    colTypes[t.name] = []
    for (const c of cols) {
      if (c.hidden) problems.push(`${t.name}.${c.name} is a hidden/generated column, the parity model does not handle it`)
      const isFlag = FLAG_COLUMNS.includes(`${t.name}.${c.name}`)
      let type: string
      if (c.type === 'TEXT') type = 'text'
      else if (c.type === 'REAL') type = 'double precision'
      else if (c.type === 'BLOB') type = 'bytea'
      else if (c.type === 'INTEGER') type = isFlag ? 'smallint' : 'bigint'
      else { problems.push(`${t.name}.${c.name} has the unmapped SQLite type '${c.type}'`); type = 'unmapped' }
      if (isFlag && c.type !== 'INTEGER') problems.push(`flag column ${t.name}.${c.name} is not INTEGER in SQLite`)
      const identity = pk.length === 1 && pk[0] === c.name && c.type === 'INTEGER' && (autoinc || ROWID_ALIAS_TABLES.includes(t.name))
      model.columns[c.name] = { type, notNull: c.notnull === 1 || c.pk > 0, identity, default: canonSqliteDefault(c.dflt_value) }
      colTypes[t.name].push({ name: c.name, type })
    }
    // UNIQUE constraints (a NOCASE one becomes a lower() index, below)
    for (const ix of sdb.prepare(`PRAGMA index_list(${JSON.stringify(t.name)})`).all() as { name: string; origin: string }[]) {
      if (ix.origin !== 'u') continue
      const xi = (sdb.prepare(`PRAGMA index_xinfo(${JSON.stringify(ix.name)})`).all() as { name: string; key: number; coll: string }[]).filter((r) => r.key)
      if (xi.some((r) => String(r.coll).toUpperCase() === 'NOCASE')) continue
      model.uniques.push(xi.map((r) => r.name).join(','))
    }
    const fkMap = new Map<number, { table: string; from: string[]; to: string[]; del: string }>()
    for (const f of sdb.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t.name)})`).all() as { id: number; table: string; from: string; to: string; on_delete: string }[]) {
      const g = fkMap.get(f.id) ?? { table: f.table, from: [], to: [], del: f.on_delete }
      g.from.push(f.from); g.to.push(f.to); fkMap.set(f.id, g)
    }
    for (const g of fkMap.values()) model.fks.push(`${g.from.join(',')} -> ${g.table}(${g.to.join(',')}) ON DELETE ${g.del}`)
    tables[t.name] = model
  }

  // PG-only additions (documented in the baseline header): kanban_cards.seq replaces the rowid
  tables.kanban_cards.columns.seq = { type: 'bigint', notNull: true, identity: true, default: null }
  colTypes.kanban_cards.push({ name: 'seq', type: 'bigint' })
  tables.kanban_cards.uniques.push('seq')
  // ... and otel_spans.seq the insertion order (not unique: the primary key stays (trace_id, span_id))
  tables.otel_spans.columns.seq = { type: 'bigint', notNull: true, identity: true, default: null }
  colTypes.otel_spans.push({ name: 'seq', type: 'bigint' })

  // CHECKs, rendered by PostgreSQL itself on a scratch table with the mapped types
  const render = async (table: string, expr: string): Promise<string> => {
    await probe.query('DROP TABLE IF EXISTS pg_temp.parity_probe')
    await probe.query(`CREATE TEMP TABLE parity_probe (${colTypes[table].map((c) => `${q(c.name)} ${c.type}`).join(', ')}, CHECK (${expr}))`)
    const r = await probe.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'pg_temp.parity_probe'::regclass AND contype = 'c'")
    return (r.rows[0] as { def: string }).def
  }
  for (const t of real) {
    const model = tables[t.name]
    for (const text of extractChecks(t.sql)) model.checks.push(await render(t.name, text))
    for (const c of colTypes[t.name]) {
      if (!FLAG_COLUMNS.includes(`${t.name}.${c.name}`)) continue
      const def = await render(t.name, `${q(c.name)} IN (0, 1)`)
      if (!model.checks.includes(def)) model.checks.push(def) // two flags already had this CHECK in SQLite
    }
  }
  tables.memories.checks.push(NOT_BLANK_CHECK)
  for (const t of real) { tables[t.name].uniques.sort(); tables[t.name].fks.sort(); tables[t.name].checks.sort() }

  // indexes
  const indexes: Record<string, IndexModel> = {}
  const idxRows = sdb.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all() as { name: string; tbl_name: string; sql: string }[]
  for (const ix of idxRows) {
    if (!tables[ix.tbl_name]) continue // an index on an omitted FTS shadow table
    const xi = (sdb.prepare(`PRAGMA index_xinfo(${JSON.stringify(ix.name)})`).all() as { name: string; key: number; desc: number }[]).filter((r) => r.key)
    const w = /\sWHERE\s+([\s\S]+)$/i.exec(ix.sql)
    let where: string | null = null
    if (w) {
      await probe.query('DROP TABLE IF EXISTS pg_temp.parity_probe')
      await probe.query(`CREATE TEMP TABLE parity_probe (${colTypes[ix.tbl_name].map((c) => `${q(c.name)} ${c.type}`).join(', ')})`)
      await probe.query(`CREATE INDEX parity_probe_ix ON parity_probe (${q(colTypes[ix.tbl_name][0].name)}) WHERE ${collapse(w[1])}`)
      const r = await probe.query("SELECT pg_get_expr(indpred, indrelid) AS p FROM pg_index WHERE indexrelid = 'pg_temp.parity_probe_ix'::regclass")
      where = (r.rows[0] as { p: string }).p
    }
    indexes[ix.name] = { table: ix.tbl_name, unique: /^CREATE\s+UNIQUE/i.test(ix.sql), keys: xi.map((r) => (r.desc ? `${r.name} DESC` : r.name)), where }
  }
  // dashboard_users.username is UNIQUE COLLATE NOCASE in SQLite: a unique index on lower(username) in PG
  indexes.dashboard_users_username_key = { table: 'dashboard_users', unique: true, keys: ['lower(username)'], where: null }
  await probe.query('DROP TABLE IF EXISTS pg_temp.parity_probe')

  const trig = (sdb.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'").all() as { name: string; tbl_name: string }[])
  for (const name of Object.keys(OMITTED_TRIGGERS)) if (!trig.some((t) => t.name === name)) problems.push(`omitted trigger ${name} no longer exists in SQLite: drop it from OMITTED_TRIGGERS`)
  const triggers = trig.filter((t) => !(t.name in OMITTED_TRIGGERS)).map((t) => `${t.name}@${t.tbl_name}`).sort()
  return { model: { tables, indexes, triggers }, problems }
}

const PG_DELETE_ACTION: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

/** The model of the `public` schema of a PostgreSQL database. */
export async function actualFromPg(c: pg.ClientBase): Promise<SchemaModel> {
  const tables: Record<string, TableModel> = {}
  const tr = await c.query("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1")
  for (const r of tr.rows as { t: string }[]) tables[r.t] = { columns: {}, pk: [], uniques: [], fks: [], checks: [] }

  const cr = await c.query(`
    SELECT c.relname AS t, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS nn,
           a.attidentity AS ident, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`)
  for (const r of cr.rows as { t: string; col: string; type: string; nn: boolean; ident: string; def: string | null }[]) {
    tables[r.t].columns[r.col] = { type: r.type, notNull: r.nn, identity: r.ident === 'd', default: canonPgDefault(r.def) }
  }

  const kr = await c.query(`
    SELECT c.relname AS t, con.contype AS kind, pg_get_constraintdef(con.oid) AS def, con.confdeltype AS del,
           (SELECT relname FROM pg_class WHERE oid = con.confrelid) AS reftable,
           (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
           (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS refcols
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f', 'c')`)
  for (const r of kr.rows as { t: string; kind: string; def: string; del: string; reftable: string | null; cols: string[] | null; refcols: string[] | null }[]) {
    const t = tables[r.t]
    if (r.kind === 'p') t.pk = r.cols ?? []
    else if (r.kind === 'u') t.uniques.push((r.cols ?? []).join(','))
    else if (r.kind === 'f') t.fks.push(`${(r.cols ?? []).join(',')} -> ${r.reftable}(${(r.refcols ?? []).join(',')}) ON DELETE ${PG_DELETE_ACTION[r.del] ?? r.del}`)
    else t.checks.push(/^CHECK \(\(btrim\(content, '[^']*'::text\) <> ''::text\)\)$/s.test(r.def) ? NOT_BLANK_CHECK : r.def)
  }
  for (const t of Object.values(tables)) { t.uniques.sort(); t.fks.sort(); t.checks.sort() }

  // indexes that are not the backing index of a constraint
  const indexes: Record<string, IndexModel> = {}
  const ir = await c.query(`
    SELECT i.relname AS name, t.relname AS tbl, ix.indisunique AS uniq, pg_get_expr(ix.indpred, ix.indrelid) AS pred,
           (SELECT array_agg(pg_get_indexdef(ix.indexrelid, k, true) || CASE WHEN ix.indoption[k - 1] & 1 = 1 THEN ' DESC' ELSE '' END ORDER BY k)
              FROM generate_series(1, ix.indnkeyatts) k) AS keys
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid)`)
  for (const r of ir.rows as { name: string; tbl: string; uniq: boolean; pred: string | null; keys: string[] }[]) {
    // pg_get_indexdef quotes a column named like a type (timestamp); the SQLite side has the bare name
    indexes[r.name] = { table: r.tbl, unique: r.uniq, keys: r.keys.map((k) => k.replace(/"([a-z_][a-z0-9_]*)"/g, '$1')), where: r.pred }
  }

  const tg = await c.query("SELECT t.tgname || '@' || c.relname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1")
  return { tables, indexes, triggers: (tg.rows as { name: string }[]).map((r) => r.name).sort() }
}

function diffLists(label: string, expected: string[], actual: string[], out: string[]): void {
  const e = sortedUnique(expected)
  const a = sortedUnique(actual)
  for (const x of e) if (!a.includes(x)) out.push(`${label}: missing in PG: ${x}`)
  for (const x of a) if (!e.includes(x)) out.push(`${label}: only in PG: ${x}`)
}

/** Every difference between the expected (SQLite chain) and the actual (PostgreSQL baseline) model; empty means parity. */
export function diffSchemas(expected: SchemaModel, actual: SchemaModel): string[] {
  const out: string[] = []
  diffLists('tables', Object.keys(expected.tables), Object.keys(actual.tables), out)
  for (const [name, et] of Object.entries(expected.tables)) {
    const at = actual.tables[name]
    if (!at) continue
    diffLists(`columns of ${name}`, Object.keys(et.columns), Object.keys(at.columns), out)
    for (const [cn, ec] of Object.entries(et.columns)) {
      const ac = at.columns[cn]
      if (!ac) continue
      if (ec.type !== ac.type) out.push(`column ${name}.${cn}: type ${ec.type} expected, ${ac.type} in PG`)
      if (ec.notNull !== ac.notNull) out.push(`column ${name}.${cn}: NOT NULL ${ec.notNull} expected, ${ac.notNull} in PG`)
      if (ec.identity !== ac.identity) out.push(`column ${name}.${cn}: identity ${ec.identity} expected, ${ac.identity} in PG`)
      if (ec.default !== ac.default) out.push(`column ${name}.${cn}: default ${String(ec.default)} expected, ${String(ac.default)} in PG`)
    }
    if (et.pk.join(',') !== at.pk.join(',')) out.push(`primary key of ${name}: (${et.pk.join(',')}) expected, (${at.pk.join(',')}) in PG`)
    diffLists(`UNIQUE of ${name}`, et.uniques, at.uniques, out)
    diffLists(`FOREIGN KEY of ${name}`, et.fks, at.fks, out)
    diffLists(`CHECK of ${name}`, et.checks, at.checks, out)
  }
  diffLists('indexes', Object.keys(expected.indexes), Object.keys(actual.indexes), out)
  for (const [name, ei] of Object.entries(expected.indexes)) {
    const ai = actual.indexes[name]
    if (!ai) continue
    if (ei.table !== ai.table) out.push(`index ${name}: table ${ei.table} expected, ${ai.table} in PG`)
    if (ei.unique !== ai.unique) out.push(`index ${name}: unique ${ei.unique} expected, ${ai.unique} in PG`)
    if (ei.keys.join(', ') !== ai.keys.join(', ')) out.push(`index ${name}: keys (${ei.keys.join(', ')}) expected, (${ai.keys.join(', ')}) in PG`)
    if (ei.where !== ai.where) out.push(`index ${name}: predicate ${String(ei.where)} expected, ${String(ai.where)} in PG`)
  }
  diffLists('triggers', expected.triggers, actual.triggers, out)
  return out
}

/**
 * The BMP code points on which the memories not-blank CHECK of the PostgreSQL database and isBlankContent disagree.
 * The CHECK is evaluated by PostgreSQL itself for every code point (its own expression, with the column replaced by chr(cp)),
 * so a character list that drifts from src/blank-content.ts shows up here as the code points that differ.
 */
export async function blankSetDisagreement(c: pg.ClientBase): Promise<number[]> {
  const r = await c.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.memories'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%btrim(content,%'")
  if (r.rows.length !== 1) throw new Error(`expected exactly one not-blank CHECK on memories, found ${r.rows.length}`)
  const def = (r.rows[0] as { def: string }).def
  const body = def.replace(/^CHECK /, '')
  const expr = body.replace(/\bcontent\b/g, 'chr(cp)')
  if (expr === body) throw new Error('the not-blank CHECK does not mention content')
  const pgBlank = await c.query(`SELECT cp FROM generate_series(1, 65535) cp WHERE cp NOT BETWEEN 55296 AND 57343 AND NOT ${expr} ORDER BY cp`)
  const pgSet = new Set((pgBlank.rows as { cp: number }[]).map((x) => Number(x.cp)))
  const jsSet = new Set(blankCodePoints())
  const differ: number[] = []
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (pgSet.has(cp) !== jsSet.has(cp)) differ.push(cp)
  }
  return differ
}

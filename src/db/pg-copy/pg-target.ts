// The PostgreSQL side of the copy tool (P-G1): the catalog of the target, the role the tool connects as, and the counts.
// Read-only. The copy's writes live in copy.ts.

import type pg from 'pg'
import type { PgColumn, PgForeignKey, PgPolicyEdge, PgTable } from './schema.js'

export type Queryable = Pick<pg.Client, 'query'>

export interface PgRole {
  name: string
  superuser: boolean
  bypassRls: boolean
}

/** The base tables of the public schema, with their columns, the flag columns and the references of each foreign key. */
export async function readPgTables(q: Queryable): Promise<PgTable[]> {
  const cols = await q.query<{
    table_name: string
    column_name: string
    pg_type: string
    is_identity: boolean
    is_generated: boolean
    has_default: boolean
  }>(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS pg_type,
           a.attidentity <> '' AS is_identity, a.attgenerated <> '' AS is_generated, a.atthasdef AS has_default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`)
  // a flag column: a single-column CHECK that accepts exactly 0 and 1 (written as IN (0, 1) or as = ANY (ARRAY[0, 1]))
  const flags = await q.query<{ table_name: string; column_name: string }>(`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
    WHERE n.nspname = 'public' AND k.contype = 'c' AND cardinality(k.conkey) = 1
      AND (pg_get_constraintdef(k.oid) ~ 'IN \\(0, 1\\)' OR pg_get_constraintdef(k.oid) ~ 'ARRAY\\[0, 1\\]')`)
  const refs = await q.query<{ table_name: string; ref_table: string }>(`
    SELECT c.relname AS table_name, rc.relname AS ref_table
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class rc ON rc.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND k.contype = 'f'`)

  const flagSet = new Set(flags.rows.map((r) => `${r.table_name}.${r.column_name}`))
  const byName = new Map<string, PgTable>()
  for (const r of cols.rows) {
    let t = byName.get(r.table_name)
    if (!t) {
      t = { name: r.table_name, columns: [], references: [] }
      byName.set(r.table_name, t)
    }
    const column: PgColumn = {
      name: r.column_name,
      type: r.pg_type,
      identity: r.is_identity,
      generated: r.is_generated,
      hasDefault: r.has_default,
      flag: r.pg_type === 'smallint' && flagSet.has(`${r.table_name}.${r.column_name}`),
    }
    t.columns.push(column)
  }
  for (const r of refs.rows) {
    const t = byName.get(r.table_name)
    if (t) t.references.push(r.ref_table)
  }
  // A row-level policy that refers to another table (an EXISTS on the parent) refuses a child row whose parent is not
  // there yet, with no foreign key to say so: the policy's dependencies are write-order edges as well (the table itself
  // and the functions are not). The write order is a dependency order over these edges, so a cycle is refused by name.
  const policyRefs = await q.query<{ table_name: string; ref_table: string }>(`
    SELECT DISTINCT c.relname AS table_name, r.relname AS ref_table
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class r ON r.oid = d.refobjid
    JOIN pg_namespace rn ON rn.oid = r.relnamespace
    WHERE n.nspname = 'public' AND rn.nspname = 'public' AND r.oid <> c.oid
      AND p.polcmd IN ('*', 'a')`)
  for (const r of policyRefs.rows) {
    const t = byName.get(r.table_name)
    if (t && !t.references.includes(r.ref_table)) t.references.push(r.ref_table)
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The role this connection is, with the two attributes that would hide a missing system context from the policies. */
export async function readPgRole(q: Queryable): Promise<PgRole> {
  const r = await q.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT current_user AS name, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
  )
  const row = r.rows[0]
  if (!row) throw new Error('the connected role is not in pg_roles')
  return { name: row.name, superuser: row.rolsuper, bypassRls: row.rolbypassrls }
}

/** The owner of every base table of the public schema, by table name. */
export async function readTableOwners(q: Queryable): Promise<Map<string, string>> {
  const r = await q.query<{ table_name: string; owner: string }>(`
    SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`)
  return new Map(r.rows.map((x) => [x.table_name, x.owner]))
}

/** Every foreign key among the base tables of the public schema, with the columns on both sides in key order. */
export async function readForeignKeys(q: Queryable): Promise<PgForeignKey[]> {
  const r = await q.query<{
    name: string
    table_name: string
    ref_table: string
    columns: string[]
    ref_columns: string[]
    match_simple: boolean
  }>(`
    SELECT k.conname::text AS name, c.relname::text AS table_name, rc.relname::text AS ref_table,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord) AS ref_columns,
      k.confmatchtype = 's' AS match_simple
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class rc ON rc.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND k.contype = 'f'
    ORDER BY c.relname, k.conname`)
  return r.rows.map((x) => ({
    name: x.name,
    table: x.table_name,
    columns: x.columns,
    refTable: x.ref_table,
    refColumns: x.ref_columns,
    matchSimple: x.match_simple,
  }))
}

/** The row-level policies (INSERT or ALL) that read another public table, one edge per (table, referenced table, policy). */
export async function readPolicyEdges(q: Queryable): Promise<PgPolicyEdge[]> {
  const r = await q.query<{ table_name: string; ref_table: string; policy: string }>(`
    SELECT DISTINCT c.relname::text AS table_name, r.relname::text AS ref_table, p.polname::text AS policy
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class r ON r.oid = d.refobjid
    JOIN pg_namespace rn ON rn.oid = r.relnamespace
    WHERE n.nspname = 'public' AND rn.nspname = 'public' AND r.oid <> c.oid
      AND p.polcmd IN ('*', 'a')
    ORDER BY table_name, ref_table, policy`)
  return r.rows.map((x) => ({ table: x.table_name, refTable: x.ref_table, policy: x.policy }))
}

/** The rows of each named table (count(*), as the owner sees them: the caller decides whether RLS is in the way). */
export async function readPgRowCounts(q: Queryable, tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const t of tables) {
    const r = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.replace(/"/g, '""')}"`)
    out.set(t, Number(r.rows[0]?.n ?? '0'))
  }
  return out
}

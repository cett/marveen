// Orphan rows of the copy (P-G1, design decision of 2026-11-24). The SQLite side has no foreign keys, so a live database can
// hold rows that PostgreSQL refuses: a child whose parent is gone. The check finds them before any write, on the snapshot.
//
// The foreign keys come from the PostgreSQL catalog (the target's truth), not from SQLite. A child row breaks a key when
// every key column is non-NULL (MATCH SIMPLE: one NULL component is not checked) and no parent row matches it. A parent row
// that is itself an orphan does not count as a parent: the closure is a fixpoint over the temporary orphan sets, so the child
// of an orphan is an orphan too, and so is the self-referencing row whose parent is missing. A row-level policy that reads a
// parent (via_parent) is refused in the check unless a foreign key backs the same pair: the scan is blind on such an edge.
//
// The report names constraints, tables, columns, counts and at most ORPHAN_SAMPLE_ROWIDS rowids. It never names a value.

import type Database from 'better-sqlite3'
import { quoteIdent } from './sqlite-source.js'
import type { PgForeignKey, PgPolicyEdge, Refusal, TableMapping } from './schema.js'

/** At most this many rowids are named per foreign key. */
export const ORPHAN_SAMPLE_ROWIDS = 20

/**
 * What the copy does with an orphan row. `refuse` (the default) names every orphan and writes nothing. `skip` leaves the
 * orphans, and every row below them, out of the copy; the report lists them, and the source is never modified.
 */
export type OrphanMode = 'refuse' | 'skip'

export interface OrphanFinding {
  /** the PostgreSQL constraint name */
  constraint: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
  /** false when the referenced table is not in the SQLite source at all (every key value of the child is then an orphan) */
  parentInSource: boolean
  /** the rows of the child table that break this key, the transitive closure included */
  count: number
  /** the first rowids of them, ascending */
  rowids: string[]
}

export interface OrphanScan {
  /** one per foreign key that has at least one breaking row, in constraint order */
  findings: OrphanFinding[]
  /** per copied table: the rowids of its orphan rows (the closure); skip mode leaves exactly these out */
  orphans: Map<string, Set<bigint>>
  /** the scan cannot model a key (a key column with no SQLite column, a MATCH FULL key): a refusal, never a silent pass */
  problems: Refusal[]
}

function hasSourceColumn(m: TableMapping, column: string): boolean {
  return m.columns.some((c) => c.name === column && !c.fromRowid)
}

/** The name of the temporary orphan set of a mapped table (one per table, dropped when the scan ends). */
function orphanSetName(mappings: TableMapping[], m: TableMapping): string {
  return `pgcopy_orphans_${mappings.indexOf(m)}`
}

/**
 * The SQL predicate over the alias `c` (the child row) that holds when the row breaks the key: every key column non-NULL
 * and no parent row that is not an orphan matches. A parent table that is not in the source matches nothing.
 */
function breakingPredicate(fk: PgForeignKey, parentSet: string | undefined, parentInSource: boolean): string {
  const nonNull = fk.columns.map((c) => `c.${quoteIdent(c)} IS NOT NULL`).join(' AND ')
  if (!parentInSource || parentSet === undefined) return `(${nonNull})`
  const match = fk.refColumns.map((rc, i) => `p.${quoteIdent(rc)} = c.${quoteIdent(fk.columns[i]!)}`).join(' AND ')
  return (
    `(${nonNull}) AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(fk.refTable)} AS p ` +
    `WHERE ${match} AND p.rowid NOT IN (SELECT rid FROM ${parentSet}))`
  )
}

/**
 * The orphan scan of every foreign key whose child table is copied. Reads the snapshot only; the temporary sets it creates
 * are dropped before it returns. A key the scan cannot model is a `problems` refusal, so a key is never skipped silently.
 */
export function scanOrphans(db: Database.Database, mappings: TableMapping[], fks: PgForeignKey[]): OrphanScan {
  const byName = new Map(mappings.map((m) => [m.name, m]))
  const problems: Refusal[] = []
  const keys: Array<{ fk: PgForeignKey; child: TableMapping; parent?: TableMapping }> = []
  for (const fk of fks) {
    const child = byName.get(fk.table)
    // a child that is not copied has no rows in the source: nothing to check
    if (!child) continue
    if (!fk.matchSimple) {
      problems.push({ table: fk.table, reason: `foreign key ${fk.name} is not MATCH SIMPLE: the orphan scan does not model it` })
      continue
    }
    const missing = fk.columns.find((c) => !hasSourceColumn(child, c))
    if (missing !== undefined) {
      problems.push({ table: fk.table, column: missing, reason: `foreign key ${fk.name}: a key column has no SQLite column, the orphan scan cannot see it` })
      continue
    }
    const parent = byName.get(fk.refTable)
    if (parent && fk.refColumns.some((c) => !hasSourceColumn(parent, c))) {
      problems.push({ table: fk.table, column: fk.columns.join(', '), reason: `foreign key ${fk.name}: a referenced column has no SQLite column, the orphan scan cannot see it` })
      continue
    }
    keys.push({ fk, child, parent })
  }

  const orphans = new Map<string, Set<bigint>>()
  const findings: OrphanFinding[] = []
  for (const m of mappings) db.exec(`DROP TABLE IF EXISTS temp.${orphanSetName(mappings, m)}`)
  try {
    for (const m of mappings) db.exec(`CREATE TEMP TABLE ${orphanSetName(mappings, m)} (rid INTEGER PRIMARY KEY)`)

    // the fixpoint: a row is added when one of its keys breaks against the orphan sets so far; each pass can only add rows,
    // so the loop ends (a pass that adds nothing is the fixpoint)
    const passes = keys.map(({ fk, child, parent }) => ({
      stmt: db.prepare(
        `INSERT INTO ${orphanSetName(mappings, child)} (rid) ` +
          `SELECT c.rowid FROM ${quoteIdent(child.name)} AS c WHERE ${breakingPredicate(
            fk,
            parent ? orphanSetName(mappings, parent) : undefined,
            parent !== undefined,
          )} AND c.rowid NOT IN (SELECT rid FROM ${orphanSetName(mappings, child)})`,
      ),
    }))
    for (;;) {
      let added = 0
      for (const { stmt } of passes) added += Number(stmt.run().changes)
      if (added === 0) break
    }

    for (const m of mappings) {
      const rows = db.prepare(`SELECT rid FROM ${orphanSetName(mappings, m)}`).all() as Array<{ rid: bigint }>
      orphans.set(m.name, new Set(rows.map((r) => r.rid)))
    }

    // one finding per key: the rows that break it, against the closed orphan sets
    for (const { fk, child, parent } of keys) {
      const predicate = breakingPredicate(fk, parent ? orphanSetName(mappings, parent) : undefined, parent !== undefined)
      const from = `FROM ${quoteIdent(child.name)} AS c WHERE ${predicate}`
      const count = Number((db.prepare(`SELECT count(*) AS n ${from}`).get() as { n: bigint | number }).n)
      if (count === 0) continue
      const sample = db
        .prepare(`SELECT c.rowid AS rid ${from} ORDER BY c.rowid LIMIT ${ORPHAN_SAMPLE_ROWIDS}`)
        .all() as Array<{ rid: bigint }>
      findings.push({
        constraint: fk.name,
        table: child.name,
        columns: fk.columns,
        refTable: fk.refTable,
        refColumns: fk.refColumns,
        parentInSource: parent !== undefined,
        count,
        rowids: sample.map((r) => r.rid.toString()),
      })
    }
  } finally {
    for (const m of mappings) db.exec(`DROP TABLE IF EXISTS temp.${orphanSetName(mappings, m)}`)
  }
  return { findings, orphans, problems }
}

/** One refusal per finding: the constraint, the columns, the count and the first rowids. No value. */
export function orphanRefusals(findings: OrphanFinding[]): Refusal[] {
  return findings.map((f) => {
    const cause = f.parentInSource
      ? 'the parent row is missing or is itself an orphan'
      : 'the parent table is not in the SQLite source'
    const more = f.count > f.rowids.length ? ` (first ${f.rowids.length})` : ''
    return {
      table: f.table,
      column: f.columns.join(', '),
      reason:
        `foreign key ${f.constraint} (${f.columns.join(', ')} -> ${f.refTable}(${f.refColumns.join(', ')})): ` +
        `${f.count} orphan row(s), ${cause}; rowids${more}: ${f.rowids.join(', ')}`,
    }
  })
}

/**
 * A row-level policy edge the copy tool pins: the policy of `child` reads `parent`, and no PostgreSQL foreign key backs the
 * pair. A `parent` entry is a parent link: it is scanned like a foreign key (child columns against parent columns). A
 * `lookup` entry is pinned but not scanned: the policy reads the other table for a reason that refuses no orphan row, and
 * the reason says which. An entry the target does not have is ignored at run time; the catalog cells keep it exact.
 */
export type PinnedPolicyEdge =
  | { kind: 'parent'; child: string; parent: string; childColumns: string[]; parentColumns: string[] }
  | { kind: 'lookup'; child: string; parent: string; reason: string }

/** The catalog of the current schema (the seven uncovered edges of the 2026-11-24 baseline). */
export const PINNED_POLICY_EDGES: PinnedPolicyEdge[] = [
  { kind: 'parent', child: 'idea_comments', parent: 'idea_box', childColumns: ['idea_id'], parentColumns: ['id'] },
  { kind: 'parent', child: 'idea_status_log', parent: 'idea_box', childColumns: ['idea_id'], parentColumns: ['id'] },
  { kind: 'parent', child: 'kanban_card_events', parent: 'kanban_cards', childColumns: ['card_id'], parentColumns: ['id'] },
  { kind: 'parent', child: 'kanban_card_labels', parent: 'kanban_cards', childColumns: ['card_id'], parentColumns: ['id'] },
  { kind: 'parent', child: 'kanban_comments', parent: 'kanban_cards', childColumns: ['card_id'], parentColumns: ['id'] },
  { kind: 'parent', child: 'skill_revision_files', parent: 'skill_revisions', childColumns: ['revision_id'], parentColumns: ['id'] },
  {
    kind: 'lookup',
    child: 'skill_revisions',
    parent: 'skills',
    reason:
      'the tenant policy reads skills.is_global for the NOT EXISTS of a global skill; a missing skill satisfies NOT EXISTS, ' +
      'so no orphan revision is refused by it',
  },
]

/**
 * The policy edges of the target (every table, copied or not) that no foreign key on the same pair backs. A row-level
 * policy that reads a parent refuses an orphan child with no constraint name, and the orphan scan cannot see such an edge
 * unless the pinned catalog names it.
 */
export function policyEdgesWithoutForeignKey(edges: PgPolicyEdge[], fks: PgForeignKey[]): PgPolicyEdge[] {
  return edges.filter((e) => !fks.some((fk) => fk.table === e.table && fk.refTable === e.refTable))
}

/** The uncovered edges that the pinned catalog does not name: the check refuses each pair once. */
export function unpinnedPolicyEdges(uncovered: PgPolicyEdge[], pinned: PinnedPolicyEdge[] = PINNED_POLICY_EDGES): PgPolicyEdge[] {
  return uncovered.filter((e) => !pinned.some((p) => p.child === e.table && p.parent === e.refTable))
}

/** The refusals for the unpinned edges: one per (child, parent) pair, naming no value. */
export function unpinnedPolicyRefusals(unpinned: PgPolicyEdge[]): Refusal[] {
  const seen = new Set<string>()
  const out: Refusal[] = []
  for (const e of unpinned) {
    const key = `${e.table} -> ${e.refTable}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ table: e.table, reason: `policy edge not in the orphan catalog: ${key}` })
  }
  return out
}

/**
 * The pinned `parent` entries whose policy edge the target has (and no key backs), as foreign keys for the orphan scan. An
 * entry the target does not have yields nothing, so a stale catalog entry cannot refuse a copy.
 */
export function pinnedParentKeys(uncovered: PgPolicyEdge[], pinned: PinnedPolicyEdge[] = PINNED_POLICY_EDGES): PgForeignKey[] {
  return pinned.flatMap((p): PgForeignKey[] => {
    if (p.kind !== 'parent' || !uncovered.some((e) => e.table === p.child && e.refTable === p.parent)) return []
    return [
      {
        name: `via_parent:${p.child}(${p.childColumns.join(', ')})->${p.parent}(${p.parentColumns.join(', ')})`,
        table: p.child,
        columns: p.childColumns,
        refTable: p.parent,
        refColumns: p.parentColumns,
        matchSimple: true,
      },
    ]
  })
}

/**
 * The uncovered edges of the copied tables only. The check uses policyEdgesWithoutForeignKey over the whole target; this
 * copied-table view is kept for the unit cell that pins the filter.
 */
export function uncoveredPolicyEdges(edges: PgPolicyEdge[], fks: PgForeignKey[], mappings: TableMapping[]): PgPolicyEdge[] {
  const copied = new Set(mappings.map((m) => m.name))
  return policyEdgesWithoutForeignKey(edges, fks).filter((e) => copied.has(e.table))
}

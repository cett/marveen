// The write order inside a table with a self reference (P-G1, decision of 2026-11-24). A row must be written after its parent,
// and SQLite does not write the rows in that order (a child can have a lower rowid than its parent). The foreign key is not
// deferrable, so the copy orders the table by dependency depth instead: a root (no parent) has depth 0, a child has its
// parent's depth + 1. The depth is a recursive walk over the snapshot, kept in a temporary table (rid, depth) that the copy
// reads its rows by, in (depth, rid) order.
//
// A row the walk does not reach has a parent loop: the walk starts at the roots and follows the children, so a row with no
// path from a root sits on a cycle (or below one). Such a table is refused by name, with the rowids. An orphan is not a
// cycle member: it is excluded by the orphan scan, and it is left out of the walk.
//
// A table with no self reference has no depth table: its rows are read by rowid, as before.

import type Database from 'better-sqlite3'
import { ORPHAN_SAMPLE_ROWIDS } from './orphans.js'
import { quoteIdent } from './sqlite-source.js'
import type { PgForeignKey, Refusal, TableMapping } from './schema.js'

export interface SelfOrder {
  /** per table with a self reference: the temporary table (rid, depth) that the copy reads its rows by */
  depthTables: Map<string, string>
  refusals: Refusal[]
}

function hasSourceColumn(m: TableMapping, column: string): boolean {
  return m.columns.some((c) => c.name === column && !c.fromRowid)
}

/**
 * The depth of every row of every table with a self reference, on the snapshot. Keys that the orphan scan cannot model are
 * skipped here (the scan refused them already). More than one self reference on a table is refused: one order per table.
 */
export function planSelfOrder(
  db: Database.Database,
  mappings: TableMapping[],
  fks: PgForeignKey[],
  orphans: Map<string, Set<bigint>>,
): SelfOrder {
  const depthTables = new Map<string, string>()
  const refusals: Refusal[] = []
  for (const m of mappings) {
    const selfKeys = fks.filter((fk) => fk.table === m.name && fk.refTable === m.name)
    if (selfKeys.length === 0) continue
    if (selfKeys.length > 1) {
      refusals.push({ table: m.name, reason: `${selfKeys.length} self references on one table: the copy has one dependency order for a table` })
      continue
    }
    const fk = selfKeys[0]!
    const modelled =
      fk.matchSimple &&
      fk.columns.every((c) => hasSourceColumn(m, c)) &&
      fk.refColumns.every((c) => hasSourceColumn(m, c))
    if (!modelled) continue

    const T = quoteIdent(m.name)
    const name = `pgcopy_depth_${mappings.indexOf(m)}`
    const keyCols = fk.refColumns.map((c) => quoteIdent(c))
    const keyNames = fk.refColumns.map((_, i) => `k${i}`)
    const nonNull = fk.columns.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ')
    const join = fk.columns.map((c, i) => `t.${quoteIdent(c)} = walk.${keyNames[i]}`).join(' AND ')
    const childKeys = keyCols.map((c) => `t.${c}`).join(', ')

    db.exec(`DROP TABLE IF EXISTS temp.${name}`)
    db.exec(`CREATE TEMP TABLE ${name} (rid INTEGER PRIMARY KEY, depth INTEGER NOT NULL)`)
    db.exec(`CREATE INDEX ${name}_order ON ${name} (depth, rid)`)
    // a row whose key has a NULL component is a root (MATCH SIMPLE: it names no parent); the walk is capped at the row count,
    // so a parent loop cannot run forever even when a key value is repeated
    db.exec(
      `WITH RECURSIVE walk(rid, ${keyNames.join(', ')}, depth) AS (` +
        `SELECT rowid, ${keyCols.join(', ')}, 0 FROM ${T} WHERE NOT (${nonNull}) ` +
        `UNION ALL ` +
        `SELECT t.rowid, ${childKeys}, walk.depth + 1 FROM ${T} AS t JOIN walk ON ${join} ` +
        `WHERE walk.depth < (SELECT count(*) FROM ${T})` +
        `) INSERT INTO ${name} (rid, depth) SELECT rid, max(depth) FROM walk GROUP BY rid`,
    )
    depthTables.set(m.name, name)

    const reached = db.prepare(`SELECT 1 AS hit FROM ${name} WHERE rid = ?`)
    const own = orphans.get(m.name) ?? new Set<bigint>()
    const all = db.prepare(`SELECT rowid AS rid FROM ${T} ORDER BY rowid`).all() as Array<{ rid: bigint }>
    const unreached = all.filter((r) => !own.has(r.rid) && reached.get(r.rid) === undefined).map((r) => r.rid)
    if (unreached.length > 0) {
      const shown = unreached.slice(0, ORPHAN_SAMPLE_ROWIDS).map((r) => r.toString())
      refusals.push({
        table: m.name,
        column: fk.columns.join(', '),
        reason:
          `self-reference cycle: ${unreached.length} row(s) reach no root through ${fk.name} (their parents form a loop); ` +
          `rowids${unreached.length > shown.length ? ` (first ${shown.length})` : ''}: ${shown.join(', ')}`,
      })
    }
  }
  return { depthTables, refusals }
}

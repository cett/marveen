// The orphan catalog of the copy tool (P-G1, decision of 2026-11-24) against a real PostgreSQL 16 target: the pinned set is
// exactly the uncovered policy edges of the migrated schema (O5a), each pinned policy names its parent and its columns
// (O5b), an unpinned edge is refused by name with nothing written (O5c), and the live shape of the orphan rows is found
// through the catalog with no foreign key on the pair (O1).
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../db-migrations.js'
import { runCheck } from '../../db/pg-copy/check.js'
import { PINNED_POLICY_EDGES, policyEdgesWithoutForeignKey, unpinnedPolicyEdges } from '../../db/pg-copy/orphans.js'
import { readForeignKeys, readPolicyEdges, type Queryable } from '../../db/pg-copy/pg-target.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A SQLite database built by the migration chain; `extra` runs with the foreign keys off (SQLite declares them, the live data breaks them). */
function buildSqlite(extra: (db: Database.Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgcopy-catalog-pg-'))
  dirs.push(dir)
  const file = join(dir, 'source.db')
  const db = new Database(file)
  applyMigrations(db)
  db.pragma('foreign_keys = OFF')
  extra(db)
  db.close()
  return file
}

let target: PgTestDb | undefined

afterEach(async () => {
  if (target) await target.close()
  target = undefined
})

async function freshTarget(): Promise<PgTestDb> {
  target = await createPgTestDb()
  return target
}

/** The pinned pairs as "child -> parent", the form the uncovered edges are compared in. */
function pinnedPairs(): string[] {
  return PINNED_POLICY_EDGES.map((p) => `${p.child} -> ${p.parent}`).sort()
}

/** The uncovered pairs of the target as "child -> parent", one per pair. */
async function uncoveredPairs(t: PgTestDb): Promise<string[]> {
  const q = t.ownerPool as unknown as Queryable
  const uncovered = policyEdgesWithoutForeignKey(await readPolicyEdges(q), await readForeignKeys(q))
  return [...new Set(uncovered.map((e) => `${e.table} -> ${e.refTable}`))].sort()
}

describe('O5a: the pinned catalog is exactly the uncovered policy edges of the migrated schema', () => {
  it('the uncovered pairs read from pg_policy equal the pinned pairs; there are seven; none is left unpinned', async () => {
    const t = await freshTarget()
    const pairs = await uncoveredPairs(t)
    expect(pairs).toEqual(pinnedPairs())
    expect(pairs).toHaveLength(7)
    const uncovered = policyEdgesWithoutForeignKey(await readPolicyEdges(t.ownerPool as unknown as Queryable), await readForeignKeys(t.ownerPool as unknown as Queryable))
    expect(unpinnedPolicyEdges(uncovered)).toEqual([])
  })
})

describe('O5b: every pinned entry names, in the policy expression of its child, the parent table and the columns', () => {
  it('a parent entry is the via_parent policy of the child that reads the parent on the pinned columns; a lookup entry reads its parent', async () => {
    const t = await freshTarget()
    // pg_get_expr breaks lines and indents; the text is collapsed to single spaces, so the match is on the words
    for (const p of PINNED_POLICY_EDGES) {
      const r = await t.ownerPool.query<{ name: string; text: string }>(
        `SELECT p.polname::text AS name,
                regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                  coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\\s+', ' ', 'g') AS text
         FROM pg_policy p WHERE p.polrelid = to_regclass($1)`,
        [`public.${p.child}`],
      )
      if (p.kind === 'parent') {
        const via = r.rows.filter((x) => x.name === 'via_parent')
        expect(via.length, `${p.child} has a via_parent policy`).toBeGreaterThan(0)
        const pairs = p.childColumns.map((cc, i) => `p.${p.parentColumns[i]} = ${p.child}.${cc}`)
        const ok = via.some((x) => x.text.includes(`FROM ${p.parent} p`) && pairs.every((pair) => x.text.includes(pair)))
        expect(ok, `${p.child} via_parent names ${p.parent} and ${pairs.join(', ')}`).toBe(true)
      } else {
        expect(r.rows.some((x) => x.text.includes(`FROM ${p.parent} s`)), `${p.child} reads ${p.parent}`).toBe(true)
      }
    }
  })
})

describe('O5c: fail-closed: a via_parent policy edge that the catalog does not pin is refused by name, nothing is written', () => {
  it('an extra policy on a scratch table reading kanban_cards is refused with the edge named; the target stays empty', async () => {
    const t = await freshTarget()
    await t.ownerPool.query('CREATE TABLE scratch_unpinned_probe (id TEXT PRIMARY KEY, card_ref TEXT)')
    await t.ownerPool.query('ALTER TABLE scratch_unpinned_probe ENABLE ROW LEVEL SECURITY')
    await t.ownerPool.query(
      'CREATE POLICY via_parent ON scratch_unpinned_probe FOR ALL ' +
        'USING (EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = scratch_unpinned_probe.card_ref)) ' +
        'WITH CHECK (EXISTS (SELECT 1 FROM kanban_cards p WHERE p.id = scratch_unpinned_probe.card_ref))',
    )
    const report = await runCheck({ sqlitePath: buildSqlite(() => {}), pgUrl: t.ownerUrl })
    expect(report.ok).toBe(false)
    expect(report.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'scratch_unpinned_probe', reason: 'policy edge not in the orphan catalog: scratch_unpinned_probe -> kanban_cards' }),
      ]),
    )
    expect(report.plan.uncoveredPolicyEdges.map((e) => `${e.table} -> ${e.refTable}`)).toEqual(['scratch_unpinned_probe -> kanban_cards'])
    // the seven pinned edges are not refused alongside it
    expect(report.refusals.filter((r) => /orphan catalog/.test(r.reason))).toHaveLength(1)
    const rows = await t.ownerPool.query<{ n: string }>('SELECT count(*)::text AS n FROM kanban_cards')
    expect(Number(rows.rows[0]?.n)).toBe(0)
  })
})

describe('O1 (live shape): the orphan rows of the four pinned child tables are found with no foreign key on their pairs', () => {
  it('check in refuse mode gives one report naming all four tables with exact counts; no value is named', async () => {
    const t = await freshTarget()
    const sqlitePath = buildSqlite((db) => {
      const insIdea = db.prepare('INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)')
      for (let i = 0; i < 2; i++) insIdea.run(`idea-missing-${i}`, 'agent-a', `VALUE-SECRET-IDEA-${i}`, 1)
      const insEvent = db.prepare('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      for (let i = 0; i < 7; i++) insEvent.run(`card-missing-${i}`, 'planned', 'done', 'agent-a', 1)
      db.prepare('INSERT INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)').run('card-missing-x', 'label-a', 1)
      const insComment = db.prepare('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)')
      for (let i = 0; i < 7; i++) insComment.run(`card-missing-${i}`, 'agent-a', `VALUE-SECRET-COMMENT-${i}`, 1)
    })
    const report = await runCheck({ sqlitePath, pgUrl: t.ownerUrl })
    expect(report.ok).toBe(false)
    expect(Object.fromEntries(report.plan.orphans.map((f) => [f.table, f.count]))).toEqual({
      idea_comments: 2,
      kanban_card_events: 7,
      kanban_card_labels: 1,
      kanban_comments: 7,
    })
    expect(report.plan.orphans.map((f) => f.constraint).sort()).toEqual([
      'via_parent:idea_comments(idea_id)->idea_box(id)',
      'via_parent:kanban_card_events(card_id)->kanban_cards(id)',
      'via_parent:kanban_card_labels(card_id)->kanban_cards(id)',
      'via_parent:kanban_comments(card_id)->kanban_cards(id)',
    ])
    // one refusal per finding, all of them in this one report
    expect(report.refusals.filter((r) => /orphan row\(s\)/.test(r.reason))).toHaveLength(4)
    for (const f of report.plan.orphans) expect(f.rowids.length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(report)).not.toMatch(/VALUE-SECRET|card-missing|idea-missing/)
  })
})

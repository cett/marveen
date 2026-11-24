// The schema agreement and the table order of the copy tool (src/db/pg-copy/schema.ts), as pure functions.
import { describe, expect, it } from 'vitest'
import { orderTables, planSchema, skipReason, type PgColumn, type PgTable, type SqliteTable } from '../db/pg-copy/schema.js'

const col = (name: string, type = 'text', over: Partial<PgColumn> = {}): PgColumn => ({
  name, type, identity: false, generated: false, hasDefault: false, flag: false, ...over,
})

describe('skip list: what is not copied, and why', () => {
  it('SQLite internals, the migration bookkeeping, FTS5 and its shadows, the vec0 indexes are skipped', () => {
    expect(skipReason('sqlite_sequence')).toBeDefined()
    expect(skipReason('schema_version')).toBeDefined()
    expect(skipReason('memories_fts')).toBeDefined()
    expect(skipReason('memories_fts_data')).toBeDefined()
    expect(skipReason('artifacts_fts_docsize')).toBeDefined()
    expect(skipReason('vec_memories')).toBeDefined()
    expect(skipReason('vec_artifacts_rowids')).toBeDefined()
  })

  it('an ordinary table, and a name that only looks like a shadow, are copied', () => {
    expect(skipReason('memories')).toBeUndefined()
    expect(skipReason('memories_fts_extra')).toBeUndefined()
    expect(skipReason('vector_notes')).toBeUndefined()
  })
})

describe('planSchema: every mismatch is a named refusal', () => {
  const pgMemories: PgTable = {
    name: 'memories',
    columns: [col('id', 'bigint', { identity: true }), col('content'), col('created_at', 'bigint', { hasDefault: true }), col('flag', 'smallint', { flag: true })],
    references: [],
  }

  it('a green plan: matching columns, identity and defaulted columns left to the database', () => {
    const sqlite: SqliteTable[] = [{ name: 'memories', columns: [{ name: 'id', declaredType: 'INTEGER' }, { name: 'content', declaredType: 'TEXT' }, { name: 'flag', declaredType: 'INTEGER' }] }]
    const plan = planSchema(sqlite, [pgMemories])
    expect(plan.refusals).toEqual([])
    expect(plan.mappings[0]!.leftToDatabase).toEqual(['created_at'])
    expect(plan.mappings[0]!.identityColumns).toEqual(['id'])
    expect(plan.mappings[0]!.columns.find((c) => c.name === 'flag')!.flag).toBe(true)
  })

  it('a SQLite table with no PostgreSQL table is refused, and named', () => {
    const plan = planSchema([{ name: 'orphan_table', columns: [{ name: 'x', declaredType: 'TEXT' }] }], [])
    expect(plan.refusals).toEqual([expect.objectContaining({ table: 'orphan_table' })])
  })

  it('a SQLite column with no PostgreSQL column is refused, with the column named', () => {
    const sqlite: SqliteTable[] = [{ name: 'memories', columns: [{ name: 'id', declaredType: 'INTEGER' }, { name: 'content', declaredType: 'TEXT' }, { name: 'legacy', declaredType: 'TEXT' }] }]
    const plan = planSchema(sqlite, [pgMemories])
    // the missing flag column is a refusal too (it is neither identity, generated nor defaulted): both are named
    expect(plan.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'memories', column: 'legacy' })]))
    expect(plan.refusals).toHaveLength(2)
  })

  it('a PostgreSQL column with no SQLite column that is not an identity, generated or defaulted is refused', () => {
    const sqlite: SqliteTable[] = [{ name: 'memories', columns: [{ name: 'id', declaredType: 'INTEGER' }, { name: 'content', declaredType: 'TEXT' }] }]
    const plan = planSchema(sqlite, [pgMemories])
    expect(plan.refusals.map((r) => r.column)).toEqual(expect.arrayContaining(['flag']))
  })

  it('a PostgreSQL-only table is not a refusal: it is named (the embeddings stage fills it)', () => {
    const plan = planSchema([], [pgMemories])
    expect(plan.refusals).toEqual([])
    expect(plan.pgOnlyTables).toEqual(['memories'])
  })

  it('a PostgreSQL identity column named seq with no SQLite column takes the SQLite rowid (kanban running number)', () => {
    const pgKanban: PgTable = { name: 'kanban_cards', columns: [col('id'), col('seq', 'bigint', { identity: true })], references: [] }
    const plan = planSchema([{ name: 'kanban_cards', columns: [{ name: 'id', declaredType: 'TEXT' }] }], [pgKanban])
    expect(plan.refusals).toEqual([])
    expect(plan.mappings[0]!.columns.find((c) => c.name === 'seq')).toEqual(expect.objectContaining({ fromRowid: true }))
  })
})

describe('orderTables: parents before children, a cycle named', () => {
  it('a child comes after its parent, whatever the input order', () => {
    const refs = new Map([['child', ['parent']], ['parent', []], ['grand', ['child']]])
    const r = orderTables(['grand', 'child', 'parent'], refs)
    expect(r).toEqual({ order: ['parent', 'child', 'grand'] })
  })

  it('a self reference is not an edge; the table is ordered by name among the free ones', () => {
    const r = orderTables(['b', 'a'], new Map([['a', ['a']], ['b', []]]))
    expect(r).toEqual({ order: ['a', 'b'] })
  })

  it('a cycle is refused and its tables are named', () => {
    const r = orderTables(['x', 'y', 'z'], new Map([['x', ['y']], ['y', ['x']], ['z', []]]))
    expect(r).toEqual({ cycle: ['x', 'y'] })
  })
})

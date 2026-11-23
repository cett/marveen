// The PG-only tables of diffSchemas, on synthetic models (no PostgreSQL, so it runs in the default suite). The three
// embedding tables are compared against their literal spec (PG_ONLY_TABLE_MODELS) in every facet, nothing skipped: the
// baseline parity (baseline-parity.pg.test.ts) runs the same function against the real catalog, and its constraint
// mutants need this comparison to see a dropped key. These cells pin the comparison without a server.
import { describe, expect, it } from 'vitest'
import { diffSchemas, PG_ONLY_TABLE_MODELS, type SchemaModel, type TableModel } from './helpers/pg-parity.js'

const SQLITE_TABLES = ['memories', 'workspace_docs', 'artifacts']

function table(): TableModel {
  return {
    columns: { id: { type: 'bigint', notNull: true, identity: false, default: null } },
    pk: ['id'],
    uniques: [],
    fks: [],
    checks: [],
  }
}

/** A deep copy of the literal spec of one PG-only table, as the PostgreSQL model would hold it. */
function spec(name: string): TableModel {
  return JSON.parse(JSON.stringify(PG_ONLY_TABLE_MODELS[name])) as TableModel
}

function model(tables: Record<string, TableModel>): SchemaModel {
  return { tables, indexes: {}, triggers: [] }
}

/** The SQLite side (the three base tables) and the PostgreSQL side (the same plus every listed embedding table, as specified). */
function sides(extra: Record<string, TableModel> = {}): { expected: SchemaModel; actual: SchemaModel } {
  const base: Record<string, TableModel> = {}
  for (const name of SQLITE_TABLES) base[name] = table()
  const expected = model(base)
  const actualTables: Record<string, TableModel> = { ...base }
  for (const name of Object.keys(PG_ONLY_TABLE_MODELS)) actualTables[name] = spec(name)
  return { expected, actual: model({ ...actualTables, ...extra }) }
}

describe('diffSchemas: the PG-only tables are compared against their spec, and the list is strict', () => {
  it('the three named embedding tables are the PG-only exception list', () => {
    expect(Object.keys(PG_ONLY_TABLE_MODELS).sort()).toEqual(['artifact_embeddings', 'memory_embeddings', 'workspace_doc_embeddings'])
  })

  it('(i) the listed tables present on the PG side, exactly as specified, are no difference', () => {
    const { expected, actual } = sides()
    expect(diffSchemas(expected, actual)).toEqual([])
  })

  it('(ii) a listed table missing on the PG side is a difference', () => {
    const { expected, actual } = sides()
    delete actual.tables.memory_embeddings
    const diff = diffSchemas(expected, actual)
    expect(diff).toEqual(['PG-only table listed in PG_ONLY_TABLE_MODELS is missing in PG: memory_embeddings'])
  })

  it('(iii) an unlisted extra table on the PG side is still a difference', () => {
    const { expected, actual } = sides({ rogue_embeddings: table() })
    expect(diffSchemas(expected, actual)).toEqual(['tables: only in PG: rogue_embeddings'])
  })

  it('(iv) a dropped primary key of a listed table is a difference', () => {
    const { expected, actual } = sides()
    actual.tables.artifact_embeddings!.pk = []
    expect(diffSchemas(expected, actual)).toEqual(['primary key of artifact_embeddings: (artifact_id) expected, () in PG'])
  })

  it('(v) the cascade to the parent replaced by NO ACTION is a difference', () => {
    const { expected, actual } = sides()
    actual.tables.memory_embeddings!.fks = ['memory_id -> memories(id) ON DELETE NO ACTION']
    expect(diffSchemas(expected, actual)).toEqual([
      'FOREIGN KEY of memory_embeddings: missing in PG: memory_id -> memories(id) ON DELETE CASCADE',
      'FOREIGN KEY of memory_embeddings: only in PG: memory_id -> memories(id) ON DELETE NO ACTION',
    ])
  })

  it('(vi) an embedding column of another dimension is a difference', () => {
    const { expected, actual } = sides()
    actual.tables.workspace_doc_embeddings!.columns.embedding!.type = 'vector(1536)'
    expect(diffSchemas(expected, actual)).toEqual([
      'column workspace_doc_embeddings.embedding: type vector(768) expected, vector(1536) in PG',
    ])
  })

  it('(vii) a foreign key whose ON DELETE action is left out is a difference (the cascade is compared, not only the key)', () => {
    const { expected, actual } = sides()
    actual.tables.memory_embeddings!.fks = ['memory_id -> memories(id)']
    expect(diffSchemas(expected, actual)).toEqual([
      'FOREIGN KEY of memory_embeddings: missing in PG: memory_id -> memories(id) ON DELETE CASCADE',
      'FOREIGN KEY of memory_embeddings: only in PG: memory_id -> memories(id)',
    ])
  })

  it('(viii) a dropped foreign key of a listed table is a difference', () => {
    const { expected, actual } = sides()
    actual.tables.memory_embeddings!.fks = []
    expect(diffSchemas(expected, actual)).toEqual([
      'FOREIGN KEY of memory_embeddings: missing in PG: memory_id -> memories(id) ON DELETE CASCADE',
    ])
  })
})

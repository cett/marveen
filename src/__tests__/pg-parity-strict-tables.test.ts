// The strict PG_ONLY_TABLES check of diffSchemas, on synthetic models (no PostgreSQL, so it runs in the default suite).
// The real baseline parity (baseline-parity.pg.test.ts) is the only PostgreSQL-side run of this check; these cells pin it
// without a server: a listed table that is present on the PostgreSQL side leaves the model, a listed table that is missing
// is a difference, and an unlisted extra table is still a difference.
import { describe, expect, it } from 'vitest'
import { diffSchemas, PG_ONLY_TABLES, type SchemaModel, type TableModel } from './helpers/pg-parity.js'

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

function model(names: string[]): SchemaModel {
  const tables: Record<string, TableModel> = {}
  for (const name of names) tables[name] = table()
  return { tables, indexes: {}, triggers: [] }
}

describe('diffSchemas: the PG_ONLY_TABLES exception is strict', () => {
  it('the three named embedding tables are the PG-only exception list', () => {
    expect([...PG_ONLY_TABLES].sort()).toEqual(['artifact_embeddings', 'memory_embeddings', 'workspace_doc_embeddings'])
  })

  it('(i) the listed tables present on the PG side leave the model: no difference', () => {
    const expected = model(SQLITE_TABLES)
    const actual = model([...SQLITE_TABLES, ...PG_ONLY_TABLES])
    expect(diffSchemas(expected, actual)).toEqual([])
  })

  it('(ii) a listed table missing on the PG side is a difference', () => {
    const expected = model(SQLITE_TABLES)
    const actual = model([...SQLITE_TABLES, ...PG_ONLY_TABLES.filter((name) => name !== 'memory_embeddings')])
    const diff = diffSchemas(expected, actual)
    expect(diff).toEqual(['PG-only table listed in PG_ONLY_TABLES is missing in PG: memory_embeddings'])
    expect(diff.join('\n')).toContain('listed in PG_ONLY_TABLES is missing')
  })

  it('(iii) an unlisted extra table on the PG side is still a difference', () => {
    const expected = model(SQLITE_TABLES)
    const actual = model([...SQLITE_TABLES, ...PG_ONLY_TABLES, 'rogue_embeddings'])
    expect(diffSchemas(expected, actual)).toEqual(['tables: only in PG: rogue_embeddings'])
  })
})

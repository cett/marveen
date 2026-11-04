// The user's text in a memory search is a literal: "%" and "_" are not wildcards and "\" is not an escape. The memory
// read fallbacks (db/memory.ts) are pinned in vector-memory-reads.test.ts; this file covers the other two searches
// over memory text: the imported-memory search and the diary / memory part of the audit log.
import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { getDb, insertImportSource, searchImportMemories, queryAuditLog } from '../db.js'
import { likeContains } from '../db/like.js'

useTestDb()

describe('likeContains', () => {
  it('escapes %, _ and the escape character, and wraps the text', () => {
    expect(likeContains('a%b_c\\d')).toBe('%a\\%b\\_c\\\\d%')
    expect(likeContains('plain')).toBe('%plain%')
  })
})

async function importRow(id: string, content: string, keywords = '', fileName = 'f.md'): Promise<void> {
  await insertImportSource({
    id: `s-${id}`, type: 'local', path: `/docs/${id}`, label: id, intervalHours: 4, enabled: true, now: 100,
    tenantId: 't', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
  })
  getDb().prepare(
    `INSERT INTO import_memories (id, source_id, file_path, file_name, content, keywords, content_hash, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, 100)`,
  ).run(id, `s-${id}`, `/docs/${id}/${fileName}`, fileName, content, keywords || null, `h-${id}`)
}

async function importSearch(q: string): Promise<{ total: number; ids: string[] }> {
  const r = await searchImportMemories(q, null, 10, 0)
  return { total: r.total, ids: (r.items as Array<{ id: string }>).map((i) => i.id).sort() }
}

describe('searchImportMemories: the query is literal', () => {
  it('"%" and "_" do not match everything; a literal one does', async () => {
    await importRow('m1', 'plain text')
    await importRow('m2', 'rate is 50% today')
    await importRow('m3', 'snake_case name', 'snake_case')
    await importRow('m4', 'back\\slash path')
    // The count and the item list are two statements with their own ESCAPE clauses: both are asserted.
    expect(await importSearch('%')).toEqual({ total: 1, ids: ['m2'] })
    expect(await importSearch('_')).toEqual({ total: 1, ids: ['m3'] })
    expect(await importSearch('\\')).toEqual({ total: 1, ids: ['m4'] })
    expect(await importSearch('50%')).toEqual({ total: 1, ids: ['m2'] })
    expect(await importSearch('e_c')).toEqual({ total: 1, ids: ['m3'] })
    expect(await importSearch('plain')).toEqual({ total: 1, ids: ['m1'] })
  })

  it('the file name is searched literally too', async () => {
    await importRow('m5', 'x', '', 'a_b.md')
    await importRow('m6', 'y', '', 'axb.md')
    expect(await importSearch('a_b')).toEqual({ total: 1, ids: ['m5'] })
  })

  // Each text below is in ONE column of ONE row (the other columns of that row do not contain it), and a decoy
  // row differs only where a wildcard would match: a column whose ESCAPE clause is missing then finds nothing
  // (the backslash stays in the pattern), in the item list and in the count alike.
  it('content only', async () => {
    await importRow('c1', 'has zz_content_only in it')
    await importRow('c2', 'has zzxcontentxonly in it')
    expect(await importSearch('zz_content_only')).toEqual({ total: 1, ids: ['c1'] })
  })

  it('keywords only', async () => {
    await importRow('k1', 'nothing here', 'kw_only')
    await importRow('k2', 'nothing here either', 'kwxonly')
    expect(await importSearch('kw_only')).toEqual({ total: 1, ids: ['k1'] })
  })

  it('file name only', async () => {
    await importRow('f1', 'nothing here', '', 'fn_only.md')
    await importRow('f2', 'nothing here either', '', 'fnxonly.md')
    expect(await importSearch('fn_only')).toEqual({ total: 1, ids: ['f1'] })
  })
})

describe('queryAuditLog (diary): the query is literal', () => {
  it('"%" and "_" do not match every diary entry or memory', async () => {
    const db = getDb()
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES ('a', '2026-11-04', 'plain entry', 100)").run()
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES ('a', '2026-11-04', 'grew 50% today', 101)").run()
    const memory = db.prepare(
      "INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, tenant_id) VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'a', 'warm', 'k', 'default')",
    )
    memory.run('plain memory', 100, 100)
    memory.run('snake_case memory', 101, 101)
    const find = async (q: string) => (await queryAuditLog({ sources: ['diary'], q, limit: 50 })).total
    expect(await find('%')).toBe(1)
    expect(await find('_')).toBe(1)
    expect(await find('plain')).toBe(2)
  })

  // The text is in the keywords column only (the content does not contain it), and a decoy differs only where a
  // wildcard would match: the keywords clause without its ESCAPE finds nothing, in the entries and in the total.
  it('a memory is found by its keywords alone, literally', async () => {
    const memory = getDb().prepare(
      "INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, tenant_id) VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'a', 'warm', ?, 'default')",
    )
    memory.run('nothing here', 100, 100, 'kw_only')
    memory.run('nothing here either', 101, 101, 'kwxonly')
    const r = await queryAuditLog({ sources: ['diary'], q: 'kw_only', limit: 50 })
    expect(r.total).toBe(1)
    expect(r.entries.map((e) => e.content)).toEqual(['nothing here'])
  })
})

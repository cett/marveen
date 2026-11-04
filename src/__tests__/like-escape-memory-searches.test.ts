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

describe('searchImportMemories: the query is literal', () => {
  it('"%" and "_" do not match everything; a literal one does', async () => {
    await importRow('m1', 'plain text')
    await importRow('m2', 'rate is 50% today')
    await importRow('m3', 'snake_case name', 'snake_case')
    await importRow('m4', 'back\\slash path')
    expect((await searchImportMemories('%', null, 10, 0)).total).toBe(1)
    expect((await searchImportMemories('_', null, 10, 0)).total).toBe(1)
    expect((await searchImportMemories('\\', null, 10, 0)).total).toBe(1)
    expect((await searchImportMemories('50%', null, 10, 0)).total).toBe(1)
    expect((await searchImportMemories('e_c', null, 10, 0)).total).toBe(1)
    expect((await searchImportMemories('plain', null, 10, 0)).total).toBe(1)
  })

  it('the file name is searched literally too', async () => {
    await importRow('m5', 'x', '', 'a_b.md')
    await importRow('m6', 'y', '', 'axb.md')
    expect((await searchImportMemories('a_b', null, 10, 0)).total).toBe(1)
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
})

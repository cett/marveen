// The memory searches on the full-text index (phase 3, c3), on both engines: prefix words AND-ed, the chat variant on the
// content only, the agent variant on content and keywords, accents folded, the tenant and the agent/shared scope in the
// SQL, and the recency invariant (of two rows with the same text the newer one ranks first). PostgreSQL only: the cells
// that pin a PostgreSQL behaviour (no fallback, a missing index is an error, the salience write leaves the index equal).
import { describe, expect, it } from 'vitest'
import { dbx, recallSearch, searchAgentMemories, searchMemories } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'

useTestDb()

const NOW = Math.floor(Date.now() / 1000)

/** One memory row; returns its id. The columns are the same on both engines. */
async function mem(p: {
  content: string; chat?: string; agent?: string; category?: string; keywords?: string | null; tenant?: string; created?: number
}): Promise<number> {
  const row = await dbx.get<{ id: number }>(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, keywords, tenant_id)
     VALUES (?, ?, 'semantic', ?, ?, ?, ?, ?, ?) RETURNING id`,
    p.chat ?? 'chat-1', p.content, p.created ?? NOW, NOW, p.agent ?? 'agent-a', p.category ?? 'warm', p.keywords ?? null, p.tenant ?? 'default',
  )
  return Number(row?.id)
}

describe('the memory search on the full-text index', () => {
  it('every typed word is a prefix and all of them must match', async () => {
    const both = await mem({ content: 'alpha beta gamma' })
    await mem({ content: 'alpha only' })
    expect((await searchMemories('alp bet', 'chat-1', 10)).map((m) => m.id)).toEqual([both])
  })

  it('the recall search answers the same prefix AND, for the agent and its shared rows', async () => {
    const own = await mem({ content: 'recall target words', agent: 'agent-a' })
    await mem({ content: 'recall target words', agent: 'agent-b' })
    const r = await recallSearch('rec tar', 'agent-a', 10)
    expect(r.memories.map((m) => m.id)).toEqual([own])
  })

  it('the chat search matches the content only; the agent search matches the keywords too', async () => {
    const kw = await mem({ content: 'plain text', keywords: 'zebra' })
    expect(await searchMemories('zebra', 'chat-1', 10)).toEqual([])
    expect((await searchAgentMemories('agent-a', 'zebra', 10)).map((m) => m.id)).toEqual([kw])
  })

  it('accents are folded: a query without them finds the accented text', async () => {
    const id = await mem({ content: 'árvíztűrő tükörfúrógép' })
    expect((await searchMemories('arvizturo', 'chat-1', 10)).map((m) => m.id)).toEqual([id])
    expect((await searchAgentMemories('agent-a', 'tukorfurogep', 10)).map((m) => m.id)).toEqual([id])
  })

  it('the scope is in the SQL: another tenant is never returned, another agent private row is not, the shared row is', async () => {
    const mine = await mem({ content: 'ripple shared-scope', agent: 'agent-a' })
    const shared = await mem({ content: 'ripple shared-scope', agent: 'agent-b', category: 'shared' })
    await mem({ content: 'ripple shared-scope', agent: 'agent-b' })
    await mem({ content: 'ripple shared-scope', agent: 'agent-a', tenant: 'tenant-b' })
    const got = (await searchAgentMemories('agent-a', 'ripple', 10, 'default')).map((m) => m.id).sort((a, b) => a - b)
    expect(got).toEqual([mine, shared].sort((a, b) => a - b))
  })

  it('of two rows with the same text the newer one ranks first (the recency blend breaks the tie)', async () => {
    const old = await mem({ content: 'echo repeated line', created: NOW - 86400 * 30 })
    const fresh = await mem({ content: 'echo repeated line', created: NOW - 60 })
    const got = (await searchMemories('echo', 'chat-1', 10)).map((m) => m.id)
    expect(got[0]).toBe(fresh)
    expect(got).toContain(old)
  })

  it('a word inside a longer word is not a hit: no LIKE fallback runs on PostgreSQL', async () => {
    await mem({ content: 'midwestern fields' })
    expect(await searchAgentMemories('agent-a', 'western', 10)).toEqual([])
  })
})

describe('PostgreSQL only: the index is a generated column, its absence is an error', () => {
  it.runIf(testDbMode() === 'pg')('the salience and access-time write leaves the index value equal', async () => {
    const id = await mem({ content: 'index stays put', keywords: 'kw' })
    const before = await dbx.get<{ f: string }>('SELECT fts::text AS f FROM memories WHERE id = ?', id)
    await dbx.run('UPDATE memories SET salience = salience * 0.9, accessed_at = ? WHERE id = ?', NOW + 5, id)
    const after = await dbx.get<{ f: string }>('SELECT fts::text AS f FROM memories WHERE id = ?', id)
    expect(after?.f).toBe(before?.f)
  })

  it.runIf(testDbMode() === 'pg')('a content update changes the index value', async () => {
    const id = await mem({ content: 'before words' })
    const before = await dbx.get<{ f: string }>('SELECT fts::text AS f FROM memories WHERE id = ?', id)
    await dbx.run("UPDATE memories SET content = 'after words' WHERE id = ?", id)
    const after = await dbx.get<{ f: string }>('SELECT fts::text AS f FROM memories WHERE id = ?', id)
    expect(after?.f).not.toBe(before?.f)
    expect((await searchMemories('after', 'chat-1', 10)).map((m) => m.id)).toEqual([id])
  })

  it.runIf(testDbMode() === 'pg')('without the fts column the search rejects (SQLite answers an empty list: the engine difference)', async () => {
    await mem({ content: 'anything here' })
    await dbx.run('ALTER TABLE memories DROP COLUMN fts')
    await expect(searchMemories('anything', 'chat-1', 10)).rejects.toThrow()
  })
})

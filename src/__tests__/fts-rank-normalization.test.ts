// The rank of a row with the same number of matches, a short text against a long one (step 6a): the short row ranks first
// on the memory searches (searchMemories, searchAgentMemories, recallSearch) and on the workspace document search. The
// long row is inserted FIRST (the lower id), so a tie would put it first: on PostgreSQL the ts_rank normalization
// (PG_RANK_NORMALIZATION) is what puts the short row first, and a query that drops or changes it fails here. SQLite
// (bm25) ranks the same pair the same way, so the cell runs on both engines.
import { describe, expect, it } from 'vitest'
import { dbx, recallSearch, searchAgentMemories, searchMemories } from '../db.js'
import { saveWorkspaceDoc, searchWorkspaceDocs } from '../db/workspace.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const NOW = Math.floor(Date.now() / 1000)
const FILLER = Array.from({ length: 40 }, () => 'kitoltes').join(' ')

async function mem(content: string): Promise<number> {
  const row = await dbx.get<{ id: number }>(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, keywords, tenant_id)
     VALUES ('chat-rank', ?, 'semantic', ?, ?, 'agent-a', 'warm', NULL, 'default') RETURNING id`,
    content, NOW, NOW,
  )
  return Number(row?.id)
}

/** One long row (lower id, inserted first) and one short row, both with the match once. */
async function insertPair(): Promise<{ longId: number; shortId: number }> {
  const longId = await mem(`rankprobe ${FILLER}`)
  const shortId = await mem('rankprobe rovid')
  return { longId, shortId }
}

describe('the short row ranks first, with the same match count, on the memory searches', () => {
  it('searchMemories (chat search) puts the short row first', async () => {
    const { longId, shortId } = await insertPair()
    const ids = (await searchMemories('rankprobe', 'chat-rank', 10)).map((m) => m.id)
    expect(ids).toEqual([shortId, longId])
  })

  it('searchAgentMemories (agent search) puts the short row first', async () => {
    const { longId, shortId } = await insertPair()
    const ids = (await searchAgentMemories('agent-a', 'rankprobe', 10)).map((m) => m.id)
    expect(ids).toEqual([shortId, longId])
  })

  it('recallSearch (recall) puts the short row first', async () => {
    const { longId, shortId } = await insertPair()
    const r = await recallSearch('rankprobe', 'agent-a', 10)
    expect(r.memories.map((m) => m.id)).toEqual([shortId, longId])
  })
})

describe('the short document ranks first, with the same match count, on the workspace search', () => {
  it('searchWorkspaceDocs puts the short document first', async () => {
    const longDoc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'rank/long', title: 'nota', content: `rankprobe ${FILLER}`,
      content_type: 'text', type: 'notes',
    })
    const shortDoc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'rank/short', title: 'nota', content: 'rankprobe rovid',
      content_type: 'text', type: 'notes',
    })
    // a tie on the rank would fall to the newer update first: make the long document the newer one, so the tie is visible
    await dbx.run('UPDATE workspace_docs SET updated_at = ? WHERE id = ?', NOW - 100, shortDoc.id)
    await dbx.run('UPDATE workspace_docs SET updated_at = ? WHERE id = ?', NOW, longDoc.id)
    const ids = (await searchWorkspaceDocs('rankprobe', { agentId: 'agent-a', tenantId: 'default', limit: 10 })).map((d) => d.id)
    expect(ids).toEqual([shortDoc.id, longDoc.id])
  })
})

// W3 (Rick): an accented query finds the unaccented and the accented spelling, on the three memory searches. The default
// unicode61 tokenizer (SQLite) and the marveen_fts configuration (PostgreSQL) both fold the accent, so both engines agree.
describe('an accented query finds both spellings, on the memory searches', () => {
  it('searchMemories, searchAgentMemories and recallSearch find szerzo and szerző with the query szerző', async () => {
    const plain = await mem('accentprobe szerzo kozlemeny')
    const accented = await mem('accentprobe szerző kozlemeny')
    const want = [plain, accented].sort((a, b) => a - b)
    const chat = (await searchMemories('szerző', 'chat-rank', 10)).map((m) => m.id).sort((a, b) => a - b)
    const agent = (await searchAgentMemories('agent-a', 'szerző', 10)).map((m) => m.id).sort((a, b) => a - b)
    const recall = (await recallSearch('szerző', 'agent-a', 10)).memories.map((m) => m.id).sort((a, b) => a - b)
    expect(chat).toEqual(want)
    expect(agent).toEqual(want)
    expect(recall).toEqual(want)
  })
})

// recallSearch (db/sessions.ts) searches daily_logs with a LIKE and, when the FTS query fails, memories with a LIKE too.
// SQLite's LIKE folds ASCII case, PostgreSQL's does not (and there the FTS table does not exist, so the LIKE fallback is
// the whole memory search): both go through likeNoCase. Upper and lower case on purpose; runs on both engines.
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, appendDailyLog, recallSearch } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

async function memory(agent: string, content: string, category = 'warm', keywords: string | null = null): Promise<void> {
  await dbx.run(
    'INSERT INTO memories (chat_id, content, sector, agent_id, category, keywords, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, 1.0, 100, 100)',
    'chat-a', content, 'semantic', agent, category, keywords,
  )
}

beforeEach(async () => {
  await dbx.run('DELETE FROM memories')
  await dbx.run('DELETE FROM daily_logs')
})

const logTexts = async (q: string, agent?: string): Promise<string[]> => (await recallSearch(q, agent)).logs.map((l) => l.content).sort()
const memTexts = async (q: string, agent?: string): Promise<string[]> => (await recallSearch(q, agent)).memories.map((m) => m.content).sort()

describe('recallSearch: the diary part ignores ASCII case', () => {
  it('finds a log in a different case, both ways', async () => {
    await appendDailyLog('agent-a', 'Deploy DONE today')
    await appendDailyLog('agent-a', 'plain note')
    expect(await logTexts('done')).toEqual(['Deploy DONE today'])
    expect(await logTexts('DEPLOY done TODAY')).toEqual(['Deploy DONE today'])
    expect(await logTexts('deploy today')).toEqual([])            // a phrase is one substring: the words are not split
    expect(await logTexts('PLAIN')).toEqual(['plain note'])
  })

  it('does not fold non-ASCII: O-double-acute is not o-double-acute', async () => {
    await appendDailyLog('agent-a', 'Őra check')
    expect(await logTexts('őra')).toEqual([])
    expect(await logTexts('Őra')).toEqual(['Őra check'])
  })

  it('a % or _ in the query is a literal, and the agent scope still holds', async () => {
    await appendDailyLog('agent-a', 'rate 50% today')
    await appendDailyLog('agent-a', 'snake_Case name')
    await appendDailyLog('agent-b', 'rate 50% elsewhere')
    expect(await logTexts('%')).toEqual(['rate 50% elsewhere', 'rate 50% today'])
    expect(await logTexts('%', 'agent-a')).toEqual(['rate 50% today'])
    expect(await logTexts('E_C')).toEqual(['snake_Case name'])
    expect(await logTexts('e_x')).toEqual([])
  })
})

describe('recallSearch: the memory part ignores ASCII case', () => {
  it('finds a memory in a different case, both ways, and keeps the agent scope', async () => {
    await memory('agent-a', 'Needle in the Haystack')
    await memory('agent-b', 'needle of another agent')
    await memory('agent-b', 'shared NEEDLE note', 'shared')
    expect(await memTexts('NEEDLE', 'agent-a')).toEqual(['Needle in the Haystack', 'shared NEEDLE note'])
    expect(await memTexts('needle')).toEqual(['Needle in the Haystack', 'needle of another agent', 'shared NEEDLE note'])
    expect(await memTexts('hAyStAcK', 'agent-a')).toEqual(['Needle in the Haystack'])
  })

  it('the keywords column is searched ignoring case too', async () => {
    await memory('agent-a', 'unrelated body', 'warm', 'Zeta,Omega')
    expect(await memTexts('ZETA', 'agent-a')).toEqual(['unrelated body'])
    expect(await memTexts('omega')).toEqual(['unrelated body'])
  })
})

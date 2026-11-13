// recallSearch (db/sessions.ts) searches daily_logs with a LIKE and, when the FTS query fails, memories with a LIKE too.
// SQLite's LIKE folds ASCII case, PostgreSQL's does not (and there the FTS table does not exist, so the LIKE fallback is
// the whole memory search): both go through likeNoCase. Upper and lower case on purpose; runs on both engines.
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, appendDailyLog, recallSearch } from '../db.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'

useTestDb()

async function memory(agent: string, content: string, category = 'warm', keywords: string | null = null, tenant = 't-a'): Promise<void> {
  await dbx.run(
    'INSERT INTO memories (chat_id, content, sector, agent_id, category, keywords, tenant_id, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 100, 100)',
    'chat-a', content, 'semantic', agent, category, keywords, tenant,
  )
}

/**
 * Makes the memory part of recallSearch run its LIKE fallback on BOTH engines. On PostgreSQL the FTS table does not
 * exist, so the first (FTS) query fails and the fallback answers. On SQLite the FTS query would succeed and answer, and
 * the LIKE statement would never run: so after the rows are seeded the FTS table is dropped, and the same query fails
 * the same way. Call it AFTER seeding (the insert trigger writes to the FTS table).
 */
async function forceLikeFallback(): Promise<void> {
  if (testDbMode() === 'sqlite') await dbx.run('DROP TABLE memories_fts')
}

beforeEach(async () => {
  await dbx.run('DELETE FROM memories')
  await dbx.run('DELETE FROM daily_logs')
})

const logTexts = async (q: string, agent?: string): Promise<string[]> => (await recallSearch(q, agent)).logs.map((l) => l.content).sort()
const memTexts = async (q: string, agent?: string, tenant?: string): Promise<string[]> =>
  (await recallSearch(q, agent, 50, tenant)).memories.map((m) => m.content).sort()

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
    await forceLikeFallback()
    expect(await memTexts('NEEDLE', 'agent-a')).toEqual(['Needle in the Haystack', 'shared NEEDLE note'])
    expect(await memTexts('needle')).toEqual(['Needle in the Haystack', 'needle of another agent', 'shared NEEDLE note'])
    expect(await memTexts('hAyStAcK', 'agent-a')).toEqual(['Needle in the Haystack'])
  })

  it('the keywords column is searched ignoring case too', async () => {
    await memory('agent-a', 'unrelated body', 'warm', 'Zeta,Omega')
    await forceLikeFallback()
    expect(await memTexts('ZETA', 'agent-a')).toEqual(['unrelated body'])
    expect(await memTexts('omega')).toEqual(['unrelated body'])
  })

  it('does not fold non-ASCII in the content or in the keywords (LIKE against LIKE, FTS is out of the picture)', async () => {
    await memory('agent-a', 'Őra jegyzet')
    await memory('agent-a', 'body two', 'warm', 'Ékezet')
    await forceLikeFallback()
    expect(await memTexts('őra', 'agent-a')).toEqual([])
    expect(await memTexts('Őra', 'agent-a')).toEqual(['Őra jegyzet'])
    expect(await memTexts('ékezet', 'agent-a')).toEqual([])
    expect(await memTexts('Ékezet', 'agent-a')).toEqual(['body two'])
  })

  it('a % or _ in the query is a literal in content and keywords: the search text is empty for FTS, so use a term with a letter', async () => {
    await memory('agent-a', 'snake_Case body')
    await memory('agent-a', 'snakeXcase body')
    await memory('agent-a', 'plain', 'warm', 'key_Word')
    await memory('agent-a', 'plain two', 'warm', 'keyXword')
    await forceLikeFallback()
    expect(await memTexts('E_C', 'agent-a')).toEqual(['snake_Case body'])
    expect(await memTexts('Y_W', 'agent-a')).toEqual(['plain'])
  })

  // The scope, the tenant and the text match are ONE condition each: (own agent OR shared) AND (content OR keywords) AND
  // tenant. Without the parentheses around the text match the OR would swallow the scope and the tenant, and a row of
  // ANOTHER agent (not shared), whose content does not match but whose KEYWORDS do, would come back.
  it('the scope and the tenant hold when only the keywords column matches', async () => {
    await memory('agent-a', 'own body', 'warm', 'Zzkeyonly')                          // own, matches by keywords
    await memory('agent-b', 'foreign body', 'warm', 'Zzkeyonly')                      // another agent, not shared: must NOT come back
    await memory('agent-b', 'shared body', 'shared', 'Zzkeyonly')                     // another agent but shared: comes back
    await memory('agent-a', 'other tenant body', 'warm', 'Zzkeyonly', 't-b')          // same agent, another tenant: must NOT come back
    await memory('agent-b', 'other tenant shared', 'shared', 'Zzkeyonly', 't-b')      // shared, another tenant: must NOT come back
    await forceLikeFallback()
    expect(await memTexts('zzkeyonly', 'agent-a', 't-a')).toEqual(['own body', 'shared body'])
    expect(await memTexts('ZZKEYONLY', 'agent-a', 't-b')).toEqual(['other tenant body', 'other tenant shared'])
    expect(await memTexts('zzkeyonly', 'agent-a')).toEqual(['other tenant body', 'other tenant shared', 'own body', 'shared body'])
    // no agent given: the tenant alone narrows, the keywords-only match of another tenant must not come back
    expect(await memTexts('zzkeyonly', undefined, 't-a')).toEqual(['foreign body', 'own body', 'shared body'])
  })

  it('the same holds when only the content matches', async () => {
    await memory('agent-a', 'Zzcontentonly own')
    await memory('agent-b', 'Zzcontentonly foreign')
    await memory('agent-a', 'Zzcontentonly other tenant', 'warm', null, 't-b')
    await forceLikeFallback()
    expect(await memTexts('zzcontentonly', 'agent-a', 't-a')).toEqual(['Zzcontentonly own'])
    expect(await memTexts('zzcontentonly', undefined, 't-a')).toEqual(['Zzcontentonly foreign', 'Zzcontentonly own'])
  })
})

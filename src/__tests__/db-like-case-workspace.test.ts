// The doc_key prefix filter of the workspace documents (db/workspace.ts, workspaceDocsWhere: listWorkspaceDocs,
// countWorkspaceDocs and the search page share it) is a LIKE on '<prefix>%'. SQLite's LIKE folds ASCII case,
// PostgreSQL's does not: it goes through likeNoCase. Upper and lower case on purpose; runs on both engines (useTestDb).
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, saveWorkspaceDoc, listWorkspaceDocs, countWorkspaceDocs } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(async () => {
  await dbx.run('DELETE FROM workspace_docs')
})

async function doc(agent: string, docKey: string): Promise<void> {
  await saveWorkspaceDoc({
    agent_id: agent, tenant_id: 't-a', doc_key: docKey, title: docKey, content: `body of ${docKey}`,
    content_type: 'text', type: 'notes',
  })
}

const keys = async (docKeyPrefix: string, tenantId?: string): Promise<string[]> =>
  (await listWorkspaceDocs({ docKeyPrefix, tenantId })).map((d) => d.doc_key as string).sort()

describe('workspace doc_key prefix ignores ASCII case, in the list and in the count', () => {
  it('finds a lower-case key with an upper-case prefix, an upper-case key with a lower-case prefix, and a mixed one', async () => {
    await doc('agent-a', 'notes/one')
    await doc('agent-a', 'Notes/Two')
    await doc('agent-a', 'plans/three')
    expect(await keys('NOTES/')).toEqual(['Notes/Two', 'notes/one'])
    expect(await keys('notes/')).toEqual(['Notes/Two', 'notes/one'])
    expect(await keys('nOtEs/t')).toEqual(['Notes/Two'])
    expect(await countWorkspaceDocs({ docKeyPrefix: 'NOTES/' })).toBe(2)
    expect(await countWorkspaceDocs({ docKeyPrefix: 'PLANS' })).toBe(1)
  })

  it('does not fold non-ASCII (the two engines agree): O-double-acute is not o-double-acute', async () => {
    await doc('agent-a', 'Őra/x')
    expect(await keys('őra')).toEqual([])
    expect(await keys('Őra')).toEqual(['Őra/x'])
    expect(await countWorkspaceDocs({ docKeyPrefix: 'őRA' })).toBe(0)
  })

  it('a % or _ in the prefix is a literal, and only a PREFIX matches', async () => {
    await doc('agent-a', 'a_b/x')
    await doc('agent-a', 'axb/x')
    await doc('agent-a', 'b%/x')
    await doc('agent-a', 'bzz/x')
    await doc('agent-a', 'z/a_b')
    expect(await keys('A_')).toEqual(['a_b/x'])
    expect(await keys('B%')).toEqual(['b%/x'])
    expect(await countWorkspaceDocs({ docKeyPrefix: 'a_' })).toBe(1)
    expect(await keys('_b')).toEqual([])                       // inside a key, not at its start
  })

  it('narrows together with the agent and tenant filters, and an exact doc_key still wins over the prefix', async () => {
    await doc('agent-a', 'Notes/x')
    await doc('agent-b', 'notes/y')
    expect(await listWorkspaceDocs({ docKeyPrefix: 'NOTES/', agentId: 'agent-a' }).then((r) => r.map((d) => d.doc_key))).toEqual(['Notes/x'])
    expect(await keys('NOTES/', 'other-tenant')).toEqual([])
    expect(await listWorkspaceDocs({ docKey: 'notes/y', docKeyPrefix: 'zzz' }).then((r) => r.map((d) => d.doc_key))).toEqual(['notes/y'])
  })
})

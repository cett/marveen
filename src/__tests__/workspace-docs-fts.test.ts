/**
 * FTS5 search over workspace_docs (migration 0040, kanban 9156e583).
 * Tenant isolation is the critical property under test here per the
 * explicit requirement: search is tenant-scoped, and no row may ever cross
 * a tenant boundary -- see searchWorkspaceDocs's own doc comment.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { saveWorkspaceDoc, searchWorkspaceDocs } from '../workspace-store.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().prepare('DELETE FROM workspace_docs').run()
})

function seed(overrides: Partial<Parameters<typeof saveWorkspaceDoc>[0]> = {}) {
  return saveWorkspaceDoc({
    agent_id: 'agent-a', tenant_id: 'tenant-a', doc_key: null,
    title: 'Budget plafon terv', content: 'The BudgetEntry amount is measured in tokens not HUF',
    content_type: 'text', type: 'plan', task_ref: '670b6218',
    ...overrides,
  })
}

describe('searchWorkspaceDocs -- tenant isolation (critical)', () => {
  it('a tenant-scoped search never returns another tenant\'s doc, even on an exact title/content match', () => {
    seed({ tenant_id: 'tenant-a', title: 'Secret tenant-a plan', content: 'contains the word unicornfish' })
    seed({ tenant_id: 'tenant-b', title: 'Secret tenant-b plan', content: 'also contains the word unicornfish' })

    const resultsA = searchWorkspaceDocs('unicornfish', { tenantId: 'tenant-a', limit: 50 })
    expect(resultsA).toHaveLength(1)
    expect(resultsA[0].tenant_id).toBe('tenant-a')

    const resultsB = searchWorkspaceDocs('unicornfish', { tenantId: 'tenant-b', limit: 50 })
    expect(resultsB).toHaveLength(1)
    expect(resultsB[0].tenant_id).toBe('tenant-b')
  })

  it('fleet-scoped (tenant_id="default") and tenant-a docs never cross when both are searched with an explicit tenantId', () => {
    seed({ tenant_id: 'default', title: 'Fleet doc', content: 'mentions crossoverterm' })
    seed({ tenant_id: 'tenant-a', title: 'Tenant doc', content: 'mentions crossoverterm' })

    const fleetOnly = searchWorkspaceDocs('crossoverterm', { tenantId: 'default', limit: 50 })
    expect(fleetOnly).toHaveLength(1)
    expect(fleetOnly[0].tenant_id).toBe('default')

    const tenantOnly = searchWorkspaceDocs('crossoverterm', { tenantId: 'tenant-a', limit: 50 })
    expect(tenantOnly).toHaveLength(1)
    expect(tenantOnly[0].tenant_id).toBe('tenant-a')
  })

  it('an undefined tenantId (admin, no ?tenant= filter) sees every tenant -- by design, not a leak', () => {
    seed({ tenant_id: 'tenant-a', title: 'A', content: 'mentions adminviewterm' })
    seed({ tenant_id: 'tenant-b', title: 'B', content: 'mentions adminviewterm' })

    const results = searchWorkspaceDocs('adminviewterm', { limit: 50 })
    expect(results.map(r => r.tenant_id).sort()).toEqual(['tenant-a', 'tenant-b'])
  })
})

describe('searchWorkspaceDocs -- content matching', () => {
  it('matches on title as well as content', () => {
    seed({ title: 'Uniquetitleword here', content: 'unrelated body text' })
    const results = searchWorkspaceDocs('Uniquetitleword', { tenantId: 'tenant-a', limit: 50 })
    expect(results).toHaveLength(1)
  })

  it('excludes binary docs from content matching but still matches their title', () => {
    seed({ content_type: 'binary', content: null, title: 'Findable binary attachment name' })
    const byContent = searchWorkspaceDocs('BudgetEntry', { tenantId: 'tenant-a', limit: 50 })
    expect(byContent).toHaveLength(0)
    const byTitle = searchWorkspaceDocs('Findable', { tenantId: 'tenant-a', limit: 50 })
    expect(byTitle).toHaveLength(1)
  })

  it('includes code-type docs in content matching (not just text)', () => {
    seed({ content_type: 'code', type: 'notes', content: 'function computeUniqueFooBar() {}' })
    const results = searchWorkspaceDocs('computeUniqueFooBar', { tenantId: 'tenant-a', limit: 50 })
    expect(results).toHaveLength(1)
  })

  it('filters by agentId when given', () => {
    seed({ agent_id: 'agent-a', content: 'mentions filterbyagentterm' })
    seed({ agent_id: 'agent-b', content: 'also mentions filterbyagentterm' })
    const results = searchWorkspaceDocs('filterbyagentterm', { tenantId: 'tenant-a', agentId: 'agent-b', limit: 50 })
    expect(results).toHaveLength(1)
    expect(results[0].agent_id).toBe('agent-b')
  })

  it('returns a snippet with match highlighting', () => {
    seed({ content: 'a long sentence containing the distinctivesnippetterm somewhere in the middle' })
    const results = searchWorkspaceDocs('distinctivesnippetterm', { tenantId: 'tenant-a', limit: 50 })
    expect(results[0].snippet).toContain('[distinctivesnippetterm]')
  })

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) seed({ doc_key: `k${i}`, content: 'mentions limittestterm here' })
    const results = searchWorkspaceDocs('limittestterm', { tenantId: 'tenant-a', limit: 2 })
    expect(results).toHaveLength(2)
  })

  it('escapes FTS5 special characters in the query so they do not throw a syntax error', () => {
    seed({ content: 'mentions weird "quoted" content' })
    expect(() => searchWorkspaceDocs('AND OR NOT "unterminated', { tenantId: 'tenant-a', limit: 50 })).not.toThrow()
  })

  it('returns no results (not an error) when nothing matches', () => {
    seed()
    expect(searchWorkspaceDocs('nonexistentxyzterm', { tenantId: 'tenant-a', limit: 50 })).toEqual([])
  })
})

describe('workspace_docs_fts sync triggers', () => {
  it('an update that changes content_type from text to binary removes it from the content index', () => {
    const doc = seed({ content: 'mentions transitiontestterm' })
    getDb().prepare("UPDATE workspace_docs SET content_type = 'binary', content = NULL WHERE id = ?").run(doc.id)
    const results = searchWorkspaceDocs('transitiontestterm', { tenantId: 'tenant-a', limit: 50 })
    expect(results).toHaveLength(0)
  })

  it('an update that changes content_type from binary to text adds it to the content index', () => {
    const doc = seed({ content_type: 'binary', content: null })
    getDb().prepare("UPDATE workspace_docs SET content_type = 'text', content = 'now mentions reversetransitionterm' WHERE id = ?").run(doc.id)
    const results = searchWorkspaceDocs('reversetransitionterm', { tenantId: 'tenant-a', limit: 50 })
    expect(results).toHaveLength(1)
  })

  it('deleting a doc removes it from search results and leaves the FTS index consistent', () => {
    const doc = seed({ content: 'mentions deletioncheckterm' })
    getDb().prepare('DELETE FROM workspace_docs WHERE id = ?').run(doc.id)
    const results = searchWorkspaceDocs('deletioncheckterm', { tenantId: 'tenant-a', limit: 50 })
    expect(results).toHaveLength(0)
    const integrity = getDb().pragma('integrity_check') as Array<{ integrity_check: string }>
    expect(integrity[0].integrity_check).toBe('ok')
  })

  it('updating and then deleting a doc that was never content-indexed (binary, untouched) does not corrupt the FTS shadow tables', () => {
    const doc = seed({ content_type: 'binary', content: null, title: 'Binary A' })
    getDb().prepare("UPDATE workspace_docs SET title = 'Binary A renamed' WHERE id = ?").run(doc.id)
    getDb().prepare('DELETE FROM workspace_docs WHERE id = ?').run(doc.id)
    const integrity = getDb().pragma('integrity_check') as Array<{ integrity_check: string }>
    expect(integrity[0].integrity_check).toBe('ok')
  })

  it('an edit to content is reflected in search (old term no longer matches, new term does)', () => {
    const doc = seed({ content: 'the original oldtermxyz phrase' })
    getDb().prepare("UPDATE workspace_docs SET content = 'the updated newtermxyz phrase' WHERE id = ?").run(doc.id)
    expect(searchWorkspaceDocs('oldtermxyz', { tenantId: 'tenant-a', limit: 50 })).toHaveLength(0)
    expect(searchWorkspaceDocs('newtermxyz', { tenantId: 'tenant-a', limit: 50 })).toHaveLength(1)
  })
})

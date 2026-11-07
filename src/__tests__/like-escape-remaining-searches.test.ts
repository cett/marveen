// The user's text in a search is a literal: "%" and "_" are not wildcards and "\" is not an escape. The memory searches are
// pinned in like-escape-memory-searches.test.ts; this file covers the other searches that build a LIKE pattern from a
// caller's text: the kanban search, the approvals filter, the workspace doc_key prefix, the token-usage search, the
// kanban correlation of token usage and the audit-log search.
//
// Every column test follows the same shape: ONE row holds the text in the one column under test (the other columns of
// the row do not contain it) and a decoy row differs only where a wildcard would match. A column whose ESCAPE clause is
// missing finds nothing (the backslash stays in the pattern); a column whose pattern is not escaped also finds the decoy.
import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  getDb, createKanbanCard, searchKanbanCards, createApproval, listApprovals, countApprovals,
  saveWorkspaceDoc, listWorkspaceDocs, countWorkspaceDocs, getTokenDetails, correlateWithKanban,
  queryAuditLog, createTenant, createSkill, listAgentOwnedSkills,
} from '../db.js'
import { likeContains, likePrefix } from '../db/like.js'

useTestDb()

const HIT = 'has zz_only'
const DECOY = 'has zzXonly'
const Q = 'zz_only'
const NOW = 1_800_000_000

describe('likePrefix', () => {
  it('escapes %, _ and the escape character with the same escape as likeContains, and ends in a wildcard', () => {
    expect(likePrefix('a%b_c\\d')).toBe('a\\%b\\_c\\\\d%')
    expect(likePrefix('notes/checkpoint-')).toBe('notes/checkpoint-%')
    expect(likePrefix('')).toBe('%')
    // one escape implementation: the prefix pattern is the contains pattern without its leading wildcard
    for (const text of ['x', '%', '_', '\\', 'a_b%c\\']) expect(likeContains(text)).toBe(`%${likePrefix(text)}`)
  })
})

describe('searchKanbanCards: the query is literal', () => {
  const find = async (q: string, tenantId?: string | null) => (await searchKanbanCards({ q, tenantId })).map((c) => c.id).sort()

  it.each(['title', 'project', 'assignee'] as const)('the %s column is searched literally', async (column) => {
    await createKanbanCard({ id: 'hit', title: column === 'title' ? HIT : 'n', ...(column === 'title' ? {} : { [column]: HIT }) })
    await createKanbanCard({ id: 'decoy', title: column === 'title' ? DECOY : 'n', ...(column === 'title' ? {} : { [column]: DECOY }) })
    expect(await find(Q)).toEqual(['hit'])
  })

  it('"%", "_" and "\\" are not wildcards, a literal one is found', async () => {
    await createKanbanCard({ id: 'c1', title: 'plain card' })
    await createKanbanCard({ id: 'c2', title: 'rate is 85% now' })
    await createKanbanCard({ id: 'c3', title: 'DB schema: owner_id field' })
    await createKanbanCard({ id: 'c4', title: 'path a\\b card' })
    expect(await find('%')).toEqual(['c2'])
    expect(await find('_')).toEqual(['c3'])
    expect(await find('\\')).toEqual(['c4'])
    expect(await find('85%')).toEqual(['c2'])
    expect(await find('owner_id')).toEqual(['c3'])
    expect(await find('plain')).toEqual(['c1'])
  })

  it('the row-number and the hex-id branches are unchanged', async () => {
    await createKanbanCard({ id: 'abcd1234', title: 'by id' })
    await createKanbanCard({ id: 'zzzz9999', title: 'second' })
    const seq = (await searchKanbanCards({ q: 'by id' }))[0]!.seq
    expect((await searchKanbanCards({ q: `#${seq}` })).map((c) => c.id)).toEqual(['abcd1234'])
    expect((await searchKanbanCards({ q: 'abcd' })).map((c) => c.id)).toEqual(['abcd1234'])
    expect((await searchKanbanCards({ q: 'abc' })).map((c) => c.id)).toEqual([])
  })

  // The GLOB guard of the id-prefix branch only checks the first character, so "ab_d" and "abc%" pass it: the prefix pattern
  // itself must be literal. Fixture ids are hex-like on purpose (the decoy is a real hex id the wildcard would hit).
  it('the id-prefix branch is literal: a "_" or "%" after the first character is no wildcard', async () => {
    await createKanbanCard({ id: 'abcd1234', title: 'plain one' })
    await createKanbanCard({ id: 'abcdef00', title: 'plain two' })
    await createKanbanCard({ id: 'ab_d9999', title: 'literal underscore id' })
    await createKanbanCard({ id: 'ab%d8888', title: 'literal percent id' })
    expect(await find('ab_d')).toEqual(['ab_d9999'])
    expect(await find('ab%d')).toEqual(['ab%d8888'])
    expect(await find('abcd')).toEqual(['abcd1234', 'abcdef00'])
    expect(await find('abcd12')).toEqual(['abcd1234'])
  })

  it('the search stays in the caller tenant', async () => {
    await createTenant('tenant-x', 'Tenant X')
    await createKanbanCard({ id: 'own', title: HIT, tenant_id: 'tenant-x' })
    await createKanbanCard({ id: 'other', title: HIT })
    expect(await find(Q, 'tenant-x')).toEqual(['own'])
    expect(await find(Q, null)).toEqual(['other', 'own'])
  })
})

describe('the approvals filter: agent_id and category are literal substrings', () => {
  async function approval(id: string, agent_id: string, category: string): Promise<void> {
    await createApproval({ id, agent_id, category, action_description: 'n' })
  }
  const ids = async (opts: { agent_id?: string; category?: string }) => (await listApprovals(opts)).map((a) => a.id).sort()

  it.each(['agent_id', 'category'] as const)('%s is matched literally, in the list and in the count', async (column) => {
    await approval('hit', column === 'agent_id' ? HIT : 'agent-a', column === 'category' ? HIT : 'cat-a')
    await approval('decoy', column === 'agent_id' ? DECOY : 'agent-a', column === 'category' ? DECOY : 'cat-a')
    expect(await ids({ [column]: Q })).toEqual(['hit'])
    expect(await countApprovals({ [column]: Q })).toBe(1)
  })

  it('a category filter of "kanban_archive" does not match another letter in place of the underscore; "%" and "\\" are literal', async () => {
    await approval('a1', 'agent-a', 'kanban_archive_done')
    await approval('a2', 'agent-a', 'kanbanXarchive_done')
    await approval('a3', 'agent-a', 'rate_50%_cap')
    await approval('a4', 'agent-a', 'back\\slash')
    expect(await ids({ category: 'kanban_archive' })).toEqual(['a1'])
    expect(await ids({ category: '%' })).toEqual(['a3'])
    expect(await ids({ category: '\\' })).toEqual(['a4'])
    expect(await countApprovals({ category: '%' })).toBe(1)
    expect(await ids({ category: 'archive' })).toEqual(['a1', 'a2'])
  })
})

describe('the workspace doc_key prefix is literal', () => {
  async function doc(doc_key: string, tenant_id = 'default'): Promise<void> {
    await saveWorkspaceDoc({ agent_id: 'agent-a', tenant_id, doc_key, title: 't', content: 'c', content_type: 'text', type: 'notes' })
  }
  const keys = async (docKeyPrefix: string, tenantId?: string) => (await listWorkspaceDocs({ docKeyPrefix, tenantId })).map((d) => d.doc_key).sort()

  it('"_" and "%" in the prefix match themselves; the count agrees with the list', async () => {
    await doc('a_1/x')
    await doc('aX1/y')
    await doc('b%1/z')
    await doc('bQ1/w')
    expect(await keys('a_')).toEqual(['a_1/x'])
    expect(await keys('b%')).toEqual(['b%1/z'])
    expect(await keys('a')).toEqual(['aX1/y', 'a_1/x'])
    expect(await countWorkspaceDocs({ docKeyPrefix: 'a_' })).toBe(1)
    expect(await countWorkspaceDocs({ docKeyPrefix: 'b%' })).toBe(1)
  })

  it('"\\" in the prefix is literal; a prefix is a prefix, not a substring; the usual prefixes still list', async () => {
    await doc('c\\1/x')
    await doc('notes/checkpoint-a')
    await doc('notes/checkpoint-b')
    await doc('brief/notes/checkpoint-c')
    expect(await keys('c\\')).toEqual(['c\\1/x'])
    expect(await keys('notes/checkpoint-')).toEqual(['notes/checkpoint-a', 'notes/checkpoint-b'])
  })

  it('an empty prefix is no prefix filter (as before); the tenant filter still applies', async () => {
    await createTenant('tenant-x', 'Tenant X')
    await doc('k_1', 'tenant-x')
    await doc('k_2')
    expect((await listWorkspaceDocs({ docKeyPrefix: '' })).length).toBe(2)
    expect(await keys('k_', 'tenant-x')).toEqual(['k_1'])
  })
})

describe('listAgentOwnedSkills: the agent id is a literal prefix', () => {
  async function skill(id: string): Promise<void> {
    await createSkill({ id, name: id.replace(/\//g, '-'), content: 'c', tenant_id: 'default' }, { kind: 'system', id: null })
  }
  const ids = async (agentId: string) => (await listAgentOwnedSkills(agentId)).map((s) => s.id).sort()

  it('an agent id with "_" does not list the skills of the agent that differs only where "_" would match', async () => {
    await skill('agent/a_b/own-skill')
    await skill('agent/aXb/other-skill')
    expect(await ids('a_b')).toEqual(['agent/a_b/own-skill'])
    expect(await ids('aXb')).toEqual(['agent/aXb/other-skill'])
  })

  it('a plain agent id lists its own skills only, and not those of an id it is a prefix of', async () => {
    await skill('agent/agent-a/one')
    await skill('agent/agent-a/two')
    await skill('agent/agent-ab/three')
    expect(await ids('agent-a')).toEqual(['agent/agent-a/one', 'agent/agent-a/two'])
  })
})

describe('getTokenDetails: the q search is literal', () => {
  let n = 0
  function usage(cols: Record<string, string>): void {
    n++
    getDb().prepare(
      'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tool_name, content_preview, task_title) VALUES (?, ?, ?, 1, 1, ?, ?, ?)',
    ).run(cols.agent ?? 'agent-a', `s${n}`, NOW + n, cols.tool_name ?? null, cols.content_preview ?? null, cols.task_title ?? null)
  }
  const found = async (q: string) => (await getTokenDetails({ q })).map((r) => r.id).sort((a, b) => a - b)

  it.each(['agent', 'tool_name', 'content_preview', 'task_title'])('the %s column is searched literally', async (column) => {
    usage({ [column]: HIT })
    usage({ [column]: DECOY })
    expect(await found(Q)).toHaveLength(1)
    const hit = (await getTokenDetails({ q: Q }))[0]!
    expect(JSON.stringify(hit)).toContain(HIT)
  })

  it('"%" and "\\" are literal', async () => {
    usage({ content_preview: 'plain' })
    usage({ content_preview: 'used 60% of it' })
    usage({ content_preview: 'dir a\\b' })
    expect(await found('%')).toHaveLength(1)
    expect(await found('\\')).toHaveLength(1)
    expect(await found('plain')).toHaveLength(1)
  })
})

describe('correlateWithKanban: an agent name is matched literally in the assignee', () => {
  function usageAt(agent: string, ts: number): void {
    getDb().prepare('INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES (?, ?, ?, 1, 1)').run(agent, `s-${agent}`, ts)
  }
  async function card(id: string, assignee: string, title: string, ts: number): Promise<void> {
    await createKanbanCard({ id, title, assignee })
    getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(ts, id)
  }
  const titleOfUsage = (agent: string) => (getDb().prepare('SELECT task_title FROM token_usage WHERE agent = ?').get(agent) as { task_title: string | null }).task_title

  it('the usage of "agent_a" is not labelled with the card of an assignee that differs only where "_" would match', async () => {
    usageAt('agent_a', NOW)
    await card('decoy', 'agentXa', 'Other agent card', NOW)
    await correlateWithKanban()
    expect(titleOfUsage('agent_a')).toBeNull()
  })

  it('an assignee list that contains the agent name still labels the usage (substring semantics kept)', async () => {
    usageAt('agent_a', NOW)
    await card('hit', 'agent-b,agent_a', 'Right card', NOW)
    await correlateWithKanban()
    expect(titleOfUsage('agent_a')).toBe('Right card')
  })

  it('an exact assignee still labels the usage', async () => {
    usageAt('agent-c', NOW)
    await card('exact', 'agent-c', 'Exact card', NOW)
    await correlateWithKanban()
    expect(titleOfUsage('agent-c')).toBe('Exact card')
  })
})

describe('queryAuditLog: every source searches the query literally, per column', () => {
  let n = 0
  const nextId = () => `r${++n}`
  const q = async (source: 'config' | 'idea' | 'store' | 'agent' | 'hook', text: string) => queryAuditLog({ sources: [source], q: text, limit: 50 })

  const CONFIG = ['key', 'old_value', 'new_value', 'actor']
  it.each(CONFIG)('config_change_log.%s', async (column) => {
    const insert = (v: string) => getDb().prepare('INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(...(['key', 'old_value', 'new_value', 'actor'].map((c) => (c === column ? v : 'n'))), NOW)
    insert(HIT); insert(DECOY)
    const r = await q('config', Q)
    expect(r.total).toBe(1)
    expect(r.entries).toHaveLength(1)
  })

  const IDEA = ['idea_id', 'to_status', 'note', 'actor']
  it.each(IDEA)('idea_status_log.%s', async (column) => {
    const insert = (v: string) => getDb().prepare('INSERT INTO idea_status_log (idea_id, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(...(['idea_id', 'to_status', 'note', 'actor'].map((c) => (c === column ? v : 'n'))), NOW)
    insert(HIT); insert(DECOY)
    const r = await q('idea', Q)
    expect(r.total).toBe(1)
    expect(r.entries).toHaveLength(1)
  })

  it.each(['rel_path', 'agent'])('store_file_audit.%s', async (column) => {
    const insert = (v: string) => getDb().prepare("INSERT INTO store_file_audit (rel_path, event_type, agent, created_at) VALUES (?, 'write', ?, ?)")
      .run(column === 'rel_path' ? v : 'n', column === 'agent' ? v : 'n', NOW)
    insert(HIT); insert(DECOY)
    const r = await q('store', Q)
    expect(r.total).toBe(1)
    expect(r.entries).toHaveLength(1)
  })

  it.each(['agent_id', 'entity', 'action', 'detail'])('agent_audit_log.%s', async (column) => {
    const insert = (v: string) => getDb().prepare('INSERT INTO agent_audit_log (agent_id, entity, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(...(['agent_id', 'entity', 'action', 'detail'].map((c) => (c === column ? v : 'n'))), NOW)
    insert(HIT); insert(DECOY)
    const r = await q('agent', Q)
    expect(r.total).toBe(1)
    expect(r.entries).toHaveLength(1)
  })

  it.each(['agent_id', 'hook_type', 'verdict', 'tool_name', 'reason'])('hook_audit_log.%s', async (column) => {
    const insert = (v: string) => getDb().prepare('INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(NOW, ...(['agent_id', 'hook_type', 'verdict', 'tool_name', 'reason'].map((c) => (c === column ? v : 'n'))))
    insert(HIT); insert(DECOY)
    const r = await q('hook', Q)
    expect(r.total).toBe(1)
    expect(r.entries).toHaveLength(1)
  })

  it('"%" and "\\" are literal in a source (the agent audit log), and a plain word still matches', async () => {
    const insert = (detail: string) => getDb().prepare("INSERT INTO agent_audit_log (agent_id, entity, action, detail, created_at) VALUES ('agent-a', 'memory', 'create', ?, ?)").run(detail, NOW)
    insert('plain'); insert('60% done'); insert('a\\b')
    expect((await q('agent', '%')).total).toBe(1)
    expect((await q('agent', '\\')).total).toBe(1)
    expect((await q('agent', 'plain')).total).toBe(1)
    void nextId
  })
})

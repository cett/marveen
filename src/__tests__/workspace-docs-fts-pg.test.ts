// The workspace document search on the full-text index (phase 3, c5), on both engines: every word of the list search is
// required, the phrase search takes the whole text, the tenant and agent scope is in the SQL (a tenant never sees another
// tenant's document), a binary document is found by its title only, the title and the content are not one phrase, the
// snippet marks the hit words and is NULL-tolerant. The 300000-character cap is a named PostgreSQL divergence.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dbx, saveWorkspaceDoc, searchWorkspaceDocs, searchWorkspaceDocsPage } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'

useTestDb()

const doc = (p: { title: string; content?: string; tenant?: string; agent?: string; binary?: boolean; key?: string }) =>
  saveWorkspaceDoc({
    agent_id: p.agent ?? 'agent-a', tenant_id: p.tenant ?? 'default', title: p.title, doc_key: p.key ?? null,
    content: p.binary ? null : (p.content ?? ''), content_blob: p.binary ? Buffer.from([1, 2, 3]) : null,
    content_type: p.binary ? 'binary' : 'text', type: 'plan',
  })

const ids = async (q: string, filter: { tenantId?: string | null; agentId?: string } = {}): Promise<string[]> =>
  (await searchWorkspaceDocsPage(q, { tenantId: 'default', ...filter, limit: 50 })).items.map((d) => d.id).sort()

describe('the workspace document search on the full-text index', () => {
  it('the list search requires every word, the words can sit anywhere in the title or the content', async () => {
    const both = await doc({ title: 'Alpha plan', content: 'the beta part of it' })
    await doc({ title: 'Alpha only', content: 'nothing else' })
    expect(await ids('alpha beta')).toEqual([both.id].sort())
  })

  it('the phrase search takes the whole text as one phrase', async () => {
    const d = await doc({ title: 'Phrase doc', content: 'consecutive words here' })
    expect((await searchWorkspaceDocs('consecutive words', { tenantId: 'default', limit: 10 })).map((x) => x.id)).toEqual([d.id])
    expect(await searchWorkspaceDocs('words consecutive', { tenantId: 'default', limit: 10 })).toEqual([])
  })

  it('the tenant is in the SQL: another tenant document is never returned, the admin view sees all', async () => {
    const mine = await doc({ title: 'Tenant scope', tenant: 'default' })
    const theirs = await doc({ title: 'Tenant scope', tenant: 'tenant-b' })
    expect(await ids('tenant scope', { tenantId: 'default' })).toEqual([mine.id].sort())
    expect(await ids('tenant scope', { tenantId: null })).toEqual([mine.id, theirs.id].sort())
  })

  it('a binary document is found by its title only (its content is not indexed)', async () => {
    const b = await doc({ title: 'Diagram image', binary: true })
    // a binary row that carries text in its content column: the index must still not take it (the SQLite trigger blanks it)
    await dbx.run("UPDATE workspace_docs SET content = 'secretbinaryword' WHERE id = ?", b.id)
    await doc({ title: 'Other', content: 'secretbinaryword' })
    expect(await ids('diagram')).toEqual([b.id])
    expect(await ids('secretbinaryword')).not.toContain(b.id)
  })

  it('a word with a separator is one phrase, and the phrase does not run from the title into the content (both engines)', async () => {
    // the title ends with "rank", the content starts with "check": "rank-check" is a phrase of two words, in no column
    await doc({ title: 'Doc rank', content: 'check values here' })
    expect(await ids('rank-check')).toEqual([])
    expect(await searchWorkspaceDocs('rank check', { tenantId: 'default', limit: 10 })).toEqual([])
  })

  it('the snippet marks the hit words and is NULL-tolerant (an empty content still gives the title snippet)', async () => {
    const d = await doc({ title: 'Snippet title', content: 'some text with the marker word inside' })
    const page = await searchWorkspaceDocsPage('marker', { tenantId: 'default', limit: 10 })
    expect(page.items.map((x) => x.id)).toEqual([d.id])
    expect(page.items[0]?.snippet).toContain('[marker]')
    const t = await doc({ title: 'Titleonly marker', content: '' })
    const hit = (await searchWorkspaceDocsPage('titleonly', { tenantId: 'default', limit: 10 })).items.find((x) => x.id === t.id)
    expect(hit?.snippet).toContain('[Titleonly]')
  })

  it('paging: three pages of two cover five documents once each, in the order of the full list (both engines)', async () => {
    // identical texts, so every rank ties and the order is decided by updated_at (distinct): the expected order is known
    const docs = []
    for (let i = 0; i < 5; i++) docs.push(await doc({ title: `Paging doc ${i}`, content: 'pagingword same text here' }))
    for (let i = 0; i < 5; i++) await dbx.run('UPDATE workspace_docs SET updated_at = ? WHERE id = ?', 1_800_000_000 + i * 10, docs[i]!.id)
    const expected = docs.map((d) => d.id).reverse() // newest first
    const full = (await searchWorkspaceDocsPage('pagingword', { tenantId: 'default', limit: 50 })).items.map((d) => d.id)
    const page = async (offset: number) =>
      (await searchWorkspaceDocsPage('pagingword', { tenantId: 'default', limit: 2, offset })).items.map((d) => d.id)
    const pages = [...(await page(0)), ...(await page(2)), ...(await page(4))]
    expect(full).toEqual(expected)
    expect(new Set(pages).size).toBe(5)
    expect(pages).toEqual(expected)
  })

  // WEAK source pin, named as such: the page query text carries the outer ORDER BY. It names the text; it does not prove the
  // order of a run (the join keeps the order on a small table either way, so no run can show the difference here).
  it('weak source pin: the page query text keeps its outer ORDER BY p.rank', () => {
    const src = readFileSync(fileURLToPath(new URL('../db/workspace.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/ORDER BY p\.rank, wd\.updated_at DESC/)
  })

  it('the count is the number of matches of the same filter', async () => {
    await doc({ title: 'Count a', content: 'countword' })
    await doc({ title: 'Count b', content: 'countword' })
    const page = await searchWorkspaceDocsPage('countword', { tenantId: 'default', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(2)
  })
})

describe('the body cap (PostgreSQL) and the engine difference', () => {
  const longText = `lead ${'filler '.repeat(50000)} tailword`

  // Two named PostgreSQL ceilings: the 300000-character cap of the normalized text, and the tsvector position ceiling (a phrase
  // past the 16383rd word). The cell below for the position ceiling is separate; this one is the character cap.
  it.runIf(testDbMode() === 'pg')('a word after the first 300000 characters is not found on PostgreSQL (the character cap; the second ceiling, the 16383rd word, is in its own cell)', async () => {
    const d = await doc({ title: 'Long body', content: longText })
    expect(await ids('lead')).toEqual([d.id])
    expect(await ids('tailword')).toEqual([])
  })

  it.runIf(testDbMode() === 'sqlite')('the same word after the cap is found by FTS5', async () => {
    const d = await doc({ title: 'Long body', content: longText })
    expect(await ids('tailword')).toEqual([d.id])
  })
})

// Cells adopted from the QA probe note (scope, phrase scope, count filters, empty query, offset pages, rank order, binary
// snippet), and the paging tiebreak: documents with the same rank and the same update time keep one order across pages.
describe('QA-adopted cells: scope, count filters, empty query, offset pages, rank order, binary snippet', () => {
  const pageIdsOf = async (q: string, f: Record<string, unknown> = {}) =>
    (await searchWorkspaceDocsPage(q, { tenantId: 'default', limit: 100, ...f } as never)).items.map((d) => d.id).sort()

  it('PA1 agent filter, tenant filter, count, snippet never carry another scope', async () => {
    const a = await doc({ title: 'Scope probe', content: 'leakword inside agent a', agent: 'agent-a' })
    const b = await doc({ title: 'Scope probe', content: 'leakword inside agent b', agent: 'agent-b' })
    const t = await doc({ title: 'Scope probe', content: 'leakword inside tenant b', tenant: 'tenant-b', agent: 'agent-a' })
    expect(await pageIdsOf('leakword', { agentId: 'agent-a' })).toEqual([a.id])
    expect(await pageIdsOf('leakword', { agentId: 'agent-b' })).toEqual([b.id])
    const pg = await searchWorkspaceDocsPage('leakword', { tenantId: 'default', agentId: 'agent-a', limit: 10 })
    expect(pg.total).toBe(1)
    expect(JSON.stringify(pg)).not.toContain('tenant b')
    expect(JSON.stringify(pg)).not.toContain('agent b')
    const tb = await searchWorkspaceDocsPage('leakword', { tenantId: 'tenant-b', limit: 10 })
    expect(tb.items.map((x) => x.id)).toEqual([t.id])
    expect(tb.total).toBe(1)
    expect((await searchWorkspaceDocsPage('leakword', { tenantId: 'nobody', limit: 10 })).total).toBe(0)
  })

  it('PA2 phrase search honors tenant and agent', async () => {
    const a = await doc({ title: 'Phrase scope', content: 'secret phrase here', tenant: 'default', agent: 'agent-a' })
    await doc({ title: 'Phrase scope', content: 'secret phrase here', tenant: 'tenant-b', agent: 'agent-a' })
    await doc({ title: 'Phrase scope', content: 'secret phrase here', tenant: 'default', agent: 'agent-b' })
    const r = await searchWorkspaceDocs('secret phrase', { tenantId: 'default', agentId: 'agent-a', limit: 10 })
    expect(r.map((x) => x.id)).toEqual([a.id])
    const r2 = await searchWorkspaceDocs('secret phrase', { tenantId: 'tenant-b', limit: 10 })
    expect(r2).toHaveLength(1)
    expect(r2[0]!.tenant_id).toBe('tenant-b')
  })

  it('PH1 count counts matches only, per scope, with content_type / agent / doc_key filters', async () => {
    const m = await doc({ title: 'Match', content: 'countme', key: 'k/1' })
    await doc({ title: 'Nomatch', content: 'other words', key: 'k/2' })
    await doc({ title: 'Match b', content: 'countme', tenant: 'tenant-b', key: 'k/3' })
    await doc({ title: 'Match c', content: 'countme', agent: 'agent-b', key: 'k/4' })
    const all = await searchWorkspaceDocsPage('countme', { tenantId: 'default', limit: 10 })
    expect(all.total).toBe(2)
    expect((await searchWorkspaceDocsPage('countme', { tenantId: 'default', agentId: 'agent-a', limit: 10 })).total).toBe(1)
    expect((await searchWorkspaceDocsPage('countme', { tenantId: 'default', docKey: 'k/1', limit: 10 })).items.map((x) => x.id)).toEqual([m.id])
    expect((await searchWorkspaceDocsPage('countme', { tenantId: 'default', contentType: 'binary', limit: 10 })).total).toBe(0)
    expect((await searchWorkspaceDocsPage('countme', { tenantId: 'default', contentType: 'text' } as never)).total).toBe(2)
    expect((await searchWorkspaceDocsPage('countme', { tenantId: null } as never)).total).toBe(3)
  })

  it('PG1 empty and blank query', async () => {
    await doc({ title: 'x', content: 'y' })
    expect(await searchWorkspaceDocsPage('   ', { tenantId: 'default', limit: 10 })).toEqual({ items: [], total: 0 })
    expect(await searchWorkspaceDocsPage('!!! ???', { tenantId: 'default', limit: 10 })).toEqual({ items: [], total: 0 })
  })

  it('PG2 offset pages', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await doc({ title: `Off ${i}`, content: 'offword' })).id)
    for (let i = 0; i < 3; i++) await dbx.run('UPDATE workspace_docs SET updated_at = ? WHERE id = ?', 1000 + i, ids[i])
    const p0 = await searchWorkspaceDocsPage('offword', { tenantId: 'default', limit: 1, offset: 0 })
    const p1 = await searchWorkspaceDocsPage('offword', { tenantId: 'default', limit: 1, offset: 1 })
    const p2 = await searchWorkspaceDocsPage('offword', { tenantId: 'default', limit: 1, offset: 2 })
    expect([p0.items[0]!.id, p1.items[0]!.id, p2.items[0]!.id]).toEqual([ids[2], ids[1], ids[0]])
    expect(p0.total).toBe(3)
  })

  it('PG3 best match first', async () => {
    const one = await doc({ title: 'One', content: 'rankword once' })
    const many = await doc({ title: 'Many', content: 'rankword rankword rankword rankword' })
    await dbx.run('UPDATE workspace_docs SET updated_at = 5000 WHERE id = ?', one.id)
    await dbx.run('UPDATE workspace_docs SET updated_at = 1000 WHERE id = ?', many.id)
    const p = await searchWorkspaceDocsPage('rankword', { tenantId: 'default', limit: 10 })
    expect(p.items.map((x) => x.id)).toEqual([many.id, one.id])
  })

  it('PG4 binary row with matching text in content: snippet stays on the title', async () => {
    const b = await doc({ title: 'Diagram bin', binary: true })
    await dbx.run("UPDATE workspace_docs SET content = 'secrettext diagram here' WHERE id = ?", b.id)
    const p = await searchWorkspaceDocsPage('diagram', { tenantId: 'default', limit: 10 })
    expect(p.items.map((x) => x.id)).toEqual([b.id])
    expect(p.items[0]!.snippet).not.toContain('secrettext')
  })

  // The paging tiebreak (W1): 30 documents with the same text and the same update time all have the same rank and the same
  // time; paged seven at a time, every document appears once, and the pages join into the full list.
  it('paging ties: 30 rows with the same rank and update time, pages of 7, each row once, pages join to the full list', async () => {
    const all: string[] = []
    for (let i = 0; i < 30; i++) all.push((await doc({ title: `Tie ${i}`, content: 'tieword same text' })).id)
    await dbx.run('UPDATE workspace_docs SET updated_at = 2000 WHERE content = ?', 'tieword same text')
    const full = (await searchWorkspaceDocsPage('tieword', { tenantId: 'default', limit: 100 })).items.map((d) => d.id)
    const joined: string[] = []
    for (let off = 0; off < 30; off += 7) {
      joined.push(...(await searchWorkspaceDocsPage('tieword', { tenantId: 'default', limit: 7, offset: off })).items.map((d) => d.id))
    }
    expect(new Set(joined).size).toBe(30)
    expect(joined).toHaveLength(30)
    expect(joined).toEqual(full)
    expect([...full].sort()).toEqual([...all].sort())
  })

  // the tsvector keeps positions up to the 16383rd word; the phrase is checked on the normalized text of the candidates,
  // so a phrase past that word is found on both engines (the position ceiling is no longer a divergence)
  it('a phrase past the 16383rd word is found (both engines): the candidates come from the index as ANDed words, the phrase is verified on the text', async () => {
    const d = await doc({ title: 'Position doc', content: `${'filler '.repeat(16400)} ceilingone ceilingtwo` })
    expect((await searchWorkspaceDocs('ceilingone ceilingtwo', { tenantId: 'default', limit: 10 })).map((x) => x.id)).toEqual([d.id])
  })

  it('the words of a phrase that are not adjacent are not a phrase hit (both engines): the verification is the phrase test', async () => {
    await doc({ title: 'Gap doc', content: 'gapalpha between gapbeta' })
    expect(await searchWorkspaceDocs('gapalpha gapbeta', { tenantId: 'default', limit: 10 })).toEqual([])
  })

  // 6a W2: the candidate is the position-free tsquery of the whole text, so a separator word past the 16383rd word is found by
  // the list search too (the per-word phrase needed the position of the separator); the phrase check then takes the text
  it('a separator word past the 16383rd word is found by both searches: the candidate is position-free', async () => {
    const d = await doc({ title: 'Separator doc', content: `${'filler '.repeat(16400)} serper.dev` })
    expect((await searchWorkspaceDocs('serper.dev', { tenantId: 'default', limit: 10 })).map((x) => x.id)).toEqual([d.id])
    expect(await ids('serper.dev')).toEqual([d.id])
  })

  // the phrase check runs on the title too: a two-word phrase in the title is a phrase hit, the content not containing it
  it('a phrase in the title is a phrase hit, the content need not contain it (title is checked on its own)', async () => {
    const d = await doc({ title: 'alpha beta', content: 'nothing relevant here' })
    expect((await searchWorkspaceDocs('alpha beta', { tenantId: 'default', limit: 10 })).map((x) => x.id)).toEqual([d.id])
  })
})

/**
 * Content search on the Workspace Docs list: GET /api/workspace?q=... over the real in-memory database
 * (FTS5 index of migration 0040). The property that matters most: a tenant's search never returns another
 * tenant's document.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getDb } from '../db.js'
import { saveWorkspaceDoc, searchWorkspaceDocsPage } from '../db/workspace.js'
import { tryHandleWorkspace } from '../web/routes/workspace.js'
import type { RouteContext } from '../web/routes/types.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().prepare('DELETE FROM workspace_docs').run()
})

async function seed(over: Partial<Parameters<typeof saveWorkspaceDoc>[0]> = {}) {
  return saveWorkspaceDoc({
    agent_id: 'agent-a', tenant_id: 'tenant-a', doc_key: null,
    title: 'Plan', content: 'nothing special', content_type: 'text', type: 'plan', task_ref: null,
    ...over,
  })
}

function get(rawPath: string, opts: { role?: string; tenantId?: string | null } = {}): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as any
  req.method = 'GET'
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: any) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${rawPath}`)
  const ctx = {
    req, res, path: url.pathname, method: 'GET', url,
    role: (opts.role ?? 'admin') as any, tenantId: opts.tenantId ?? null, auth: { kind: 'session' as any },
  } as RouteContext
  return tryHandleWorkspace(ctx).then(() => out)
}

describe('searchWorkspaceDocsPage', () => {
  it('finds a word in the body and in the title, with the hit word marked in the snippet and no body in the row', async () => {
    await seed({ title: 'Roadmap', content: 'the quarterly zebracrossing review is due' })
    await seed({ title: 'zebracrossing notes', content: 'unrelated body' })
    const { items, total } = await searchWorkspaceDocsPage('zebracrossing', {})
    expect(total).toBe(2)
    expect(items).toHaveLength(2)
    for (const i of items) expect(i.content).toBeNull()
    // Each hit shows the column it matched in: the body excerpt for a body hit, the title for a title-only hit.
    const byTitle = new Map(items.map(i => [i.title, i.snippet]))
    expect(byTitle.get('Roadmap')).toContain('[zebracrossing]')
    expect(byTitle.get('Roadmap')).toContain('review is due')
    expect(byTitle.get('zebracrossing notes')).toBe('[zebracrossing] notes')
  })

  it('a title-only hit never shows an unrelated body excerpt', async () => {
    await seed({ title: 'quokka overview', content: 'a long body about something else entirely, with no hit word in it' })
    const [hit] = (await searchWorkspaceDocsPage('quokka', {})).items
    expect(hit.snippet).toBe('[quokka] overview')
    expect(hit.snippet).not.toContain('something else')
  })

  it('a binary document is found by its title, with the title as the snippet', async () => {
    await seed({ title: 'quokka picture', content: null, content_type: 'binary', content_blob: Buffer.from('zzz') } as any)
    const { items, total } = await searchWorkspaceDocsPage('quokka', {})
    expect(total).toBe(1)
    expect(items[0].snippet).toBe('[quokka] picture')
  })

  it('requires every word, in any order and place', async () => {
    await seed({ title: 'A', content: 'alpha and later beta' })
    await seed({ title: 'B', content: 'only alpha here' })
    expect((await searchWorkspaceDocsPage('beta alpha', {})).items.map(i => i.title)).toEqual(['A'])
  })

  it('treats FTS operators and quotes in the box as plain text, never as a query error', async () => {
    await seed({ content: 'plain text' })
    for (const q of ['"', 'alpha OR', 'NEAR(', 'a" b', '*', '(unclosed', 'title:x', '-minus']) {
      await expect(searchWorkspaceDocsPage(q, {})).resolves.toMatchObject({ items: expect.any(Array), total: expect.any(Number) })
    }
  })

  it('returns nothing for an empty or blank query', async () => {
    await seed()
    expect(await searchWorkspaceDocsPage('   ', {})).toEqual({ items: [], total: 0 })
  })

  it('applies the list filters together with the search', async () => {
    await seed({ agent_id: 'agent-a', type: 'plan', title: 'one', content: 'shared marker' })
    await seed({ agent_id: 'agent-b', type: 'report', title: 'two', content: 'shared marker' })
    await seed({ agent_id: 'agent-b', type: 'plan', title: 'three', content: 'shared marker', doc_key: 'proj/three', task_ref: 'T1' })
    expect((await searchWorkspaceDocsPage('marker', {})).total).toBe(3)
    expect((await searchWorkspaceDocsPage('marker', { agentId: 'agent-b' })).items.map(i => i.title).sort()).toEqual(['three', 'two'])
    expect((await searchWorkspaceDocsPage('marker', { type: 'report' })).items.map(i => i.title)).toEqual(['two'])
    expect((await searchWorkspaceDocsPage('marker', { docKeyPrefix: 'proj/' })).items.map(i => i.title)).toEqual(['three'])
    expect((await searchWorkspaceDocsPage('marker', { taskRef: 'T1' })).items.map(i => i.title)).toEqual(['three'])
    expect((await searchWorkspaceDocsPage('marker', { agentId: 'agent-a', type: 'report' })).total).toBe(0)
  })

  it('pages the hits and keeps the total of all of them', async () => {
    for (let i = 0; i < 5; i++) await seed({ title: `doc ${i}`, content: 'pagedword' })
    const first = await searchWorkspaceDocsPage('pagedword', { limit: 2, offset: 0 })
    const second = await searchWorkspaceDocsPage('pagedword', { limit: 2, offset: 2 })
    const third = await searchWorkspaceDocsPage('pagedword', { limit: 2, offset: 4 })
    expect(first.total).toBe(5)
    expect([first.items.length, second.items.length, third.items.length]).toEqual([2, 2, 1])
    const ids = [...first.items, ...second.items, ...third.items].map(i => i.id)
    expect(new Set(ids).size).toBe(5)
  })

  it('never returns another tenant\'s document for a tenant-scoped search (critical)', async () => {
    await seed({ tenant_id: 'tenant-a', title: 'a doc', content: 'unicornfish' })
    await seed({ tenant_id: 'tenant-b', title: 'b doc', content: 'unicornfish' })
    const a = await searchWorkspaceDocsPage('unicornfish', { tenantId: 'tenant-a' })
    expect(a.items.map(i => i.tenant_id)).toEqual(['tenant-a'])
    expect(a.total).toBe(1)
    expect((await searchWorkspaceDocsPage('unicornfish', {})).total).toBe(2)
  })

  it('finds no hit in a binary document (no text)', async () => {
    await seed({ title: 'picture', content: null, content_type: 'binary', content_blob: Buffer.from('zzz') } as any)
    expect((await searchWorkspaceDocsPage('zzz', {})).total).toBe(0)
  })
})

describe('GET /api/workspace?q=', () => {
  it('searches for admin across tenants, narrowed by ?tenant=', async () => {
    await seed({ tenant_id: 'tenant-a', title: 'a', content: 'routeword' })
    await seed({ tenant_id: 'tenant-b', title: 'b', content: 'routeword' })
    const all = await get('/api/workspace?q=routeword&limit=20')
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(2)
    expect(all.body.items[0]).toHaveProperty('snippet')
    const one = await get('/api/workspace?q=routeword&tenant=tenant-b&limit=20')
    expect(one.body.items.map((i: any) => i.title)).toEqual(['b'])
  })

  it('a non-admin only ever searches its own tenant, whatever ?tenant= says', async () => {
    await seed({ tenant_id: 'tenant-a', title: 'mine', content: 'secretword' })
    await seed({ tenant_id: 'tenant-b', title: 'theirs', content: 'secretword' })
    const own = await get('/api/workspace?q=secretword&limit=20', { role: 'viewer', tenantId: 'tenant-a' })
    expect(own.body.items.map((i: any) => i.title)).toEqual(['mine'])
    expect(own.body.total).toBe(1)
    const spoof = await get('/api/workspace?q=secretword&tenant=tenant-b&limit=20', { role: 'viewer', tenantId: 'tenant-a' })
    expect(spoof.body.items.map((i: any) => i.title)).toEqual(['mine'])
    const none = await get('/api/workspace?q=secretword&limit=20', { role: 'viewer', tenantId: 'tenant-c' })
    expect(none.body).toMatchObject({ items: [], total: 0 })
  })

  it('combines q with the filters and pages with limit/offset', async () => {
    for (let i = 0; i < 3; i++) await seed({ agent_id: 'agent-a', title: `x${i}`, content: 'combo' })
    await seed({ agent_id: 'agent-b', title: 'y', content: 'combo' })
    const r = await get('/api/workspace?q=combo&agent=agent-a&limit=2&offset=2')
    expect(r.body.total).toBe(3)
    expect(r.body.items).toHaveLength(1)
    expect(r.body).toMatchObject({ offset: 2, limit: 2 })
  })

  it('without q the list is unchanged (full documents)', async () => {
    await seed({ title: 'listed', content: 'body text' })
    const r = await get('/api/workspace?limit=20')
    expect(r.body.items[0].content).toBe('body text')
    expect(r.body.items[0]).not.toHaveProperty('snippet')
  })

  it('a blank q is a plain list', async () => {
    await seed({ title: 'listed' })
    const r = await get('/api/workspace?q=%20%20&limit=20')
    expect(r.body.total).toBe(1)
  })

  it('answers 400 for a query over 200 characters', async () => {
    const r = await get(`/api/workspace?q=${'a'.repeat(201)}`)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_value', field: 'q' })
  })
})

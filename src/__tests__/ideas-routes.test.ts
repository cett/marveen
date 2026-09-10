// Route-level tests for the idea-box pipeline (src/web/routes/ideas.ts):
// CRUD + comments + stale flagging + kanban promotion (direct and via
// AI breakdown) + manual revert + status-log. Uses the REAL db.ts (in-memory
// SQLite) so the route layer and the storage layer are exercised together;
// only the LLM breakdown call is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const mockGenerateBreakdown = vi.fn()
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: (...args: unknown[]) => mockGenerateBreakdown(...args) }))

beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
})

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext,
    out,
  }
}

import { tryHandleIdeas } from '../web/routes/ideas.js'

async function createIdeaViaRoute(overrides: Record<string, unknown> = {}): Promise<string> {
  const { ctx, out } = makeCtx('POST', '/api/ideas', { title: 'Test idea', ...overrides })
  await tryHandleIdeas(ctx)
  return (out.body as any).id
}

describe('GET /api/ideas', () => {
  it('lists ideas and flags a stale "new" idea past IDEA_STALE_DAYS', async () => {
    const freshId = await createIdeaViaRoute({ title: 'Fresh idea' })
    // Backdate a second idea directly (createIdea always stamps "now") to exercise the stale branch.
    const staleId = 'stale01'
    const longAgo = Math.floor(Date.now() / 1000) - 30 * 86400
    getDb().prepare(
      `INSERT INTO idea_box (id, title, description, category, status, source, kanban_id, impact, effort, created_at, updated_at)
       VALUES (?, 'Old idea', NULL, 'Egyéb', 'new', 'manual', NULL, NULL, NULL, ?, ?)`
    ).run(staleId, longAgo, longAgo)

    const { ctx, out } = makeCtx('GET', '/api/ideas')
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    const rows = out.body as any[]
    expect(rows.find(r => r.id === freshId).stale).toBe(false)
    expect(rows.find(r => r.id === staleId).stale).toBe(true)
  })

  it('filters by status and category query params', async () => {
    await createIdeaViaRoute({ title: 'A', category: 'Optimalizalas' })
    const { ctx, out } = makeCtx('GET', '/api/ideas?status=new&category=Optimalizalas')
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any[]).every(r => r.status === 'new' && r.category === 'Optimalizalas')).toBe(true)
  })
})

describe('GET /api/ideas/categories', () => {
  it('returns distinct categories', async () => {
    await createIdeaViaRoute({ title: 'A', category: 'Fejlesztes' })
    const { ctx, out } = makeCtx('GET', '/api/ideas/categories')
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toContain('Fejlesztes')
  })
})

describe('POST /api/ideas', () => {
  it('rejects a missing title', async () => {
    const { ctx, out } = makeCtx('POST', '/api/ideas', {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).field).toBe('title')
  })

  it.each([
    ['impact', { title: 'x', impact: 0 }],
    ['impact', { title: 'x', impact: 6 }],
    ['effort', { title: 'x', effort: 0 }],
    ['effort', { title: 'x', effort: 6 }],
  ])('rejects an out-of-range %s value', async (field, body) => {
    const { ctx, out } = makeCtx('POST', '/api/ideas', body)
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).field).toBe(field)
  })

  it('creates an idea with defaults applied and returns its id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/ideas', { title: 'New idea', impact: 4, effort: 2 })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    const row = getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get((out.body as any).id) as any
    expect(row.category).toBe('Egyéb')
    expect(row.source).toBe('manual')
    expect(row.status).toBe('new')
    expect(row.impact).toBe(4)
  })
})

describe('PUT /api/ideas/:id', () => {
  it('404s on an unknown id', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/ideas/missing', { title: 'x' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects an out-of-range impact', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('PUT', `/api/ideas/${id}`, { impact: 9 })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(400)
    expect((out.body as any).field).toBe('impact')
  })

  it('updates fields and logs a status change when status actually changes', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('PUT', `/api/ideas/${id}`, { status: 'reviewed' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    const log = getDb().prepare('SELECT * FROM idea_status_log WHERE idea_id = ?').all(id) as any[]
    expect(log).toHaveLength(1)
    expect(log[0].from_status).toBe('new')
    expect(log[0].to_status).toBe('reviewed')
  })

  it('does not log a status change when status is omitted', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('PUT', `/api/ideas/${id}`, { title: 'Renamed' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    const log = getDb().prepare('SELECT * FROM idea_status_log WHERE idea_id = ?').all(id) as any[]
    expect(log).toHaveLength(0)
  })
})

describe('DELETE /api/ideas/:id', () => {
  it('404s on an unknown id', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/ideas/missing')
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('deletes an existing idea', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('DELETE', `/api/ideas/${id}`)
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect(getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id)).toBeUndefined()
  })
})

describe('idea comments', () => {
  it('lists comments (empty when none)', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('GET', `/api/ideas/${id}/comments`)
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).comments).toEqual([])
  })

  it('rejects an empty comment', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/comments`, { content: '   ' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(400)
  })

  it('adds a comment, defaulting the author when omitted', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/comments`, { content: 'looks good' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).comment.content).toBe('looks good')
    expect((out.body as any).comment.author).toBeTruthy()
  })
})

describe('POST /api/ideas/:id/promote', () => {
  it('404s on an unknown id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/ideas/missing/promote', {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('phase=detail creates a "waiting" card with a detail-prefixed title', async () => {
    const id = await createIdeaViaRoute({ title: 'Ship the widget' })
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/promote`, { phase: 'detail' })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    const cardId = (out.body as any).kanban_id
    const card = getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(cardId) as any
    expect(card.status).toBe('waiting')
    expect(card.title).toContain('Ship the widget')
    const idea = getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as any
    expect(idea.status).toBe('kanban')
    expect(idea.kanban_id).toBe(cardId)
  })

  it('phase=plan creates a "planned" card with the plain title', async () => {
    const id = await createIdeaViaRoute({ title: 'Ship the widget' })
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/promote`, { phase: 'plan' })
    await tryHandleIdeas(ctx)
    const card = getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get((out.body as any).kanban_id) as any
    expect(card.status).toBe('planned')
    expect(card.title).toBe('Ship the widget')
  })
})

describe('POST /api/ideas/:id/breakdown', () => {
  it('404s on an unknown id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/ideas/missing/breakdown', {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('returns the generated subtasks', async () => {
    const id = await createIdeaViaRoute()
    mockGenerateBreakdown.mockResolvedValue({ subtasks: [{ title: 'Step 1' }, { title: 'Step 2' }] })
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/breakdown`, {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).subtasks).toHaveLength(2)
  })

  it('500s when generation fails', async () => {
    const id = await createIdeaViaRoute()
    mockGenerateBreakdown.mockRejectedValue(new Error('llm down'))
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/breakdown`, {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(500)
  })
})

describe('POST /api/ideas/:id/promote-breakdown', () => {
  it('404s on an unknown id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/ideas/missing/promote-breakdown', { subtasks: [] })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects an empty subtasks array', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/promote-breakdown`, { subtasks: [] })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(400)
  })

  it('creates a parent card and one child per titled subtask, skipping untitled ones', async () => {
    const id = await createIdeaViaRoute({ title: 'Big feature' })
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/promote-breakdown`, {
      subtasks: [{ title: 'Sub A', assignee: 'agent-b' }, { title: '' }, { title: 'Sub B', priority: 'high' }],
      success_criteria: 'It works end to end',
    })
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).child_count).toBe(2)
    const parent = getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get((out.body as any).parent_id) as any
    expect(parent.description).toContain('It works end to end')
    const children = getDb().prepare('SELECT * FROM kanban_cards WHERE parent_id = ?').all((out.body as any).parent_id) as any[]
    expect(children).toHaveLength(2)
    const idea = getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as any
    expect(idea.status).toBe('kanban')
  })
})

describe('POST /api/ideas/:id/revert', () => {
  it('404s on an unknown id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/ideas/missing/revert', {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects reverting an idea that is not in kanban status', async () => {
    const id = await createIdeaViaRoute()
    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/revert`, {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(400)
  })

  it('reverts a promoted idea back to reviewed and clears kanban_id', async () => {
    const id = await createIdeaViaRoute()
    const { ctx: promoteCtx } = makeCtx('POST', `/api/ideas/${id}/promote`, { phase: 'plan' })
    await tryHandleIdeas(promoteCtx)

    const { ctx, out } = makeCtx('POST', `/api/ideas/${id}/revert`, {})
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    const idea = getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as any
    expect(idea.status).toBe('reviewed')
    expect(idea.kanban_id).toBeNull()
  })
})

describe('GET /api/ideas/:id/status-log', () => {
  it('returns the accumulated status log', async () => {
    const id = await createIdeaViaRoute()
    const { ctx: putCtx } = makeCtx('PUT', `/api/ideas/${id}`, { status: 'reviewed' })
    await tryHandleIdeas(putCtx)

    const { ctx, out } = makeCtx('GET', `/api/ideas/${id}/status-log`)
    await tryHandleIdeas(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).log).toHaveLength(1)
  })
})
